/**
 * The daily clock.
 *
 * Uses performance.now(), which is monotonic: immune to the player changing
 * their system clock and to DST jumps.
 *
 * It accumulates only while the player is actually deciding. Three things are
 * deliberately NOT charged:
 *   - the reveal animation, which the player cannot influence and which would
 *     otherwise punish an error twice (+30s AND the reveal it triggered), and
 *     would make a slow device cost more than a fast one;
 *   - time with the tab hidden;
 *   - any single gap over 2s, which means a throttled background tab or a
 *     laptop that went to sleep.
 */
const MAX_TICK_MS = 2000;

export class DailyTimer {
  private accumulated = 0;
  private tickStart: number | null = null;
  private lastTick = 0;

  constructor(resumeFromMs = 0) {
    this.accumulated = resumeFromMs;
  }

  /** Enter a phase where the player is deciding. */
  resume(): void {
    if (this.tickStart !== null) return;
    this.tickStart = performance.now();
    this.lastTick = this.tickStart;
  }

  /** Leave it — reveal, tab hidden, run finished. */
  pause(): void {
    if (this.tickStart === null) return;
    this.accrue();
    this.tickStart = null;
  }

  /** Fold elapsed time in, discarding implausibly long gaps. */
  private accrue(): void {
    if (this.tickStart === null) return;
    const now = performance.now();
    const delta = now - this.lastTick;
    this.lastTick = now;
    if (delta > 0 && delta <= MAX_TICK_MS) this.accumulated += delta;
  }

  /**
   * Current total. Call it often (the UI ticks at ~100ms) so gaps stay under
   * MAX_TICK_MS while the player is genuinely present.
   */
  elapsedMs(): number {
    this.accrue();
    return this.accumulated;
  }

  get isRunning(): boolean {
    return this.tickStart !== null;
  }
}
