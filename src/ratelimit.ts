// Fixed-window counters, in memory. Enough to stop a public demo link from
// draining the API budget; a multi-instance deployment would move this to Redis.

export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(private limit: number, private windowMs: number) {}

  /** Records one hit for `key`. Returns seconds until retry when over the limit, else 0. */
  hit(key: string, nowMs = Date.now()): number {
    if (this.limit <= 0) return 0; // disabled
    let w = this.windows.get(key);
    if (!w || nowMs - w.start >= this.windowMs) {
      w = { start: nowMs, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 50_000) this.sweep(nowMs);
    }
    if (w.count >= this.limit) return Math.ceil((w.start + this.windowMs - nowMs) / 1000);
    w.count++;
    return 0;
  }

  private sweep(nowMs: number) {
    for (const [k, w] of this.windows) if (nowMs - w.start >= this.windowMs) this.windows.delete(k);
  }
}
