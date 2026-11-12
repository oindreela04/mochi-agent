// Timezone helpers with no dependencies. All instants are UTC epoch ms;
// "local" means wall-clock time in the user's IANA timezone.

export interface LocalDate {
  y: number;
  m: number; // 1-12
  d: number;
}

/** Offset of `tz` from UTC at instant `ms`, in minutes (e.g. +330 for Asia/Kolkata). */
export function tzOffsetMinutes(tz: string, ms: number): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(new Date(ms))
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = part?.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0; // "GMT" exactly
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** Calendar date of instant `ms` in `tz`. */
export function localDateOf(ms: number, tz: string): LocalDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** UTC instant of local midnight at the start of `date` in `tz` (DST-safe). */
export function startOfLocalDay(date: LocalDate, tz: string): number {
  const guess = Date.UTC(date.y, date.m - 1, date.d);
  let ms = guess - tzOffsetMinutes(tz, guess) * 60_000;
  // Re-check once: offset may differ at the real instant across a DST change.
  ms = guess - tzOffsetMinutes(tz, ms) * 60_000;
  return ms;
}

/** Add calendar days to a local date (pure date arithmetic, no tz involved). */
export function addDays(date: LocalDate, n: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** 0 = Sunday ... 6 = Saturday */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
}

export function formatLocal(ms: number, tz: string, withTime = true): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(new Date(ms));
}

export function isoDate(date: LocalDate): string {
  return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
