// Replays multi-day conversations like the challenge examples against the real
// model and search APIs, using a throwaway database and a simulated clock.
//
//   npm run scenarios
//
// Day 1 questions are asked "in the past"; follow-ups are asked "today".

import Anthropic from '@anthropic-ai/sdk';
import { config, missingKeys } from '../src/config.js';
import { Store } from '../src/db.js';
import { runAgent } from '../src/agent/run.js';
import { TavilyProvider } from '../src/search.js';
import { addDays, localDateOf, startOfLocalDay, weekdayOf } from '../src/time.js';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const now = Date.now();
const today = localDateOf(now, TZ);
const at = (daysAgo: number, hour: number) => startOfLocalDay(addDays(today, -daysAgo), TZ) + hour * 3_600_000;
/** Days back to the most recent `weekday` (0 = Sunday) strictly before today. */
const back = (weekday: number) => ((weekdayOf(today) - weekday + 7) % 7) || 7;

const scenarios: { name: string; turns: { daysAgo: number; text: string }[] }[] = [
  {
    name: 'CRM shortlist, then "has anything changed since Monday?"',
    turns: [
      { daysAgo: back(1), text: 'Shortlist 5 CRM tools for a 20-person B2B sales team, with current per-seat pricing.' },
      { daysAgo: 0, text: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?' },
    ],
  },
  {
    name: 'Postgres hosting, then "last Tuesday … has pricing changed?"',
    turns: [
      { daysAgo: back(2), text: 'What are the cheapest managed Postgres hosting options for a small SaaS right now?' },
      { daysAgo: 0, text: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?' },
    ],
  },
  {
    name: 'Recall by date with no conversation on record',
    turns: [{ daysAgo: 0, text: 'What did I ask you on 1 January? Is your answer still correct today?' }],
  },
];

async function main() {
  const missing = missingKeys();
  if (missing.length) throw new Error(`Set ${missing.join(', ')} in .env first.`);
  const deps = {
    store: new Store(':memory:'),
    llm: new Anthropic({ apiKey: config.anthropicKey }),
    search: new TavilyProvider(config.tavilyKey),
  };

  for (const s of scenarios) {
    console.log(`\n${'='.repeat(80)}\n${s.name}\n${'='.repeat(80)}`);
    for (const t of s.turns) {
      const when = t.daysAgo === 0 ? now : at(t.daysAgo, 11);
      console.log(`\n> [${new Date(when).toLocaleString('en-GB', { timeZone: TZ })}] ${t.text}\n`);
      const started = Date.now();
      let first = 0;
      for await (const ev of runAgent(deps, { userId: 'scenarios', message: t.text, nowMs: when, tz: TZ })) {
        if (ev.type === 'memory') console.log(`  (recalled ${ev.recalled.length} turn(s); dates: ${ev.dates.join(', ') || 'none'})`);
        if (ev.type === 'search') console.log(`  (search: ${ev.queries.join(' | ')}${ev.recency ? `, past ${ev.recency}` : ''})`);
        if (ev.type === 'text') {
          if (!first) first = Date.now();
          process.stdout.write(ev.delta);
        }
        if (ev.type === 'error') console.log(`  ERROR: ${ev.message}`);
      }
      console.log(`\n\n  first token ${((first - started) / 1000).toFixed(1)}s, total ${((Date.now() - started) / 1000).toFixed(1)}s`);
      await new Promise((r) => setTimeout(r, 4000)); // let background fact extraction land
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
