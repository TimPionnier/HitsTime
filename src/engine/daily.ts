/**
 * Daily Challenge — deterministic generation.
 *
 * A challenge is a PURE FUNCTION OF A DATE. Nothing is pre-generated and
 * nothing is stored: day 1 and day 4000 come from the same call, which is what
 * makes the archive possible without a database.
 *
 * That only works if the function is stable forever, so three rules hold:
 *   1. it reads a frozen pool snapshot, never live Deezer data or
 *      date-overrides.json (which a weekly workflow rewrites);
 *   2. it never uses Math.random — every draw comes from a date-seeded PRNG;
 *   3. it is never edited in place. Changing the algorithm means a new
 *      ALGO_VERSION activated from a future date (see pools/registry.ts).
 */

import { correctIndexFor } from './game';
import type { GameState, GameTrack } from './types';

export const ALGO_VERSION = 1;

/**
 * Day 1 of the archive. Nothing before this is playable.
 *
 * DECIDE THIS BEFORE LAUNCH AND NEVER CHANGE IT: every dayIndex is measured
 * from here, so moving it shifts which challenge each date maps to and
 * invalidates every stored attempt and every shared puzzle number.
 */
export const EPOCH = '2026-09-13';

/** Scored placements per run. The anchor card is dealt on top of these. */
export const ROUNDS = 10;

/** Cards drawn per day: 1 face-up anchor + ROUNDS mystery cards. */
export const CARDS_PER_DAY = ROUNDS + 1;

/**
 * Days generated together from one seed. Within a cycle every day draws from
 * the tracks the earlier days did not consume, so **no track can repeat inside
 * a 14-day window**. Across a cycle boundary a repeat is possible — see the
 * note on selectCycle.
 */
export const CYCLE_DAYS = 14;

/** Minimum rounds whose correct slot is strictly inside the timeline. */
const MIN_INTERIOR = 4;

/** Max artists/decade repeats inside one day. */
const MAX_PER_DECADE = 4;

/** Re-roll budget per day before giving up on the difficulty guard. */
const MAX_NONCE = 64;

export interface DailyPoolTrack {
  id: string;
  title: string;
  artist: string;
  year: number;
  decade: number;
  cover?: string;
}

export interface DailyPool {
  version: number;
  contentHash: string;
  /** Sorted by id ascending — the order is part of the determinism contract. */
  tracks: DailyPoolTrack[];
}

export interface DailyChallenge {
  date: string;
  dayIndex: number;
  poolVersion: number;
  algoVersion: number;
  /** First 32 hex chars of the cycle digest — a cheap integrity tag. */
  seedHex: string;
  /** Dealt face-up. Scores nothing; it only anchors the timeline. */
  anchor: DailyPoolTrack;
  /** The 10 scored rounds, in the order every player receives them. */
  draw: DailyPoolTrack[];
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * The player's LOCAL calendar date.
 *
 * Never use toISOString() here: it returns the UTC date, so from ~16:00 local
 * onward every player west of Greenwich would be handed tomorrow's challenge
 * and would see the same one twice.
 */
export function localDateISO(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Both ends anchored at UTC midnight, so DST's 23h and 25h days can't drift the index. */
export function dayIndexFor(dateISO: string): number {
  const at = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(dateISO) - at(EPOCH)) / 86_400_000) + 1;
}

/**
 * Inverse of dayIndexFor.
 *
 * Reads the date back out in UTC, NOT via localDateISO. Day arithmetic is
 * anchored at UTC midnight (see dayIndexFor), and asking for the LOCAL date of
 * that instant lands on the previous day for every player west of Greenwich:
 * in New York, day 1 came back as the day before EPOCH, which dayIndexFor then
 * scored as 0 — outside the archive. The whole calendar was off by one for half
 * the planet, and the round-trip test only passed because CI runs in UTC+.
 */
