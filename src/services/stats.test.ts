import { afterEach, describe, expect, it, vi } from 'vitest';

import { __clearStatsCache, beatShare, fetchStats, type Histogram } from './stats';

afterEach(() => {
  __clearStatsCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Four bins: edges 10/20/30 plus the overflow. */
function hist(counts: number[]): Histogram {
  return { v: 1, edges: [10, 20, 30], counts };
}

describe('beatShare — lower is better (daily)', () => {
  it('rates the fastest bin near the top', () => {
    // 100 players: 10 fast, 90 slower. A fast run beats the 90 plus half its own.
    const share = beatShare(hist([10, 90, 0, 0]), 5, 'min');
    expect(share).toBeCloseTo(0.95, 5);
  });

  it('rates the slowest bin near the bottom', () => {
    const share = beatShare(hist([90, 10, 0, 0]), 15, 'min');
    expect(share).toBeCloseTo(0.05, 5);
  });

  it('places a bin at its own midpoint, not at its edge', () => {
    // Uniform 25/25/25/25, a run in bin 1: it beats bins 2 and 3 outright (50)
    // plus half of its own bin (12.5). 62.5%, NOT 50% — the bin's midpoint is
    // at the 37.5th percentile from the fast end.
    expect(beatShare(hist([25, 25, 25, 25]), 15, 'min')).toBeCloseTo(0.625, 5);
    // And the bin below it, symmetrically.
    expect(beatShare(hist([25, 25, 25, 25]), 25, 'min')).toBeCloseTo(0.375, 5);
  });

  it('handles the overflow bin', () => {
    // A run past every edge beats nobody, so the clamp is what shows.
    expect(beatShare(hist([40, 40, 19, 1]), 10_000, 'min')).toBe(0.01);
  });

  it('uses the same edge convention as the Worker', () => {
    // 10 is the first edge, so it belongs to bin 1, not bin 0.
    const atEdge = beatShare(hist([50, 50, 0, 0]), 10, 'min');
    const belowEdge = beatShare(hist([50, 50, 0, 0]), 9, 'min');
    expect(atEdge).toBeCloseTo(0.25, 5);
    expect(belowEdge).toBeCloseTo(0.75, 5);
  });
});

describe('beatShare — higher is better (points)', () => {
  it('inverts the comparison', () => {
    // Same shape as the daily case, opposite meaning: a LOW score now loses.
    expect(beatShare(hist([10, 90, 0, 0]), 5, 'max')).toBeCloseTo(0.05, 5);
    expect(beatShare(hist([90, 10, 0, 0]), 15, 'max')).toBeCloseTo(0.95, 5);
  });
});

describe('beatShare — guards', () => {
  it('returns null on an empty histogram', () => {
    expect(beatShare(hist([0, 0, 0, 0]), 5, 'min')).toBeNull();
  });

  it('never claims 0% or 100%', () => {
    // A single-bin population would otherwise produce absolutes a sample of
    // this size cannot support.
    expect(beatShare(hist([1, 0, 0, 0]), 5, 'min')).toBeLessThanOrEqual(0.99);
    expect(beatShare(hist([0, 0, 0, 1]), 5, 'min')).toBeGreaterThanOrEqual(0.01);
    expect(beatShare(hist([0, 0, 0, 1]), 5, 'min')).toBeLessThanOrEqual(0.99);
  });
});

describe('fetchStats', () => {
  async function configured() {
    vi.resetModules();
    __clearStatsCache();
    vi.stubEnv('VITE_ANALYTICS_URL', 'https://api.example.test');
    return import('./stats');
  }

  const payload = {
    mode: 'daily',
    scope: 'd:2026-09-13',
    direction: 'min',
    plays: 340,
    finishes: 301,
    cleared: 301,
    visitors_est: 312,
    avg: 138_000,
    n: 301,
    min_sample: 30,
    peeked: 4,
    buckets: { v: 1, edges: [10, 20, 30], counts: [1, 2, 3, 4] },
  };

  it('returns null with nothing configured and no snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('not found', { status: 404 }))),
    );
    expect(await fetchStats('daily', 'd:2026-09-13')).toBeNull();
  });

  it('parses a live response', async () => {
    const mod = await configured();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload)))),
    );
    const stats = await mod.fetchStats('daily', 'd:2026-09-13');
    expect(stats?.avg).toBe(138_000);
    expect(stats?.visitors_est).toBe(312);
    expect(stats?.buckets?.counts).toEqual([1, 2, 3, 4]);
  });

  it('asks only once per key', async () => {
    const mod = await configured();
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload))));
    vi.stubGlobal('fetch', fetchSpy);

    await Promise.all([
      mod.fetchStats('daily', 'd:2026-09-13'),
      mod.fetchStats('daily', 'd:2026-09-13'),
      mod.fetchStats('daily', 'd:2026-09-13'),
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null rather than throwing when the network fails', async () => {
    const mod = await configured();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    await expect(mod.fetchStats('daily', 'd:2026-09-13')).resolves.toBeNull();
  });

  it('rejects a histogram whose bins do not line up', async () => {
    const mod = await configured();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ...payload, buckets: { v: 1, edges: [10, 20], counts: [1, 2, 3, 4] } }),
          ),
        ),
      ),
    );
    // The counters are still usable; only the broken histogram is dropped.
    const stats = await mod.fetchStats('daily', 'd:2026-09-13');
    expect(stats?.plays).toBe(340);
    expect(stats?.buckets).toBeNull();
  });

  it('rejects a response that is not stats at all', async () => {
    const mod = await configured();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ hello: 'world' })))),
    );
    expect(await mod.fetchStats('daily', 'd:2026-09-13')).toBeNull();
  });

  it('falls back to the static snapshot when the live call fails', async () => {
    const mod = await configured();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.includes('/v1/stats')
          ? Promise.resolve(new Response('nope', { status: 503 }))
          : Promise.resolve(new Response(JSON.stringify({ 'daily:d:2026-09-13': payload }))),
      ),
    );
    const stats = await mod.fetchStats('daily', 'd:2026-09-13');
    expect(stats?.avg).toBe(138_000);
  });
});
