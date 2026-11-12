// Example history, so a first-time visitor can try the memory questions
// ("On Monday we shortlisted 5 CRM tools…") without having chatted before.
//
// The examples are real agent answers with real sources and extracted facts,
// generated once (`npm run demo:build`, or automatically on first boot) and
// copied into a visitor's own memory on request. Their dates are re-anchored
// to the visitor's calendar: "monday" becomes their most recent Monday. They
// are always labelled "Example" in the UI; nothing pretends to be a real chat.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentDeps } from './agent/run.js';
import { runAgent } from './agent/run.js';
import { Store, type Source } from './db.js';
import { extractMemory } from './memory/extract.js';
import { type LocalDate, addDays, localDateOf, startOfLocalDay, weekdayOf } from './time.js';

/** "monday" … "sunday", or "MM-DD" for a fixed calendar day. */
export type When = string;

export interface DemoTurn {
  when: When;
  hour: number;
  userText: string;
  assistantText: string;
  sources: Source[];
  claims: { subject: string; attribute: string; value: string; sourceUrl: string | null }[];
  profile: { key: string; value: string }[];
}

export interface DemoFile {
  generatedAt: string;
  turns: DemoTurn[];
}

/** Mirrors the kinds of questions in the challenge's examples. */
export const DEMO_QUESTIONS: { when: When; hour: number; text: string }[] = [
  { when: '11-03', hour: 10, text: "What does Notion's cheapest paid plan cost per user, and what does it include?" },
  { when: 'monday', hour: 11, text: 'Shortlist 5 CRM tools for a 20-person B2B sales team, with current per-seat pricing for each.' },
  { when: 'tuesday', hour: 16, text: 'What are the best managed Postgres hosting options for a small SaaS right now, and what do they cost?' },
];

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** The most recent past date matching `when`, strictly before today, in `tz`. */
export function resolveWhen(when: When, nowMs: number, tz: string): LocalDate {
  const today = localDateOf(nowMs, tz);
  const wd = WEEKDAYS.indexOf(when.toLowerCase());
  if (wd >= 0) return addDays(today, -(((weekdayOf(today) - wd + 7) % 7) || 7));
  const [m, d] = when.split('-').map(Number) as [number, number];
  const thisYear = { y: today.y, m, d };
  const isPast = m < today.m || (m === today.m && d < today.d);
  return isPast ? thisYear : { y: today.y - 1, m, d };
}

export function demoTimestamp(when: When, hour: number, nowMs: number, tz: string): number {
  return startOfLocalDay(resolveWhen(when, nowMs, tz), tz) + hour * 3_600_000;
}

export function readDemo(path: string): DemoFile | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as DemoFile) : null;
  } catch {
    return null;
  }
}

/** Runs the real agent on each demo question and writes the results to `path`. */
export async function buildDemo(deps: Omit<AgentDeps, 'store'>, path: string, tz = 'UTC'): Promise<DemoFile> {
  const turns: DemoTurn[] = [];
  for (const q of DEMO_QUESTIONS) {
    const store = new Store(':memory:'); // each example is answered with no prior memory
    const nowMs = demoTimestamp(q.when, q.hour, Date.now(), tz);
    let done: { answer: string; sources: Source[] } | null = null;
    for await (const ev of runAgent({ ...deps, store }, { userId: 'demo', message: q.text, nowMs, tz, extractFacts: false })) {
      if (ev.type === 'error') throw new Error(`demo "${q.text}": ${ev.message}`);
      if (ev.type === 'done') done = ev;
    }
    if (!done) throw new Error(`demo "${q.text}": no answer`);

    const scratch = new Store(':memory:');
    const thread = scratch.ensureThread('demo', undefined, q.text, nowMs);
    const turn = { userId: 'demo', threadId: thread.id, createdAt: nowMs, tz, userText: q.text, assistantText: done.answer, sources: done.sources, queries: [] };
    const id = scratch.addTurn(turn);
    await extractMemory(deps.llm, scratch, { ...turn, id });
    const claims = (scratch.claimsFor([id]).get(id) ?? []).map(({ subject, attribute, value, sourceUrl }) => ({ subject, attribute, value, sourceUrl }));

    const profile = scratch.getProfile('demo').map(({ key, value }) => ({ key, value }));
    turns.push({ when: q.when, hour: q.hour, userText: q.text, assistantText: done.answer, sources: done.sources, claims, profile });
    console.log(`[demo] answered "${q.text.slice(0, 50)}…" (${done.sources.length} sources, ${claims.length} facts)`);
  }
  const file: DemoFile = { generatedAt: new Date().toISOString(), turns };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return file;
}

/** Copies the examples into one user's memory. Idempotent. Returns how many were added. */
export function loadDemo(store: Store, userId: string, demo: DemoFile, nowMs: number, tz: string): number {
  let added = 0;
  for (const t of demo.turns) {
    const createdAt = demoTimestamp(t.when, t.hour, nowMs, tz);
    if (store.hasTurn(userId, t.userText, createdAt)) continue;
    const thread = store.ensureThread(userId, undefined, `Example · ${t.userText}`, createdAt);
    const turnId = store.addTurn({
      userId,
      threadId: thread.id,
      createdAt,
      tz,
      userText: t.userText,
      assistantText: t.assistantText,
      sources: t.sources.map((s) => ({ ...s, retrievedAt: createdAt })),
      queries: [],
    });
    store.addClaims(t.claims.map((c) => ({ ...c, turnId })));
    store.upsertProfile(userId, t.profile ?? [], turnId, createdAt);
    added++;
  }
  return added;
}