export function dateForDayIndex(dayIndex: number): string {
  const [y, m, d] = EPOCH.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d + dayIndex - 1));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getUTCFullYear()}-${p(at.getUTCMonth() + 1)}-${p(at.getUTCDate())}`;
}

/** Is this date inside the playable archive (day 1 .. today)? */
export function isPlayableDate(dateISO: string, today = localDateISO()): boolean {
  const i = dayIndexFor(dateISO);
  return i >= 1 && i <= dayIndexFor(today);
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * SHA-256 rather than a hand-rolled string hash: consecutive dates differ by a
 * single character, and a weak hash leaves that correlation in the low bits —
 * neighbouring puzzles then look suspiciously alike. It is also specified
 * identically in the browser, in Node, and in any future server.
 */
export async function cycleSeed(cycle: number, poolVersion: number): Promise<Uint32Array> {
  const msg = `hitstime/daily|algo:${ALGO_VERSION}|pool:${poolVersion}|cycle:${cycle}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
  return new Uint32Array(digest.slice(0, 16));
}

export function seedHexOf(words: Uint32Array): string {
  return Array.from(words, (w) => w.toString(16).padStart(8, '0')).join('');
}

/** splitmix32 — mixes a counter into a seed word with good avalanche. */
function mix(x: number): number {
  let z = x | 0;
  z = (Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0);
  z = (Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0);
  return (z ^ (z >>> 15)) >>> 0;
}

