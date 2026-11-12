// Builds the "memory" section of the prompt for one user message.
//
// Three deterministic retrieval paths, no LLM call, so no added latency:
//   1. Date references -> every turn from those days (any thread).
//   2. Keywords        -> full-text search over past turns, only when the
//                         message refers back to earlier conversation.
//   3. An index        -> one line per recent turn, so the model can see what
//                         exists even when 1 and 2 miss (vague references).
// Turns already in the current thread's context window are excluded.

import type { Claim, Store, Turn } from '../db.js';
import { formatLocal } from '../time.js';
import { resolveTimeReferences, type TimeRange } from './temporal.js';

const STOPWORDS = new Set(
  (
    'the a an and or but if then than that this those these there their they them what which who whom ' +
    'when where why how is are was were be been being do does did done have has had having i me my mine ' +
    'you your yours we our ours us it its of in on at to for from by with about into over after before ' +
    'since still any some all can could would should will shall may might must just also very really ' +
    'today yesterday monday tuesday wednesday thursday friday saturday sunday january february march april ' +
    'june july august september october november december last week month year ago asked ask tell told ' +
    'answer answers correct right changed change shipped something anything big new now again thing things'
  ).split(' '),
);

const REFERS_BACK =
  /\b(we|our|us|earlier|before|previous(ly)?|last time|again|still|since|remember|mentioned|you said|you told|you recommended|you suggested|i asked|we discussed|shortlist(ed)?|that list|those|them)\b/i;

export interface RecallResult {
  ranges: TimeRange[];
  turns: Turn[];
  block: string;
}

export function keywords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]*[a-z0-9+#]|[a-z0-9]/g) ?? [];
  return [...new Set(words.filter((w) => (w.length >= 3 || /\d/.test(w)) && !STOPWORDS.has(w)))].slice(0, 12);
}

function overlap(turn: Turn, terms: string[]): number {
  const hay = `${turn.userText} ${turn.assistantText}`.toLowerCase();
  return terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
}

export function recall(
  store: Store,
  opts: { userId: string; message: string; nowMs: number; tz: string; inContextTurnIds: Set<number> },
): RecallResult {
  const { userId, message, nowMs, tz, inContextTurnIds } = opts;
  const ranges = resolveTimeReferences(message, nowMs, tz);
  const terms = keywords(message);
  const notInContext = (t: Turn) => !inContextTurnIds.has(t.id) && t.createdAt < nowMs;

  // 1. By date
  const byDate = new Map<number, Turn>();
  const emptyRanges: TimeRange[] = [];
  for (const r of ranges) {
    const found = store.turnsBetween(userId, r.startMs, r.endMs, 30).filter(notInContext);
    if (found.length === 0) emptyRanges.push(r);
    for (const t of found) byDate.set(t.id, t);
  }
  // Rank by topical overlap so "last Tuesday ... Postgres" picks the Postgres
  // turn when several happened that day; keep chronological order for output.
  const dateTurns = [...byDate.values()]
    .sort((a, b) => overlap(b, terms) - overlap(a, terms))
    .slice(0, 6)
    .sort((a, b) => a.createdAt - b.createdAt);

  // 2. By topic, only when the message points back at earlier conversation
  let topicTurns: Turn[] = [];
  if (ranges.length > 0 || REFERS_BACK.test(message)) {
    topicTurns = store
      .searchTurns(userId, terms, 6)
      .filter((t) => notInContext(t) && !byDate.has(t.id))
      .filter((t) => overlap(t, terms) >= Math.min(2, terms.length))
      .slice(0, dateTurns.length > 0 ? 2 : 4);
  }

  const turns = [...dateTurns, ...topicTurns];
  const claims = store.claimsFor(turns.map((t) => t.id));

  // 3. Index of recent history
  const index = store
    .recentTurns(userId, 25)
    .filter(notInContext)
    .map((t) => `- ${formatLocal(t.createdAt, tz)}: "${oneLine(t.userText, 140)}"`);

  return { ranges, turns, block: format({ nowMs, tz, ranges, emptyRanges, dateTurns, topicTurns, claims, index }) };
}

function format(p: {
  nowMs: number;
  tz: string;
  ranges: TimeRange[];
  emptyRanges: TimeRange[];
  dateTurns: Turn[];
  topicTurns: Turn[];
  claims: Map<number, Claim[]>;
  index: string[];
}): string {
  const { tz } = p;
  const out: string[] = [];

  if (p.ranges.length > 0) {
    out.push('Dates the user referred to, resolved in their timezone:');
    for (const r of p.ranges) {
      const days = Math.round((r.endMs - r.startMs) / 86_400_000);
      const when =
        days <= 1
          ? formatLocal(r.startMs, tz, false)
          : `${formatLocal(r.startMs, tz, false)} to ${formatLocal(r.endMs - 1, tz, false)}`;
      out.push(`- "${r.phrase}" -> ${when}${r.alternate ? ' (alternate reading of an ambiguous phrase)' : ''}`);
    }
    for (const r of p.emptyRanges) {
      out.push(`  NOTE: no conversation is recorded for "${r.phrase}" -> ${formatLocal(r.startMs, tz, false)}.`);
    }
    out.push('');
  }

  const section = (title: string, turns: Turn[]) => {
    if (turns.length === 0) return;
    out.push(title);
    for (const t of turns) {
      out.push(`### ${formatLocal(t.createdAt, tz)}`);
      out.push(`User asked: ${t.userText.trim()}`);
      // Old [n] markers would collide with this answer's citation numbers.
      const said = t.assistantText.replace(/\s?\[\d+(?:\s*,\s*\d+)*\]/g, '').trim();
      out.push(`You answered: ${truncate(said, 1800)}`);
      const cs = p.claims.get(t.id) ?? [];
      if (cs.length > 0) {
        out.push('Facts you stated then (baseline for "has anything changed"):');
        for (const c of cs.slice(0, 25)) {
          out.push(`  - ${c.subject} | ${c.attribute}: ${c.value}${c.sourceUrl ? ` (${c.sourceUrl})` : ''}`);
        }
      }
      if (t.sources.length > 0) {
        out.push('Sources you read then:');
        for (const s of t.sources.slice(0, 8)) {
          out.push(`  - ${s.title} <${s.url}>${s.published ? ` published ${s.published}` : ''}`);
        }
      }
      out.push('');
    }
  };
  section('## Conversations from those dates', p.dateTurns);
  section(
    p.dateTurns.length > 0
      ? '## Other related past conversations (NOT from the dates above)'
      : '## Related past conversations found by topic',
    p.topicTurns,
  );

  if (p.index.length > 0) {
    out.push('## Index of recent questions across all chats (newest first)');
    out.push(...p.index);
  } else {
    out.push('There are no earlier conversations on record.');
  }
  return out.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}… [truncated]`;
}

function oneLine(s: string, n: number): string {
  return truncate(s.replace(/\s+/g, ' ').trim(), n);
}
