// One user message in, a stream of events out.
//
//   recall (deterministic, ~ms)  ->  model  <->  web_search (parallel)  ->  stream
//                                                     \-> persist turn -> extract claims + profile (background)
//
// The model decides whether and what to search; everything around it
// (time, memory, citations, persistence) is plain code.

import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import type { Source, Store, Turn } from '../db.js';
import { recall } from '../memory/recall.js';
import { extractMemory, formatProfile } from '../memory/extract.js';
import { runSearch, SourceRegistry, type SearchArgs, type SearchProvider } from '../search.js';
import { SYSTEM_PROMPT, contextPrompt, stamp } from './prompt.js';

export type AgentEvent =
  | { type: 'thread'; threadId: string; title: string }
  | { type: 'memory'; recalled: { at: number; question: string }[]; dates: string[]; profile: number }
  | { type: 'search'; queries: string[]; recency?: string; domains?: string[] }
  | { type: 'sources'; sources: Source[] }
  | { type: 'text'; delta: string }
  | { type: 'done'; turnId: number; ms: number; answer: string; sources: Source[] }
  | { type: 'error'; message: string };

export interface AgentDeps {
  store: Store;
  llm: Pick<Anthropic, 'messages'>;
  search: SearchProvider;
}

export interface AgentInput {
  userId: string;
  threadId?: string;
  message: string;
  nowMs: number;
  tz: string;
  signal?: AbortSignal;
  /** Extract facts in the background after the reply (default true). */
  extractFacts?: boolean;
}

const WEB_SEARCH_TOOL: Anthropic.Tool = {
  name: 'web_search',
  description:
    'Search the web. Runs up to 4 queries in parallel and returns numbered results ([n]) with URL, publish date and text. Cite results by their number.',
  input_schema: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 4,
        description: 'Distinct, specific queries, e.g. one per product. 2-8 words each works best.',
      },
      recency: {
        type: 'string',
        enum: ['day', 'week', 'month', 'year'],
        description: 'Only results published or updated within this window.',
      },
      topic: { type: 'string', enum: ['general', 'news'], description: 'Use news for recent events.' },
      domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict to these sites, e.g. ["hubspot.com"] for official pricing or changelog pages.',
      },
      full_pages: {
        type: 'boolean',
        description: 'Return page text instead of snippets. Use for exact figures such as pricing tables. Slower.',
      },
    },
    required: ['queries'],
  },
};

export async function* runAgent(deps: AgentDeps, input: AgentInput): AsyncGenerator<AgentEvent> {
  const started = Date.now();
  const { store } = deps;
  const { nowMs, tz } = input;

  const thread = store.ensureThread(input.userId, input.threadId, input.message, nowMs);
  yield { type: 'thread', threadId: thread.id, title: thread.title };

  // 1. Context: this thread's recent turns verbatim, plus recalled memory.
  const history = store.threadTurns(input.userId, thread.id, config.historyTurns);
  const memory = recall(store, {
    userId: input.userId,
    message: input.message,
    nowMs,
    tz,
    inContextTurnIds: new Set(history.map((t) => t.id)),
  });
  const profile = store.getProfile(input.userId);
  if (memory.turns.length > 0 || memory.ranges.length > 0 || profile.length > 0) {
    yield {
      type: 'memory',
      recalled: memory.turns.map((t) => ({ at: t.createdAt, question: t.userText.slice(0, 120) })),
      dates: memory.ranges.map((r) => r.label),
      profile: profile.length,
    };
  }

  const messages: Anthropic.MessageParam[] = [
    ...history.flatMap((t): Anthropic.MessageParam[] => [
      { role: 'user', content: `${stamp(t.createdAt, tz)} ${t.userText}` },
      { role: 'assistant', content: t.assistantText || '(no answer)' },
    ]),
    { role: 'user', content: `${stamp(nowMs, tz)} ${input.message}` },
  ];
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: contextPrompt(nowMs, tz, formatProfile(profile), memory.block) },
  ];

  // 2. Model <-> search loop.
  const registry = new SourceRegistry();
  const queriesRun: string[] = [];
  let answer = '';

  try {
    for (let round = 0; round < config.maxSearchRounds; round++) {
      const lastRound = round === config.maxSearchRounds - 1;
      const stream = deps.llm.messages.stream(
        {
          model: config.model,
          max_tokens: 4096,
          system,
          tools: [WEB_SEARCH_TOOL],
          ...(lastRound ? { tool_choice: { type: 'none' as const } } : {}),
          messages,
        },
        { signal: input.signal },
      );

      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          answer += ev.delta.text;
          yield { type: 'text', delta: ev.delta.text };
        }
      }
      const msg = await stream.finalMessage();
      const toolUses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (msg.stop_reason !== 'tool_use' || toolUses.length === 0) break;

      // Separate any text from the next round's text.
      if (answer && !answer.endsWith('\n')) {
        answer += '\n\n';
        yield { type: 'text', delta: '\n\n' };
      }

      for (const tu of toolUses) {
        const a = tu.input as SearchArgs;
        yield { type: 'search', queries: a.queries ?? [], recency: a.recency, domains: a.domains };
      }
      // All tool calls from this round in parallel (each is itself parallel).
      const results = await Promise.all(
        toolUses.map(async (tu) => {
          const args = tu.input as SearchArgs;
          if (!Array.isArray(args.queries) || args.queries.length === 0) {
            return { id: tu.id, text: 'Error: provide at least one query.', isError: true };
          }
          queriesRun.push(...args.queries);
          const r = await runSearch(deps.search, args, registry, Date.now());
          return { id: tu.id, text: r.text, isError: false };
        }),
      );
      yield { type: 'sources', sources: registry.all() };

      messages.push({ role: 'assistant', content: msg.content });
      messages.push({
        role: 'user',
        content: results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.id,
          content: r.text,
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    }
  } catch (err) {
    if (input.signal?.aborted) return;
    yield { type: 'error', message: friendlyError(err) };
    return;
  }

  // 3. Persist. Only sources the answer actually cites are kept on the turn.
  const cited = citedSources(answer, registry.all());
  const turn: Omit<Turn, 'id'> = {
    userId: input.userId,
    threadId: thread.id,
    createdAt: nowMs,
    tz,
    userText: input.message,
    assistantText: answer.trim(),
    sources: cited,
    queries: queriesRun,
  };
  const turnId = store.addTurn(turn);
  yield { type: 'done', turnId, ms: Date.now() - started, answer: turn.assistantText, sources: cited };

  // 4. Background: remember checkable facts and anything learned about the user.
  if (input.extractFacts !== false) {
    extractMemory(deps.llm, store, { ...turn, id: turnId }).catch((e) =>
      console.warn('[memory] extraction skipped:', e instanceof Error ? e.message : e),
    );
  }
}

export function citedSources(text: string, sources: Source[]): Source[] {
  const nums = new Set([...text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1]!.split(/\s*,\s*/).map(Number)));
  return sources.filter((s) => nums.has(s.n));
}

function friendlyError(err: unknown): string {
  const status = (err as { status?: number })?.status;
  if (status === 401) return 'The model API key was rejected. Check ANTHROPIC_API_KEY in .env.';
  if (status === 429) return 'Rate limited by the model API. Try again in a moment.';
  if (status === 529 || status === 503) return 'The model API is overloaded right now. Try again in a moment.';
  return `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
}
