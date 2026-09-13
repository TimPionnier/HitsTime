/**
 * Reading the global numbers back.
 *
 * Separate from analytics.ts on purpose: that file only ever writes and must
 * never be awaited, this one only reads and is allowed to be slow. Mixing them
 * would invite a "while we're here" await on the game path.
 *
 * Everything here is decoration. If the endpoint is unset, unreachable, slow,
 * or returns something unexpected, every consumer gets `null` and renders
 * nothing at all — not a spinner, not a dash. A placeholder on an end screen
 * reads as "broken"; absence reads as "that feature isn't here", which is the
 * truth.
 */

const API = String(import.meta.env.VITE_ANALYTICS_URL ?? '').replace(/\/+$/, '');

const TIMEOUT_MS = 4_000;

export interface Histogram {
  v: number;
  /** Exclusive upper bounds, ascending. `counts` is one longer. */
  edges: number[];
  counts: number[];
}

export interface GlobalStats {
  mode: string;
  scope: string | null;
  direction: 'min' | 'max';
  plays: number;
  finishes: number;
  cleared: number;
  /**
   * An ESTIMATE, and null for a scope-qualified query.
   *
   * Named `_est` on purpose: two devices count as two people, one NAT counts as
   * one. Never relabel this as "players". See docs/analytics-architecture.md §1.2.
   */
  visitors_est: number | null;
  /** Null until the server's sample floor is met. */
  avg: number | null;
  n: number;
  min_sample: number;
  peeked: number;
  buckets: Histogram | null;
}

/**
 * One in-flight promise per key, for the life of the page.
 *
 * The menu renders three mode cards and the end screen asks again; without
 * this, walking back and forth between them would refetch each time. A failed
 * lookup IS cached: a player whose network is down should not retry on every
 * render, and these numbers are not worth a retry loop.
 */
const cache = new Map<string, Promise<GlobalStats | null>>();

function keyFor(mode: string, scope?: string | null): string {
  return scope ? `${mode}:${scope}` : mode;
}

/** Defensive parse. This is data off the network; nothing is assumed. */
function parse(data: unknown): GlobalStats | null {
  if (data === null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;

  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const direction = d.direction === 'min' || d.direction === 'max' ? d.direction : null;
  if (typeof d.mode !== 'string' || direction === null) return null;

  let buckets: Histogram | null = null;
  const b = d.buckets;
  if (b !== null && typeof b === 'object') {
    const bb = b as Record<string, unknown>;
    if (
      Array.isArray(bb.edges) &&
      Array.isArray(bb.counts) &&
      bb.edges.every((e) => typeof e === 'number') &&
      bb.counts.every((c) => typeof c === 'number') &&
      // The overflow bin must exist, or a high score has nowhere to sit and
      // every percentile computed from this is wrong at the top end.
      bb.counts.length === bb.edges.length + 1
    ) {
      buckets = { v: num(bb.v), edges: bb.edges as number[], counts: bb.counts as number[] };
    }
  }

  return {
    mode: d.mode,
    scope: typeof d.scope === 'string' ? d.scope : null,
    direction,
    plays: num(d.plays),
    finishes: num(d.finishes),
    cleared: num(d.cleared),
    visitors_est: typeof d.visitors_est === 'number' ? d.visitors_est : null,
    avg: typeof d.avg === 'number' && Number.isFinite(d.avg) ? d.avg : null,
    n: num(d.n),
    min_sample: num(d.min_sample),
    peeked: num(d.peeked),
    buckets,
  };
}

async function get(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Live numbers, or the static snapshot, or nothing.
 *
 * The snapshot is optional and is NOT committed to this repo — a checked-in
 * file of invented numbers would be worse than no numbers. A scheduled job can
 * write `public/stats.json` from the Worker so the common read path is pure CDN
 * and the game degrades gracefully when the Worker is unreachable; until
 * something writes it, the 404 simply falls through to `null`.
 */
export function fetchStats(mode: string, scope?: string | null): Promise<GlobalStats | null> {
  const key = keyFor(mode, scope);
  const hit = cache.get(key);
  if (hit) return hit;

  const load = (async (): Promise<GlobalStats | null> => {
    if (API) {
      try {
        const q = new URLSearchParams({ mode });
        if (scope) q.set('scope', scope);
        const live = parse(await get(`${API}/v1/stats?${q.toString()}`));
        if (live) return live;
      } catch {
        /* fall through to the snapshot */
      }
    }

    try {
      const snapshot = await get(`${import.meta.env.BASE_URL}stats.json`);
      if (snapshot !== null && typeof snapshot === 'object') {
        const byKey = snapshot as Record<string, unknown>;
        return parse(byKey[key] ?? byKey[mode]);
      }
    } catch {
      /* nothing to show, which is a fine outcome */
    }
    return null;
  })();

  cache.set(key, load);
  return load;
}

/**
 * Share of players this score beats, 0..1, or null.
 *
 * This is what replaces a global best score. A histogram cannot say where
 * inside a bin a run sits, so the run's own bin counts half — the standard
 * midpoint convention, and the reason this is an estimate rather than a rank.
 *
 * Clamped to [0.01, 0.99] for display honesty: "faster than 100% of players"
 * is a claim about the whole population that a 300-sample histogram cannot
 * support, and "0%" is a needlessly brutal way to round.
 */
export function beatShare(
  hist: Histogram,
  score: number,
  direction: 'min' | 'max',
): number | null {
  const total = hist.counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;

  // Mirrors bucketOf() in the Worker: first edge strictly greater than the
  // score wins, else the overflow bin.
  let bin = hist.edges.length;
  for (let i = 0; i < hist.edges.length; i++) {
    if (score < hist.edges[i]) {
      bin = i;
      break;
    }
  }

  let beaten = 0;
  for (let i = 0; i < hist.counts.length; i++) {
    // 'min': a HIGHER bin is a slower run, so those are the ones beaten.
    const worse = direction === 'min' ? i > bin : i < bin;
    if (worse) beaten += hist.counts[i];
  }
  beaten += hist.counts[bin] / 2;

  return Math.min(0.99, Math.max(0.01, beaten / total));
}

/** Test seam: the per-key cache is module state. */
export function __clearStatsCache(): void {
  cache.clear();
}
