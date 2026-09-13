/**
 * Sliding-window rate limiter for the Deezer public API.
 *
 * Deezer allows 50 requests per rolling 5 seconds and then answers
 * {"error":{"code":4,"message":"Quota limit exceeded"}} for about five seconds.
 * Because JSONP *resolves* with that body rather than rejecting, an over-quota
 * call is indistinguishable from a real answer unless something checks for it —
 * which is how a transient limit once surfaced to players as "this song has no
 * preview", a permanent-sounding message for a five-second condition.
 *
 * The clock and sleep are injectable so the window behaviour is unit-testable
 * without waiting in real time.
 */
export interface RateLimiterOptions {
  windowMs?: number;
  max?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly calls: number[] = [];

  constructor(opts: RateLimiterOptions = {}) {
    this.windowMs = opts.windowMs ?? 5000;
    // Deezer's ceiling is 50; the default leaves headroom for requests that are
    // already in flight when a burst starts.
    this.max = opts.max ?? 45;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Resolves when it is safe to issue another request, reserving a slot. */
  async acquire(): Promise<void> {
    for (;;) {
      const now = this.now();
      while (this.calls.length && now - this.calls[0] > this.windowMs) this.calls.shift();
      if (this.calls.length < this.max) {
        this.calls.push(now);
        return;
      }
      await this.sleep(this.windowMs - (now - this.calls[0]) + 50);
    }
  }

  /** Requests currently counted inside the window (test/debug aid). */
  get inWindow(): number {
    const now = this.now();
    return this.calls.filter((t) => now - t <= this.windowMs).length;
  }
}

/** Deezer error codes meaning "temporary, ask again" rather than "no". */
export function isTransientDeezerError(code: unknown): boolean {
  return code === 4 || code === 700; // quota exceeded / service busy
}
