import type { DailyPool } from '../../engine/daily';

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
];

export function poolVersionFor(dateISO: string): number {
  let chosen = POOL_REGISTRY[0];
  for (const epoch of POOL_REGISTRY) {
    if (epoch.activeFrom <= dateISO && epoch.activeFrom >= chosen.activeFrom) chosen = epoch;
  }
  return chosen.version;
}

const cache = new Map<number, Promise<DailyPool>>();

/**
 * Loaded on demand so a decade of snapshots never lands in the main bundle —
 * only the versions a player actually opens are fetched.
 */
export function loadPool(version: number): Promise<DailyPool> {
  let p = cache.get(version);
  if (!p) {
    p = import(`./pool-v${version}.json`).then((m) => (m.default ?? m) as DailyPool);
    cache.set(version, p);
  }
  return p;
}

export function loadPoolForDate(dateISO: string): Promise<DailyPool> {
  return loadPool(poolVersionFor(dateISO));
}
