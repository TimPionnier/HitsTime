import { describe, it, expect } from 'vitest';
import { RateLimiter, isTransientDeezerError } from './rateLimit';

/** Virtual clock, so the 5-second window can be tested without waiting for it. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    get time() {
      return t;
    },
  };
}

describe('RateLimiter', () => {
  it('lets a burst through up to the ceiling without waiting', async () => {
    const c = fakeClock();
    const l = new RateLimiter({ windowMs: 5000, max: 45, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 45; i++) await l.acquire();
    expect(c.time).toBe(0);
    expect(l.inWindow).toBe(45);
  });

  it('never exceeds the ceiling in any window — the bug that broke daily mode', async () => {
    // Boot costs ~44 requests (playlist pagination + the regular-mode prefetch)
    // and a daily used to add 11 more, crossing Deezer's 50-per-5s line. The
    // over-quota ids came back as errors, were read as "no preview", and the
    // player was told the song had none.
    const c = fakeClock();
    const l = new RateLimiter({ windowMs: 5000, max: 45, now: c.now, sleep: c.sleep });
    const issued: number[] = [];
    for (let i = 0; i < 120; i++) {
      await l.acquire();
      issued.push(c.time);
    }
    let worst = 0;
    for (let i = 0; i < issued.length; i++) {
      let n = 0;
      for (let j = i; j < issued.length && issued[j] - issued[i] <= 5000; j++) n++;
      worst = Math.max(worst, n);
    }
    expect(worst).toBeLessThanOrEqual(45);
    expect(worst).toBeLessThan(50); // Deezer's actual limit
  });

  it('waits only until the window slides, not a fixed penalty', async () => {
    const c = fakeClock();
    const l = new RateLimiter({ windowMs: 5000, max: 2, now: c.now, sleep: c.sleep });
    await l.acquire();
    c.advance(4000);
    await l.acquire();
    await l.acquire(); // must wait for the first to age out, ~1s not ~5s
    expect(c.time).toBeGreaterThanOrEqual(5000);
    expect(c.time).toBeLessThan(6000);
  });

  it('frees slots once they age out of the window', async () => {
    const c = fakeClock();
    const l = new RateLimiter({ windowMs: 5000, max: 3, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 3; i++) await l.acquire();
    expect(l.inWindow).toBe(3);
    c.advance(5001);
    expect(l.inWindow).toBe(0);
  });
});

describe('isTransientDeezerError', () => {
  it('retries quota and busy, but not real failures', () => {
    expect(isTransientDeezerError(4)).toBe(true); // Quota limit exceeded
    expect(isTransientDeezerError(700)).toBe(true); // Service busy
    expect(isTransientDeezerError(800)).toBe(false); // no data
    expect(isTransientDeezerError(undefined)).toBe(false);
  });
});