/** sfc32 — small, fast, statistically solid. Warmed up so early draws are unbiased. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  let s0 = a >>> 0, s1 = b >>> 0, s2 = c >>> 0, s3 = d >>> 0;
  const next = () => {
    const t = (((s0 + s1) >>> 0) + s3) >>> 0;
    s3 = (s3 + 1) >>> 0;
    s0 = s1 ^ (s1 >>> 9);
    s1 = (s2 + (s2 << 3)) >>> 0;
    s2 = (s2 << 21) | (s2 >>> 11);
    s2 = (s2 + t) >>> 0;
    return t / 4294967296;
  };
  for (let i = 0; i < 20; i++) next();
  return next;
}

function rngFor(words: Uint32Array, slot: number, nonce: number): () => number {
  return sfc32(
    words[0] ^ mix(slot * 0x9e3779b9),
    words[1] ^ mix(nonce * 0x85ebca6b + 0x165667b1),
    words[2] ^ mix(slot + nonce * 31),
    words[3],
  );
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Fisher-Yates over indices, so the pool array itself is never mutated. */
function shuffledIndices(n: number, rng: () => number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Constraint rungs, in the order constraints are dropped when the walk comes up
 * short. Distinct years are absent from the ladder on purpose: they are a
 * correctness invariant, not a preference.
 */
const RUNGS = [0, 1, 2, 3] as const;
type Rung = (typeof RUNGS)[number];

function walk(
  pool: DailyPoolTrack[],
  order: number[],
  consumed: Set<string>,
  rung: Rung,
): DailyPoolTrack[] | null {
  const picks: DailyPoolTrack[] = [];
  const years = new Set<number>();
  const artists = new Set<string>();
  const decades = new Map<number, number>();

  for (const idx of order) {
    const t = pool[idx];

    // Rung 3 drops the cycle exclusion — last resort, and the only rung that
    // can reintroduce a track already used earlier in the same cycle.
    if (rung < 3 && consumed.has(t.id)) continue;

    // NEVER relaxed. isCorrectPlacement() treats equal years as valid on either
    // side, so a tie would give a card two correct slots and "insert the red
    // card at THE correct index" would have no single answer.
    if (years.has(t.year)) continue;

    if (rung < 2 && artists.has(t.artist)) continue;
    if (rung < 1 && (decades.get(t.decade) ?? 0) >= MAX_PER_DECADE) continue;

    picks.push(t);
    years.add(t.year);
    artists.add(t.artist);
    decades.set(t.decade, (decades.get(t.decade) ?? 0) + 1);
    if (picks.length === CARDS_PER_DAY) return picks;
  }
  return null;
}

/**
 * How many rounds land strictly inside the timeline rather than at an end.
 *
 * In incremental play the draw ORDER is the difficulty: a day whose cards
 * happen to arrive in ascending year order is trivial, because every placement
 * is "at the far right". This is the floor under how easy a day can be.
 */
export function interiorPlacements(cards: DailyPoolTrack[]): number {
  const timeline: GameTrack[] = [toGameTrack(cards[0])];
  let interior = 0;
  for (let i = 1; i < cards.length; i++) {
    const idx = correctIndexFor(timeline, cards[i].year);
    if (idx > 0 && idx < timeline.length) interior++;
    timeline.splice(idx, 0, toGameTrack(cards[i]));
  }
  return interior;
}

/**
 * Generate a whole 14-day cycle at once.
 *
 * Days are drawn in order from the tracks earlier days left behind, which is
 * what guarantees no repeat inside the window. Doing it per-day with a
 * "previous N days" exclusion instead would be recursive — day D would need
 * D-1, which needs D-2, without a base case.
 *
 * The honest limit: two days either side of a cycle boundary are drawn from
 * independent seeds and CAN share a track. With ~320 tracks and 11 per day the
 * expected overlap there is 11x11/320 ~ 0.38 tracks, so roughly one boundary in
 * three shares a single song — about 2.7% of all consecutive-day pairs.
 */
export function selectCycle(pool: DailyPool, words: Uint32Array): DailyPoolTrack[][] {
  const consumed = new Set<string>();
  const days: DailyPoolTrack[][] = [];

  for (let slot = 0; slot < CYCLE_DAYS; slot++) {
    let chosen: DailyPoolTrack[] | null = null;

    // Re-roll until the day clears the difficulty floor.
    for (let nonce = 0; nonce < MAX_NONCE && !chosen; nonce++) {
      const order = shuffledIndices(pool.tracks.length, rngFor(words, slot, nonce));
      for (const rung of RUNGS) {
        const picks = walk(pool.tracks, order, consumed, rung);
        if (picks && interiorPlacements(picks) >= MIN_INTERIOR) {
          chosen = picks;
          break;
        }
        // A relaxed rung that still fails the difficulty floor is worse than a
        // re-roll at rung 0, so only fall through when the walk itself failed.
        if (picks) break;
      }
    }

    // Exhausted the budget: take the first structurally valid draw, difficulty
    // floor or not. Deterministic, and the CI replay asserts it never happens.
    if (!chosen) {
      const order = shuffledIndices(pool.tracks.length, rngFor(words, slot, MAX_NONCE));
      for (const rung of RUNGS) {
        chosen = walk(pool.tracks, order, consumed, rung);
        if (chosen) break;
      }
    }
    if (!chosen) {
      throw new Error(
        `Daily pool v${pool.version} cannot produce ${CARDS_PER_DAY} cards for cycle slot ${slot}.`,
      );
    }

    for (const t of chosen) consumed.add(t.id);
    days.push(chosen);
  }

  return days;
}

/** The challenge for one date. Pure given the pool. */
export async function challengeFor(
  dateISO: string,
  pool: DailyPool,
): Promise<DailyChallenge> {
  const dayIndex = dayIndexFor(dateISO);
  if (dayIndex < 1) throw new Error(`${dateISO} is before the archive epoch ${EPOCH}.`);

  const cycle = Math.floor((dayIndex - 1) / CYCLE_DAYS);
  const slot = (dayIndex - 1) % CYCLE_DAYS;
  const words = await cycleSeed(cycle, pool.version);
  const cards = selectCycle(pool, words)[slot];

  return {
    date: dateISO,
    dayIndex,
    poolVersion: pool.version,
    algoVersion: ALGO_VERSION,
    seedHex: seedHexOf(words).slice(0, 32),
    anchor: cards[0],
    draw: cards.slice(1),
  };
}

// ---------------------------------------------------------------------------
// Bridging to the game engine
// ---------------------------------------------------------------------------

export function toGameTrack(t: DailyPoolTrack): GameTrack {
  return { id: t.id, title: t.title, artist: t.artist, year: t.year, cover: t.cover };
}

/**
 * Deal a daily run.
 *
 * Deliberately NOT startGame(): that one shuffles internally (game.ts), which
 * would hand every player the same 11 songs in a different order — leaving the
 * generation perfectly deterministic while quietly destroying comparability,
 * since a card is far easier to place against a 3-card timeline than a 9-card
 * one. `ordered` is used exactly as given.
 */
export function startDailyGame(ordered: GameTrack[]): GameState {
  if (ordered.length < 2) throw new Error('A daily run needs at least 2 tracks.');
  const [anchor, mystery, ...deck] = ordered;
  return {
    phase: 'listening',
    timeline: [anchor],
    mystery,
    pendingIndex: null,
    score: 0,
    streak: 0,
    errors: 0,
    wrongIds: [],
    deck,
    reveal: null,
  };
}
