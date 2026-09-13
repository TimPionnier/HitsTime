import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chromeGap,
  looksOpen,
  relax,
  watchDevtools,
  type Baseline,
  type Viewport,
} from './devtools';
import {
  ERROR_PENALTY_MS,
  PEEK_PENALTY_MS,
  adjustedMsFor,
  newAttempt,
  withPeek,
} from './dailyStore';

/** A 1440x900 window with ~90px of browser chrome on top and none at the sides. */
const closed: Viewport = {
  outerWidth: 1440,
  innerWidth: 1440,
  outerHeight: 900,
  innerHeight: 810,
  dpr: 1,
};

const base: Baseline = { gapW: 0, gapH: 90, dpr: 1 };

describe('looksOpen', () => {
  it('is quiet on the viewport it was calibrated against', () => {
    expect(looksOpen(closed, base)).toBe(false);
  });

  it('sees a side-docked panel', () => {
    expect(looksOpen({ ...closed, innerWidth: 940 }, base)).toBe(true);
  });

  it('sees a bottom-docked panel', () => {
    expect(looksOpen({ ...closed, innerHeight: 480 }, base)).toBe(true);
  });

  it('ignores a narrow sidebar below the threshold', () => {
    expect(looksOpen({ ...closed, innerWidth: 1440 - 120 }, base)).toBe(false);
  });

  it('ignores a window resize, which moves inner and outer together', () => {
    const resized = { ...closed, outerWidth: 800, innerWidth: 800, outerHeight: 600, innerHeight: 510 };
    expect(looksOpen(resized, base)).toBe(false);
  });

  // The regression this whole dpr dance exists for: at 200% zoom innerWidth
  // halves while outerWidth does not, which without correction is a 720px gap —
  // an innocent player charged 5 minutes for zooming in.
  it('ignores page zoom', () => {
    const zoomed: Viewport = { ...closed, innerWidth: 720, innerHeight: 405, dpr: 2 };
    expect(chromeGap(zoomed, base.dpr).gapW).toBe(0);
    expect(looksOpen(zoomed, base)).toBe(false);
  });

  it('catches a panel that was already open at load, via the absolute width floor', () => {
    // Baseline poisoned: calibration itself happened with the panel open.
    const poisoned: Baseline = { gapW: 400, gapH: 90, dpr: 1 };
    expect(looksOpen({ ...closed, innerWidth: 1040 }, poisoned)).toBe(true);
  });

  // The reported gap: DevTools docked to the BOTTOM before the app loaded. The
  // baseline records the panel as if it were chrome, so no delta can ever see
  // it — only an absolute ceiling on plausible chrome height can.
  it('catches a bottom-docked panel that was already open at load', () => {
    const poisoned: Baseline = { gapW: 0, gapH: 450, dpr: 1 };
    expect(looksOpen({ ...closed, innerHeight: 450 }, poisoned)).toBe(true);
  });

  it('does not mistake tall browser chrome for a bottom panel', () => {
    // Tab bar + URL bar + bookmarks + an extension bar, generously: still ~200px.
    const chromeHeavy: Baseline = { gapW: 0, gapH: 200, dpr: 1 };
    expect(looksOpen({ ...closed, innerHeight: 700 }, chromeHeavy)).toBe(false);
  });
});

describe('relax', () => {
  // Recovery from a poisoned baseline: the player closes the panel they had
  // open at load, and from then on the detector knows what real chrome costs.
  it('lowers the baseline toward the smallest chrome seen', () => {
    const poisoned: Baseline = { gapW: 0, gapH: 250, dpr: 1 };
    const relaxed = relax(poisoned, closed); // panel now closed: gapH back to 90
    expect(relaxed.gapH).toBe(90);
    expect(looksOpen({ ...closed, innerHeight: 560 }, relaxed)).toBe(true);
  });

  it('never raises a baseline', () => {
    const base: Baseline = { gapW: 0, gapH: 90, dpr: 1 };
    expect(relax(base, { ...closed, innerHeight: 400 })).toEqual(base);
  });

  it('is not moved by a window resize', () => {
    const base: Baseline = { gapW: 0, gapH: 90, dpr: 1 };
    const resized = { ...closed, outerWidth: 800, innerWidth: 800, outerHeight: 600, innerHeight: 510 };
    expect(relax(base, resized)).toEqual(base);
  });
});

