import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTimeReferences } from '../src/memory/temporal.js';
import { formatLocal } from '../src/time.js';

// Wednesday 11 Nov 2026, 23:08 in Kolkata
const NOW = Date.parse('2026-11-11T17:38:00Z');
const TZ = 'Asia/Kolkata';

const days = (text: string, now = NOW, tz = TZ) =>
  resolveTimeReferences(text, now, tz).map((r) => ({
    from: formatLocal(r.startMs, tz, false),
    to: formatLocal(r.endMs - 1, tz, false),
    alt: !!r.alternate,
  }));

test('"On Monday" is the most recent Monday', () => {
  assert.deepEqual(days('On Monday we shortlisted 5 CRM tools'), [
    { from: 'Mon, 9 Nov 2026', to: 'Mon, 9 Nov 2026', alt: false },
  ]);
});

test('"3 November" is a single local day', () => {
  assert.deepEqual(days('What did I ask you on 3 November? Is your answer still correct today?'), [
    { from: 'Tue, 3 Nov 2026', to: 'Tue, 3 Nov 2026', alt: false },
  ]);
});

test('"Last Tuesday" yields both readings: yesterday and the week before', () => {
  assert.deepEqual(days('Last Tuesday I asked you about Postgres hosting'), [
    { from: 'Tue, 10 Nov 2026', to: 'Tue, 10 Nov 2026', alt: false },
    { from: 'Tue, 3 Nov 2026', to: 'Tue, 3 Nov 2026', alt: true },
  ]);
});

test('"last week" is the whole previous Monday-Sunday week', () => {
  assert.deepEqual(days('what did we talk about last week'), [
    { from: 'Mon, 2 Nov 2026', to: 'Sun, 8 Nov 2026', alt: false },
  ]);
});

test('"last month" is the whole previous month', () => {
  assert.deepEqual(days('the laptops from last month'), [
    { from: 'Thu, 1 Oct 2026', to: 'Sat, 31 Oct 2026', alt: false },
  ]);
});

test('bare ordinal "the 3rd" resolves to this month', () => {
  assert.deepEqual(days('the thing you said on the 3rd'), [
    { from: 'Tue, 3 Nov 2026', to: 'Tue, 3 Nov 2026', alt: false },
  ]);
});

test('future references are ignored', () => {
  assert.deepEqual(days('remind me what to do next Friday'), []);
});

test('day boundaries follow the user timezone, not UTC', () => {
  const [r] = resolveTimeReferences('on 3 November', NOW, TZ);
  // Midnight in Kolkata is 18:30 UTC the previous day.
  assert.equal(new Date(r!.startMs).toISOString(), '2026-11-02T18:30:00.000Z');
  const [ny] = resolveTimeReferences('on 3 November', NOW, 'America/New_York');
  assert.equal(new Date(ny!.startMs).toISOString(), '2026-11-03T05:00:00.000Z'); // EST after DST ended 1 Nov
});

test('no date in message, no ranges', () => {
  assert.deepEqual(days('best postgres hosting for a startup?'), []);
});
