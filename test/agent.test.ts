// End-to-end agent runs with a scripted model and a fake search provider:
// verifies the tool loop, citations, persistence, fact extraction and that a
// later "on Monday…" question receives the right memory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { Store } from '../src/db.js';
import { runAgent, type AgentEvent } from '../src/agent/run.js';
import type { SearchProvider } from '../src/search.js';

const TZ = 'Asia/Kolkata';
const MONDAY = Date.parse('2026-11-09T09:00:00Z'); // Mon 9 Nov, 14:30 IST
const WEDNESDAY = Date.parse('2026-11-11T17:38:00Z'); // Wed 11 Nov, 23:08 IST

type Scripted = { text?: string; tool?: Record<string, unknown> };

function fakeLLM(script: Scripted[], seen: Anthropic.MessageCreateParams[]) {
  let i = 0;
  const messages = {
    stream(params: Anthropic.MessageCreateParams) {
      seen.push(structuredClone(params));
      const step = script[i++] ?? { text: '(script exhausted)' };
      const content: Anthropic.ContentBlock[] = [];
      const events: unknown[] = [];
      if (step.text) {
        content.push({ type: 'text', text: step.text, citations: null } as Anthropic.TextBlock);
        events.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } });
      }
      if (step.tool) {
        content.push({ type: 'tool_use', id: `tu_${i}`, name: 'web_search', input: step.tool } as Anthropic.ToolUseBlock);
      }
      const final = { content, stop_reason: step.tool ? 'tool_use' : 'end_turn' };
      return {
        async *[Symbol.asyncIterator]() {
          yield* events;
        },
        finalMessage: async () => final,
      };
    },
    async parse() {
      return {
        parsed_output: {
          claims: [
            { subject: 'HubSpot Sales Hub', attribute: 'Professional price', value: '$100/seat/month', source: 1 },
            { subject: 'Pipedrive', attribute: 'on shortlist', value: 'yes', source: 2 },
          ],
          profile: [{ key: 'Sales team size', value: '20 people' }],
        },
      };
    },
  };
  return { messages } as unknown as Pick<Anthropic, 'messages'>;
}

const fakeSearch: SearchProvider = {
  async search(query) {
    return [
      { url: 'https://www.hubspot.com/pricing/sales', title: 'HubSpot Sales Hub pricing', content: `Professional $100/seat/mo (${query})`, published: '2026-11-01' },
      { url: 'https://www.pipedrive.com/en/pricing', title: 'Pipedrive pricing', content: 'Growth $49/seat/mo', published: null },
    ];
  },
};

async function collect(gen: AsyncGenerator<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

test('search loop, citations, persistence, and recall of Monday\'s shortlist on Wednesday', async () => {
  const store = new Store(':memory:');
  const seen: Anthropic.MessageCreateParams[] = [];
  const llm = fakeLLM(
    [
      { tool: { queries: ['HubSpot Sales Hub pricing', 'Pipedrive pricing'] } },
      { text: 'Shortlist: HubSpot Sales Hub at $100/seat/month [1] and Pipedrive [2].' },
      { tool: { queries: ['HubSpot Sales Hub pricing change'], recency: 'week' } },
      { text: 'No pricing change found for HubSpot since Monday [1].' },
    ],
    seen,
  );

  // Monday: the shortlist conversation
  const ev1 = await collect(
    runAgent({ store, llm, search: fakeSearch }, { userId: 'u1', message: 'Shortlist CRM tools for a 20-person sales team', nowMs: MONDAY, tz: TZ }),
  );
  const search1 = ev1.find((e) => e.type === 'search');
  assert.deepEqual(search1 && 'queries' in search1 && search1.queries, ['HubSpot Sales Hub pricing', 'Pipedrive pricing']);
  const sources = ev1.findLast((e) => e.type === 'sources');
  assert.equal(sources && 'sources' in sources && sources.sources.length, 2, 'same URLs from two queries are de-duplicated');
  assert.ok(ev1.some((e) => e.type === 'done'));
  // tool result carries numbered sources with publish dates
  const toolResult = JSON.stringify(seen[1]!.messages.at(-1));
  assert.match(toolResult, /\[1\] HubSpot Sales Hub pricing/);
  assert.match(toolResult, /Published: 2026-11-01/);

  await new Promise((r) => setTimeout(r, 10)); // background extraction

  // Wednesday, new chat: refers back to Monday
  const ev2 = await collect(
    runAgent(
      { store, llm, search: fakeSearch },
      { userId: 'u1', message: 'On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?', nowMs: WEDNESDAY, tz: TZ },
    ),
  );
  const mem = ev2.find((e) => e.type === 'memory');
  assert.ok(mem && 'recalled' in mem && mem.recalled.length === 1, 'Monday turn recalled');

  const system = JSON.stringify(seen[2]!.system);
  assert.match(system, /Mon, 9 Nov 2026/);
  assert.match(system, /Shortlist CRM tools for a 20-person sales team/);
  assert.match(system, /HubSpot Sales Hub \| Professional price: \$100\/seat\/month/, 'extracted facts are the baseline');
  assert.match(system, /Wed, 11 Nov 2026, 23:08/, 'current local time is in the prompt');
  assert.match(system, /<profile>\\n- sales team size: 20 people/, 'learned profile carries across chats');
  assert.deepEqual(store.getProfile('u2'), [], 'and only for that user');
  // A new thread: Monday's turn is not duplicated as chat history
  assert.equal(seen[2]!.messages.length, 1);
});

test('honest when nothing is on record for the date', async () => {
  const store = new Store(':memory:');
  const seen: Anthropic.MessageCreateParams[] = [];
  const llm = fakeLLM([{ text: "I don't have a record of a chat on 3 November." }], seen);
  await collect(runAgent({ store, llm, search: fakeSearch }, { userId: 'u1', message: 'What did I ask you on 3 November?', nowMs: WEDNESDAY, tz: TZ }));
  const system = JSON.stringify(seen[0]!.system);
  assert.match(system, /no conversation is recorded for \\"on 3 November\\"/);
  assert.match(system, /There are no earlier conversations on record/);
});

test('last round forbids tools so the loop always ends with an answer', async () => {
  const store = new Store(':memory:');
  const seen: Anthropic.MessageCreateParams[] = [];
  const llm = fakeLLM(
    [{ tool: { queries: ['a'] } }, { tool: { queries: ['b'] } }, { tool: { queries: ['c'] } }, { text: 'Final answer [1].' }],
    seen,
  );
  const ev = await collect(runAgent({ store, llm, search: fakeSearch }, { userId: 'u1', message: 'q', nowMs: WEDNESDAY, tz: TZ }));
  assert.equal(seen.length, 4);
  assert.deepEqual(seen[3]!.tool_choice, { type: 'none' });
  assert.ok(ev.some((e) => e.type === 'done'));
});
