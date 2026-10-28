
/**
 * Which frozen pool snapshot governs which dates.
 *
 * APPEND ONLY. A date always resolves to the pool whose `activeFrom` is the
 * latest one on or before it, so adding a version never touches the past:
 * every already-played day keeps regenerating from the snapshot it was played
 * with, byte for byte.
 *
 * To add songs:
 *   1. node scripts/build-daily-pool.mjs 2
 *   2. add { version: 2, activeFrom: <a date a few days out> } below
 *
 * Pick `activeFrom` far enough ahead that every client has picked up the new
 * bundle — a player on a stale cache would otherwise generate a different
 * puzzle from everyone else, silently.
 */
export interface PoolEpoch {
  version: number;
  /** 'YYYY-MM-DD', inclusive. */
  activeFrom: string;
}

export const POOL_REGISTRY: PoolEpoch[] = [
  { version: 1, activeFrom: '2026-09-13' },
  { version: 2, activeFrom: '2026-11-01' },
];

export function poolVersionFor(dateISO: string): number {
  let chosen = POOL_REGISTRY[0];
  for (const epoch of POOL_REGISTRY) {
    if (epoch.activeFrom <= dateISO && epoch.activeFrom >= chosen.activeFrom) chosen = epoch;
  }
  return chosen.version;
}

/**
 * NOTE: there is deliberately no pool loader here any more.
 *
 * `loadPool`/`loadPoolForDate` used to dynamic-import these JSON files into the
 * browser, which shipped all 388 tracks and their years as a 79 KB chunk — the
 * single largest answer leak in the app. Generation now happens at build time
 * (src/build/dailyShards.ts) and the client fetches one day's shard.
 *
 * Do not reintroduce a loader that any module under src/ reachable from
 * main.tsx can import: that is all it would take to put the pool back in the
 * bundle.
 */
