import { describe, it, expect } from 'vitest';
import {
  ALGO_VERSION,
  CARDS_PER_DAY,
  CYCLE_DAYS,
  EPOCH,
  ROUNDS,
  challengeFor,
  dateForDayIndex,
  dayIndexFor,
  interiorPlacements,
  localDateISO,
  startDailyGame,
  toGameTrack,
  type DailyPool,
} from './daily';
import { placeAt, validate, nextRound, correctIndexFor } from './game';
import poolV1 from '../daily/pools/pool-v1.json';
import golden from './daily.golden.json';
import { POOL_REGISTRY, poolVersionFor } from '../daily/pools/registry';

/**
 * Imported statically rather than through a loader. The browser-side pool
 * loader was deleted with Phase 1 of the anti-cheat work (the pool must not be
 * reachable from the client bundle); tests are not bundled, so a direct import
 * is both safe and simpler.
 */
const POOLS: Record<number, unknown> = { 1: poolV1 };
const loadPool = async (version: number) => {
  const p = POOLS[version];
  if (!p) throw new Error(`Test pool v${version} not imported in daily.test.ts`);
  return p;
};

const pool = poolV1 as DailyPool;

/** Mean draw count across tracks whose year holds a matching number of tracks. */
function avgFor(
  p: DailyPool,
  counts: Map<string, number>,
  perYear: Map<number, number>,
  match: (tracksSharingTheYear: number) => boolean,
): number {
  const vals = p.tracks
    .filter((t) => match(perYear.get(t.year) ?? 1))
    .map((t) => counts.get(t.id) ?? 0);
  return vals.reduce((s, x) => s + x, 0) / vals.length;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

describe('localDateISO', () => {
  it('uses the LOCAL calendar date, not UTC', () => {
    // 23:30 local on the 15th. toISOString() would report the 16th for any
    // timezone ahead of UTC — the single most likely real bug in daily mode.
    const d = new Date(2026, 9, 15, 23, 30, 0);
    expect(localDateISO(d)).toBe('2026-10-15');
  });

  it('pads single-digit months and days', () => {
    expect(localDateISO(new Date(2027, 0, 5))).toBe('2027-01-05');
  });
});

describe('dayIndexFor', () => {
  it('makes the epoch day 1', () => {
    expect(dayIndexFor(EPOCH)).toBe(1);
  });

  it('is stable across DST transitions', () => {
    // Europe: clocks go back 2026-10-25. A naive ms/86400000 would drift here
    // because that local day is 25 hours long.
    expect(dayIndexFor('2026-10-26') - dayIndexFor('2026-10-24')).toBe(2);
    // North America: clocks go forward 2027-03-14 (a 23-hour day).
    expect(dayIndexFor('2027-03-15') - dayIndexFor('2027-03-13')).toBe(2);
  });

  it('round-trips with dateForDayIndex', () => {
    for (const i of [1, 2, 14, 15, 365, 366, 1000, 3650]) {
      expect(dayIndexFor(dateForDayIndex(i))).toBe(i);
    }
  });

  /**
   * dateForDayIndex used to read its result back with localDateISO, which gave
   * the LOCAL date of a UTC-midnight instant — the day before, everywhere west
   * of Greenwich. Day 1 then scored as index 0 and fell outside the archive.
   * This suite runs in whatever zone CI happens to use, so the regression is
   * pinned explicitly rather than left to the runner's TZ.
   */
  it('is timezone-independent', () => {
    expect(dateForDayIndex(1)).toBe(EPOCH);
    for (const i of [1, 2, 14, 400]) {
      const iso = dateForDayIndex(i);
      expect(iso, `day ${i}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Same wall-clock day whichever side of UTC the runner sits on.
      expect(new Date(`${iso}T00:00:00Z`).getUTCDate()).toBe(Number(iso.slice(8, 10)));
    }
  });

  it('counts a leap day', () => {
    expect(dayIndexFor('2028-03-01') - dayIndexFor('2028-02-28')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The pool snapshot
// ---------------------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Every registered pool gets the same guards, so shipping v3 inherits them.
describe.each(POOL_REGISTRY.map((e) => e.version))('pool v%i snapshot', (version) => {
  it('matches its recorded contentHash', async () => {
    // A pool file is immutable: editing one silently rewrites every past
    // challenge that used it. This test is the guard.
    const p = (await loadPool(version)) as DailyPool;
    expect(await sha256Hex(JSON.stringify(p.tracks))).toBe(p.contentHash);
  });

  it('is sorted by id and free of duplicates', async () => {
    const p = (await loadPool(version)) as DailyPool;
    const ids = p.tracks.map((t) => t.id);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has enough variety to feed the constrained draw', async () => {
    const p = (await loadPool(version)) as DailyPool;
    expect(p.tracks.length).toBeGreaterThanOrEqual(CYCLE_DAYS * CARDS_PER_DAY);
    expect(new Set(p.tracks.map((t) => t.year)).size).toBeGreaterThanOrEqual(25);
    expect(new Set(p.tracks.map((t) => t.decade)).size).toBeGreaterThanOrEqual(8);
  });
});

describe('pool registry', () => {
  it('routes every date to the pool in force on it', () => {
    // Derived from the registry rather than hardcoded, so this keeps working
    // when v2 ships.
    for (const epoch of POOL_REGISTRY) {
      expect(poolVersionFor(epoch.activeFrom)).toBe(epoch.version); // inclusive
      const dayBefore = dateForDayIndex(dayIndexFor(epoch.activeFrom) - 1);
      if (dayIndexFor(dayBefore) >= 1) {
        expect(poolVersionFor(dayBefore)).toBeLessThan(epoch.version);
      }
    }
    expect(poolVersionFor('2099-01-01')).toBe(POOL_REGISTRY[POOL_REGISTRY.length - 1].version);
  });

  it('is append-only and ordered — a later version never predates an earlier one', () => {
    for (let i = 1; i < POOL_REGISTRY.length; i++) {
      expect(POOL_REGISTRY[i].version).toBeGreaterThan(POOL_REGISTRY[i - 1].version);
      expect(POOL_REGISTRY[i].activeFrom > POOL_REGISTRY[i - 1].activeFrom).toBe(true);
    }
  });

  it('keeps every golden date on the pool it was generated with', async () => {
    // The archive guarantee: adding songs later must never move a day that has
    // already been played.
    for (const date of Object.keys(golden)) {
      const version = poolVersionFor(date);
      const c = await challengeFor(date, (await loadPool(version)) as DailyPool);
      expect([c.anchor, ...c.draw].map((t) => t.id).join(','), date).toBe(
        (golden as Record<string, string>)[date],
      );
    }
  });

  it('starts the archive today — day 1 is the epoch and nothing precedes it', () => {
    expect(dayIndexFor(EPOCH)).toBe(1);
    expect(POOL_REGISTRY[0].activeFrom).toBe(EPOCH);
  });
});

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

describe('challengeFor', () => {
  it('deals an anchor plus exactly 10 scored rounds', async () => {
    const c = await challengeFor(EPOCH, pool);
    expect(c.draw).toHaveLength(ROUNDS);
    expect(c.dayIndex).toBe(1);
    expect(c.algoVersion).toBe(ALGO_VERSION);
    expect(c.poolVersion).toBe(pool.version);
  });

  it('is deterministic — same date, same ordered ids', async () => {
    const a = await challengeFor('2026-11-03', pool);
    const b = await challengeFor('2026-11-03', pool);
    // Ordered, not a set: the draw order IS the difficulty, so a reshuffle
    // between players would silently destroy comparability.
    expect(b.draw.map((t) => t.id)).toEqual(a.draw.map((t) => t.id));
    expect(b.anchor.id).toBe(a.anchor.id);
    expect(b.seedHex).toBe(a.seedHex);
  });

  it('gives every card of a day a distinct year', async () => {
    for (let i = 1; i <= 120; i++) {
      const c = await challengeFor(dateForDayIndex(i), pool);
      const years = [c.anchor, ...c.draw].map((t) => t.year);
      expect(new Set(years).size, `day ${i}`).toBe(CARDS_PER_DAY);
    }
  });

  it('never repeats a track inside a 14-day cycle', async () => {
    for (let cycle = 0; cycle < 6; cycle++) {
      const seen = new Set<string>();
      for (let slot = 0; slot < CYCLE_DAYS; slot++) {
        const c = await challengeFor(dateForDayIndex(cycle * CYCLE_DAYS + slot + 1), pool);
        for (const t of [c.anchor, ...c.draw]) {
          expect(seen.has(t.id), `dup ${t.id} in cycle ${cycle}`).toBe(false);
          seen.add(t.id);
        }
      }
    }
  });

  it('clears the difficulty floor on every day', async () => {
    for (let i = 1; i <= 120; i++) {
      const c = await challengeFor(dateForDayIndex(i), pool);
      // If every card slotted at an end of the timeline the puzzle would be
      // free, so a minimum number must land strictly inside.
      expect(interiorPlacements([c.anchor, ...c.draw]), `day ${i}`).toBeGreaterThanOrEqual(4);
    }
  });

  it('produces no duplicate challenge over 3 years', async () => {
    const seen = new Set<string>();
    for (let i = 1; i <= 1095; i++) {
      const c = await challengeFor(dateForDayIndex(i), pool);
      const key = [c.anchor, ...c.draw].map((t) => t.id).sort().join(',');
      expect(seen.has(key), `day ${i} repeats an earlier set`).toBe(false);
      seen.add(key);
    }
  });

  it('draws every track, with only a mild bias from the distinct-year rule', async () => {
    const counts = new Map<string, number>();
    const days = 1095;
    for (let i = 1; i <= days; i++) {
      const c = await challengeFor(dateForDayIndex(i), pool);
      for (const t of [c.anchor, ...c.draw]) counts.set(t.id, (counts.get(t.id) ?? 0) + 1);
    }

    // Every track must appear. A starved track would mean the walk is biased by
    // pool order rather than by the seed.
    expect(counts.size).toBe(pool.tracks.length);

    const mean = (days * CARDS_PER_DAY) / pool.tracks.length;
    const used = [...counts.values()];
    expect(Math.min(...used)).toBeGreaterThan(mean * 0.4);
    expect(Math.max(...used)).toBeLessThan(mean * 1.6);

    // The systematic check. Only one track per year can be drawn per day, so a
    // track sharing its year with many others is reached less often than one
    // alone in its year. That bias is inherent to the invariant; what matters
    // is that it stays mild — measured at ~21% across the real pool — rather
    // than growing until crowded years are effectively excluded.
    const perYear = new Map<number, number>();
    for (const t of pool.tracks) perYear.set(t.year, (perYear.get(t.year) ?? 0) + 1);
    const crowdedAvg = avgFor(pool, counts, perYear, (n) => n >= 10);
    const sparseAvg = avgFor(pool, counts, perYear, (n) => n <= 3);
    expect(crowdedAvg).toBeGreaterThan(sparseAvg * 0.7);
  });

  it('rejects dates before the epoch', async () => {
    await expect(challengeFor('2026-08-31', pool)).rejects.toThrow(/epoch/);
  });
});

// ---------------------------------------------------------------------------
// Golden fixture — the strongest single guard.
// Catches pool mutation, algorithm drift, timezone regressions and any stray
// reshuffle at once. Regenerate ONLY when deliberately shipping a new
// ALGO_VERSION; a surprise failure here means the archive just changed.
// ---------------------------------------------------------------------------

describe('golden fixture', () => {
  it('matches the recorded ordered draw for known dates', async () => {
    for (const [date, expected] of Object.entries(golden)) {
      const c = await challengeFor(date, pool);
      expect([c.anchor, ...c.draw].map((t) => t.id).join(','), date).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Dealing and scoring
// ---------------------------------------------------------------------------

describe('startDailyGame', () => {
  it('preserves the given order instead of shuffling', () => {
    const cards = pool.tracks.slice(0, 11).map(toGameTrack);
    const s = startDailyGame(cards);
    expect(s.timeline[0].id).toBe(cards[0].id);
    expect(s.mystery!.id).toBe(cards[1].id);
    expect(s.deck.map((t) => t.id)).toEqual(cards.slice(2).map((t) => t.id));
  });
});

describe("validate with onError: 'continue'", () => {
  const cards = [
    { id: 'a', title: 'A', artist: 'X', year: 1970 },
    { id: 'b', title: 'B', artist: 'Y', year: 1990 },
    { id: 'c', title: 'C', artist: 'Z', year: 1980 },
  ];

  it('inserts a misplaced card at its CORRECT index, in red', () => {
    let s = startDailyGame(cards);          // timeline [1970], mystery 1990
    s = placeAt(s, 0);                      // wrong: 1990 before 1970
    s = validate(s, 'continue');

    expect(s.phase).toBe('revealing');
    expect(s.errors).toBe(1);
    expect(s.wrongIds).toEqual(['b']);
    expect(s.score).toBe(0);
    // Inserted where it belonged, not where the player put it — so the
    // timeline stays genuinely sorted and later rounds are unaffected.
    expect(s.timeline.map((t) => t.year)).toEqual([1970, 1990]);
  });

  it('advances instead of ending the run', () => {
    let s = startDailyGame(cards);
    s = placeAt(s, 0);
    s = validate(s, 'continue');
    s = nextRound(s, 'continue');
    expect(s.phase).toBe('listening');
    expect(s.mystery!.id).toBe('c');
  });

  it('freezes the streak at the first error but keeps scoring', () => {
    let s = startDailyGame(cards);
    s = validate(placeAt(s, 0), 'continue');   // wrong
    s = nextRound(s, 'continue');
    s = validate(placeAt(s, 1), 'continue');   // 1980 between 1970 and 1990 — right
    expect(s.errors).toBe(1);
    expect(s.score).toBe(1);
    expect(s.streak).toBe(0);                  // frozen, not resumed
  });

  it('leaves the sudden-death default untouched', () => {
    let s = startDailyGame(cards);
    s = validate(placeAt(s, 0));               // default 'end'
    expect(nextRound(s).phase).toBe('gameOver');
    expect(s.errors).toBe(0);
  });
});

describe('a perfect daily run', () => {
  it('reaches 10 correct placements with no errors', async () => {
    const c = await challengeFor('2026-10-07', pool);
    let s = startDailyGame([c.anchor, ...c.draw].map(toGameTrack));
    for (let round = 0; round < ROUNDS; round++) {
      const idx = correctIndexFor(s.timeline, s.mystery!.year);
      s = validate(placeAt(s, idx), 'continue');
      s = nextRound(s, 'continue');
    }
    expect(s.phase).toBe('cleared');
    expect(s.score).toBe(ROUNDS);
    expect(s.errors).toBe(0);
    expect(s.streak).toBe(ROUNDS);
    expect(s.timeline).toHaveLength(CARDS_PER_DAY);
  });

  it('still reaches round 10 when every placement is wrong', async () => {
    const c = await challengeFor('2026-10-08', pool);
    let s = startDailyGame([c.anchor, ...c.draw].map(toGameTrack));
    for (let round = 0; round < ROUNDS; round++) {
      const right = correctIndexFor(s.timeline, s.mystery!.year);
      s = validate(placeAt(s, right === 0 ? s.timeline.length : 0), 'continue');
      s = nextRound(s, 'continue');
    }
    expect(s.phase).toBe('cleared');
    expect(s.errors).toBe(ROUNDS);
    expect(s.streak).toBe(0);
    // Even after ten mistakes the timeline is sorted: errors never cascade.
    const years = s.timeline.map((t) => t.year);
    expect([...years].sort((a, b) => a - b)).toEqual(years);
  });
});
