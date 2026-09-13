/**
 * Score histograms.
 *
 * Why a histogram at all: it is the only shape that answers "am I any good?"
 * without storing one row per run. From fixed buckets the client derives a
 * percentile locally — "faster than 72% of players today" — which is the
 * motivating number a leaderboard would have given, minus the part where one
 * forged entry ruins it permanently.
 *
 * BUCKETS_V IS A ONE-WAY DOOR. Moving an edge silently re-slices history, and a
 * pre-change percentile compared against a post-change one is a fake trend —
 * the same family of mistake as changing the error penalty and re-ranking the
 * archive (daily-challenge-architecture.md §17). Bump the version, never edit
 * the edges: rows carry their version and are never merged across versions.
 */

export const BUCKETS_V = 1;

export interface BucketSpec {
  v: number;
  /**
   * Upper bounds, exclusive, ascending. `counts` therefore has edges.length + 1
   * entries: the last one is the overflow bin, which must exist — a score above
   * every edge is otherwise silently dropped.
   */
  edges: number[];
}

/** Daily is scored in milliseconds and LOWER is better. */
const DAILY_EDGES_MS = [
  20_000, 30_000, 45_000, 60_000, 75_000, 90_000, 105_000, 120_000, 150_000, 180_000, 210_000,
  240_000, 300_000, 360_000, 450_000, 600_000, 900_000, 1_800_000,
];

/**
 * The free-play modes score in points, where a run ends on the first mistake —
 * so the distribution is dense at the low end and has a long, thin tail.
 */
const POINT_EDGES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100];

export function bucketSpecFor(mode: string): BucketSpec {
  return { v: BUCKETS_V, edges: mode === 'daily' ? DAILY_EDGES_MS : POINT_EDGES };
}

/** Number of bins in a spec, overflow included. */
export function bucketCount(spec: BucketSpec): number {
  return spec.edges.length + 1;
}

/**
 * Which bin a score falls in.
 *
 * Clamped rather than rejected: a score outside the plausible range is refused
 * earlier, at the API boundary, where it can be reported as a bad request. By
 * the time it reaches here it must land somewhere.
 */
export function bucketOf(spec: BucketSpec, value: number): number {
  for (let i = 0; i < spec.edges.length; i++) {
    if (value < spec.edges[i]) return i;
  }
  return spec.edges.length;
}
