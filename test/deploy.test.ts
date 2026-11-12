// Behaviour that matters once the agent is on a public URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { loadDemo, resolveWhen, type DemoFile } from '../src/demo.js';
import { recall } from '../src/memory/recall.js';
import { RateLimiter } from '../src/ratelimit.js';
import { createApp } from '../src/server.js';
import { formatLocal, isoDate } from '../src/time.js';

const TZ = 'Asia/Kolkata';
const WED = Date.parse('2026-11-11T17:38:00Z'); // Wed 11 Nov 2026, 23:08 IST

test('visitors never see each other\'s memory', () => {
  const s = new Store(':memory:');
  const t = s.ensureThread('alice', undefined, 'postgres', WED - 86_400_000);
  s.addTurn({ userId: 'alice', threadId: t.id, createdAt: WED - 86_400_000, tz: TZ, userText: 'Best Postgres hosting?', assistantText: 'Neon.', sources: [], queries: [] });

  assert.equal(s.listThreads('alice').length, 1);
  assert.equal(s.listThreads('bob').length, 0);
  assert.equal(s.threadTurns('bob', t.id).length, 0, 'thread id alone does not grant access');
  assert.notEqual(s.ensureThread('bob', t.id, 'x', WED).id, t.id, 'bob cannot write into alice\'s thread');
  assert.equal(s.searchTurns('bob', ['postgres']).length, 0);
  const r = recall(s, { userId: 'bob', message: 'Yesterday I asked about Postgres hosting', nowMs: WED, tz: TZ, inContextTurnIds: new Set() });
  assert.equal(r.turns.length, 0);
  assert.match(r.block, /no earlier conversations on record/i);
});

test('example dates are re-anchored to the visitor\'s calendar', () => {
  assert.equal(isoDate(resolveWhen('monday', WED, TZ)), '2026-11-09');
  assert.equal(isoDate(resolveWhen('tuesday', WED, TZ)), '2026-11-10');
  assert.equal(isoDate(resolveWhen('wednesday', WED, TZ)), '2026-11-04', 'never today');
  assert.equal(isoDate(resolveWhen('11-03', WED, TZ)), '2026-11-03');
  assert.equal(isoDate(resolveWhen('12-25', WED, TZ)), '2025-12-25', 'a future month-day means last year');
});

test('loaded examples answer the challenge\'s date questions, once', () => {
  const s = new Store(':memory:');
  const demo: DemoFile = {
    generatedAt: '2026-11-12T00:00:00Z',
    turns: [
      { when: 'monday', hour: 11, userText: 'Shortlist 5 CRM tools', assistantText: 'HubSpot, Pipedrive…', sources: [], claims: [{ subject: 'Pipedrive', attribute: 'on shortlist', value: 'yes', sourceUrl: null }], profile: [{ key: 'sales team size', value: '20 people' }] },
      { when: '11-03', hour: 10, userText: 'Notion pricing?', assistantText: 'Plus is $10.', sources: [], claims: [], profile: [] },
    ],
  };
  assert.equal(loadDemo(s, 'v1', demo, WED, TZ), 2);
  assert.equal(loadDemo(s, 'v1', demo, WED, TZ), 0, 'idempotent');
  assert.equal(s.listThreads('v1')[0]!.title.startsWith('Example · '), true);

  const monday = recall(s, { userId: 'v1', message: 'On Monday we shortlisted 5 CRM tools. Any changes?', nowMs: WED, tz: TZ, inContextTurnIds: new Set() });
  assert.equal(monday.turns[0]!.userText, 'Shortlist 5 CRM tools');
  assert.equal(formatLocal(monday.turns[0]!.createdAt, TZ), 'Mon, 9 Nov 2026, 11:00');
  assert.match(monday.block, /Pipedrive \| on shortlist: yes/);

  const nov3 = recall(s, { userId: 'v1', message: 'What did I ask you on 3 November?', nowMs: WED, tz: TZ, inContextTurnIds: new Set() });
  assert.equal(nov3.turns[0]!.userText, 'Notion pricing?');
});

test('rate limiter blocks after the limit and recovers after the window', () => {
  const rl = new RateLimiter(2, 1000);
  assert.equal(rl.hit('a', 0), 0);
  assert.equal(rl.hit('a', 10), 0);
  assert.ok(rl.hit('a', 20) > 0);
  assert.equal(rl.hit('b', 20), 0, 'keys are independent');
  assert.equal(rl.hit('a', 1000), 0);
});

test('server issues a visitor cookie and scopes threads to it', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store, llm: {} as never, search: {} as never }, { demo: () => null, demoStatus: () => 'unavailable' });

  const r1 = await app.request('/api/threads');
  const cookie = r1.headers.get('set-cookie') ?? '';
  assert.match(cookie, /vid=[0-9a-f-]{36}/);
  assert.match(cookie, /HttpOnly/);
  const vid = cookie.match(/vid=([0-9a-f-]{36})/)![1]!;

  const imported = await app.request('/api/history', {
    method: 'POST',
    headers: { cookie: `vid=${vid}`, 'content-type': 'application/json' },
    body: JSON.stringify([{ at: '2026-11-03T10:00:00+05:30', user: 'hello', assistant: 'hi' }]),
  });
  assert.equal(imported.status, 200);
  const mine = (await (await app.request('/api/threads', { headers: { cookie: `vid=${vid}` } })).json()) as unknown[];
  const other = (await (await app.request('/api/threads')).json()) as unknown[];
  assert.equal(mine.length, 1);
  assert.equal(other.length, 0);
  assert.equal((await app.request('/healthz')).status, 200);
});

test('profile: newer facts replace older ones, empty value retracts, scoped per user', () => {
  const s = new Store(':memory:');
  s.upsertProfile('u', [{ key: 'Sales team size', value: '20 people' }, { key: 'currency', value: 'INR' }], null, 1);
  s.upsertProfile('u', [{ key: 'sales team  size', value: '35 people' }, { key: 'currency', value: '' }], null, 2);
  assert.deepEqual(s.getProfile('u').map((f) => [f.key, f.value]), [['sales team size', '35 people']]);
  assert.deepEqual(s.getProfile('someone-else'), []);
  s.deleteProfile('u', 'Sales Team Size');
  assert.deepEqual(s.getProfile('u'), []);
});