describe('adjustedMsFor', () => {
  it('adds the peek penalty on top of the error penalty', () => {
    expect(adjustedMsFor(60_000, 2, 1)).toBe(60_000 + 2 * ERROR_PENALTY_MS + PEEK_PENALTY_MS);
  });

  it('defaults to no peek, so old stored attempts score unchanged', () => {
    expect(adjustedMsFor(60_000, 2)).toBe(60_000 + 2 * ERROR_PENALTY_MS);
  });

  it('caps repeat offences at PEEK_CAP', () => {
    expect(adjustedMsFor(0, 0, 7)).toBe(PEEK_PENALTY_MS);
  });
});

describe('withPeek', () => {
  const fresh = () => ({ ...newAttempt('2026-09-13', 1, 'abc'), rawActiveMs: 40_000, errors: 1 });

  it('charges the penalty and folds it into the score', () => {
    const charged = withPeek(fresh());
    expect(charged?.peeks).toBe(1);
    expect(charged?.adjustedMs).toBe(40_000 + ERROR_PENALTY_MS + PEEK_PENALTY_MS);
  });

  // Edge-triggered detection plus an indecisive player must not compound into a
  // run that cannot be finished.
  it('refuses a second charge on the same run', () => {
    const once = withPeek(fresh())!;
    expect(withPeek(once)).toBeNull();
  });

  it('leaves a finished run alone', () => {
    expect(withPeek({ ...fresh(), status: 'finished' })).toBeNull();
  });

  it('does not touch the rounds or the raw time', () => {
    const before = fresh();
    const after = withPeek(before)!;
    expect(after.rawActiveMs).toBe(before.rawActiveMs);
    expect(after.rounds).toEqual(before.rounds);
  });
});

/**
 * Fake browser just wide enough for watchDevtools: a viewport we can move, a
 * pointer that reports as fine, and timers vitest can drive.
 */
function fakeWindow(v: Viewport) {
  return {
    ...v,
    devicePixelRatio: v.dpr,
    matchMedia: () => ({ matches: true }),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };
}

describe('watchDevtools latching', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { window?: unknown }).window;
  });

  const openAtLoad = () => {
    vi.useFakeTimers();
    // Side-docked panel, open before the app loaded: over the absolute floor,
    // so every poll reads as open and the baseline is poisoned.
    const w = fakeWindow({
      outerWidth: 1440,
      innerWidth: 1040,
      outerHeight: 900,
      innerHeight: 810,
      dpr: 1,
    });
    (globalThis as { window?: unknown }).window = w;
  };

  /**
   * THE REGRESSION. onOpen used to latch whether or not the charge landed, so a
   * panel open before a run started fired once against a store that refused it
   * (no daily run yet) and then never fired again all session — reported as
   * "already open is not detected".
   */
  it('keeps trying while the charge is refused, and charges once it lands', () => {
    openAtLoad();
    let accepting = false;
    let calls = 0;
    const stop = watchDevtools(() => {
      calls++;
      return accepting;
    });

    vi.advanceTimersByTime(3000); // refused throughout — a run has not started
    expect(calls).toBeGreaterThan(1);

    accepting = true; // the player now starts a daily run
    const before = calls;
    vi.advanceTimersByTime(1600);
    expect(calls).toBeGreaterThan(before);

    const afterCharge = calls;
    vi.advanceTimersByTime(5000); // charged: must not keep firing
    expect(calls).toBe(afterCharge);
    stop();
  });

  it('stops polling once stopped', () => {
    openAtLoad();
    let calls = 0;
    const stop = watchDevtools(() => {
      calls++;
      return false;
    });
    vi.advanceTimersByTime(2000);
    const seen = calls;
    stop();
    vi.advanceTimersByTime(5000);
    expect(calls).toBe(seen);
  });
});
