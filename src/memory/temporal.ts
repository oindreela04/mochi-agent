// Turns time references in a user message ("on Monday", "last Tuesday",
// "3 November", "last week") into concrete UTC ranges in the user's timezone.
//
// This is deterministic on purpose: it runs in ~1ms before the model call, so
// past-conversation recall costs no extra LLM round trip and is unit-testable.

import * as chrono from 'chrono-node';
import {
  type LocalDate,
  addDays,
  isoDate,
  localDateOf,
  startOfLocalDay,
  tzOffsetMinutes,
  weekdayOf,
} from '../time.js';

export interface TimeRange {
  /** Phrase from the message that produced this range. */
  phrase: string;
  label: string; // e.g. "2026-11-09" or "week of 2026-11-02"
  startMs: number;
  endMs: number; // exclusive
  /** True when this is a second reading of an ambiguous phrase. */
  alternate?: boolean;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function dayRange(phrase: string, date: LocalDate, tz: string, alternate = false): TimeRange {
  return {
    phrase,
    label: isoDate(date),
    startMs: startOfLocalDay(date, tz),
    endMs: startOfLocalDay(addDays(date, 1), tz),
    ...(alternate ? { alternate } : {}),
  };
}

/** Monday-start week containing `date`. */
function weekStart(date: LocalDate): LocalDate {
  const wd = weekdayOf(date); // 0 = Sun
  return addDays(date, -((wd + 6) % 7));
}

export function resolveTimeReferences(text: string, nowMs: number, tz: string): TimeRange[] {
  const today = localDateOf(nowMs, tz);
  const ranges: TimeRange[] = [];
  let rest = text;

  // 1. Week and month phrases. chrono collapses these to a single day, which
  //    would make "last week" mean exactly seven days ago.
  const weekRe = /\b(last|previous|this|earlier this)\s+week\b/gi;
  for (const m of text.matchAll(weekRe)) {
    const thisWeek = weekStart(today);
    const start = /last|previous/i.test(m[1]!) ? addDays(thisWeek, -7) : thisWeek;
    const end = /last|previous/i.test(m[1]!) ? thisWeek : addDays(today, 1);
    ranges.push({
      phrase: m[0],
      label: `week of ${isoDate(start)}`,
      startMs: startOfLocalDay(start, tz),
      endMs: startOfLocalDay(end, tz),
    });
    rest = rest.replace(m[0], ' ');
  }
  const monthRe = /\b(last|previous|this|earlier this)\s+month\b/gi;
  for (const m of text.matchAll(monthRe)) {
    const last = /last|previous/i.test(m[1]!);
    const first: LocalDate = last
      ? { y: today.m === 1 ? today.y - 1 : today.y, m: today.m === 1 ? 12 : today.m - 1, d: 1 }
      : { y: today.y, m: today.m, d: 1 };
    const next: LocalDate = last ? { y: today.y, m: today.m, d: 1 } : addDays(today, 1);
    ranges.push({
      phrase: m[0],
      label: `month of ${isoDate(first).slice(0, 7)}`,
      startMs: startOfLocalDay(first, tz),
      endMs: startOfLocalDay(next, tz),
    });
    rest = rest.replace(m[0], ' ');
  }

  // 2. Everything else via chrono, anchored to the user's "now" and timezone.
  const parsed = chrono.parse(
    rest,
    { instant: new Date(nowMs), timezone: tzOffsetMinutes(tz, nowMs) },
    { forwardDate: false },
  );
  for (const r of parsed) {
    const date: LocalDate = { y: r.start.get('year')!, m: r.start.get('month')!, d: r.start.get('day')! };
    const isWeekday = r.start.isCertain('weekday') && !r.start.isCertain('day');
    if (!r.start.isCertain('day') && !isWeekday && r.start.isCertain('month')) {
      // A bare month ("in October")
      const first = { y: date.y, m: date.m, d: 1 };
      const next = date.m === 12 ? { y: date.y + 1, m: 1, d: 1 } : { y: date.y, m: date.m + 1, d: 1 };
      ranges.push({
        phrase: r.text,
        label: `month of ${isoDate(first).slice(0, 7)}`,
        startMs: startOfLocalDay(first, tz),
        endMs: startOfLocalDay(next, tz),
      });
      continue;
    }
    ranges.push(dayRange(r.text, date, tz));

    // "last Tuesday" said on a Wednesday could mean yesterday or the Tuesday
    // of last week. People use both, so look at both; the model sees the
    // actual dates of whatever we find and can say which one it used.
    const wd = WEEKDAYS.findIndex((w) => r.text.toLowerCase().includes(w.slice(0, 3)));
    if (isWeekday && /\blast\b/i.test(r.text) && wd >= 0) {
      ranges.push(dayRange(r.text, addDays(date, -7), tz, true));
    }
  }

  // 3. "on the 3rd" — chrono doesn't parse a bare ordinal day.
  for (const m of rest.matchAll(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/gi)) {
    const d = Number(m[1]);
    if (d < 1 || d > 31) continue;
    let date: LocalDate = { y: today.y, m: today.m, d };
    if (d > today.d) date = today.m === 1 ? { y: today.y - 1, m: 12, d } : { y: today.y, m: today.m - 1, d };
    ranges.push(dayRange(m[0].trim(), date, tz));
  }

  // Drop references to the future ("next Friday"), and "today" when the
  // message also names a past date ("is your answer from 3 Nov still correct
  // today?" is about 3 Nov, not about today).
  const todayStart = startOfLocalDay(today, tz);
  let out = ranges.filter((r) => r.startMs <= nowMs);
  if (out.some((r) => r.endMs <= todayStart)) out = out.filter((r) => r.startMs < todayStart);

  // De-duplicate identical ranges.
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.startMs}-${r.endMs}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
