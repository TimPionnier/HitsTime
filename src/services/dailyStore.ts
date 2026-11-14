/**
 * Per-device record of daily runs.
 *
 * Deliberately its own localStorage key: `hitstime.leaderboard.v1` is a flat
 * array capped at 200 entries, so writing daily results there would evict the
 * player's normal game history.
 */
import { ALGO_VERSION, dateForDayIndex, dayIndexFor, localDateISO } from '../engine/daily';
import { isFullGuess } from '../engine/guess';
import { totalPoints } from '../engine/points';

const KEY = 'hitstime.daily.v1';

/**
 * What one misplacement costs in the time metric still reported to analytics.
 * The worker buckets daily runs as a time (lower is better); the player's own
 * score is the points of `engine/points.ts`.
 */
export const ERROR_PENALTY_MS = 30_000;

export interface DailyRound {
  trackId: string;
  chosenIndex: number;
  correctIndex: number;
  correct: boolean;
  /** Thinking time for this round — reveal animation excluded. */
  thinkMs: number;
  titleFound?: boolean;
  artistFound?: boolean;
}

export interface DailyAttempt {
  date: string;
  poolVersion: number;
  algoVersion: number;
  /** Integrity tag: a mismatch means this result belongs to a different puzzle. */
  seedHex: string;
  status: 'in_progress' | 'finished';
  rounds: DailyRound[];
  errors: number;
  /** Correct placements before the first error. Freezes; never resets. */
  streak: number;
  rawActiveMs: number;
  startedAtEpochMs: number;
  finishedAtEpochMs?: number;
  suspect?: boolean;
}

export interface DailyStats {
  played: number;
  perfect: number;
  currentStreak: number;
  maxStreak: number;
  /** Histogram of `errors`, index 0..10. */
  distribution: number[];
  bestPoints: number | null;
}

interface Persisted {
  attempts: Record<string, DailyAttempt>;
}

function read(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { attempts: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.attempts !== 'object') {
      return { attempts: {} };
    }
    // Drop attempts for dates that are no longer part of the archive. Moving
    // EPOCH (only ever legitimate pre-launch) orphans earlier records, and
    // leaving them in would inflate the played count and the day streak with
    // days that no longer exist.
    const attempts: Record<string, DailyAttempt> = {};
    for (const [date, a] of Object.entries(parsed.attempts as Record<string, DailyAttempt>)) {
      if (dayIndexFor(date) >= 1) attempts[date] = a;
    }
    return { attempts };
  } catch {
    return { attempts: {} };
  }
}

function write(data: Persisted): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // storage unavailable (private mode, quota) — the run still plays, it just
    // isn't remembered.
  }
}

export function allAttempts(): Record<string, DailyAttempt> {
  return read().attempts;
}

export function getAttempt(date: string): DailyAttempt | null {
  return read().attempts[date] ?? null;
}

export function saveAttempt(attempt: DailyAttempt): void {
  const data = read();
  data.attempts[attempt.date] = attempt;
  write(data);
}

/** Round number shown on the anchor card, which is dealt face up and never answered. */
export const ANCHOR_ROUND = 0;

/** Play order (1-based) of each answered track; the anchor card is never in `rounds`. */
export function roundNumbersFor(rounds: DailyRound[]): Map<string, number> {
  return new Map(rounds.map((r, index) => [r.trackId, index + 1]));
}

export function roundOf(numbers: Map<string, number>, trackId: string): number {
  return numbers.get(trackId) ?? ANCHOR_ROUND;
}

/** Cards shown in gold: well placed, with title and artist both found. */
export function perfectTrackIds(rounds: DailyRound[]): Set<string> {
  return new Set(
    rounds.filter((round) => round.correct && isFullGuess(round)).map((round) => round.trackId),
  );
}

/** The player's score: derived from the rounds, so it can never drift from them. */
export function pointsOf(attempt: Pick<DailyAttempt, 'rounds'>): number {
  return totalPoints(attempt.rounds);
}

/** Time metric sent to analytics, which still buckets daily runs as a duration. */
export function analyticsTimeMs(rawActiveMs: number, errors: number): number {
  return rawActiveMs + errors * ERROR_PENALTY_MS;
}

/**
 * A human cannot hear a clip and place a card in under 400ms, ten times over.
 * Flagged, never discarded — a local record is the player's own, and this only
 * matters once results are shared.
 */
export function isSuspect(rounds: DailyRound[], rawActiveMs: number): boolean {
  if (rounds.length === 0) return false;
  if (rounds.every((r) => r.thinkMs < 400)) return true;
  return rounds.length >= 10 && rawActiveMs < 10_000;
}

export function statsFrom(attempts: Record<string, DailyAttempt>): DailyStats {
  const finished = Object.values(attempts).filter((a) => a.status === 'finished');
  const distribution = new Array(11).fill(0) as number[];
  let perfect = 0;
  let best: number | null = null;

  for (const a of finished) {
    if (a.errors >= 0 && a.errors <= 10) distribution[a.errors]++;
    if (a.errors === 0) perfect++;
    const points = pointsOf(a);
    if (best === null || points > best) best = points;
  }

  // Streak = consecutive days played, walking back from the most recent day
  // that has a finished attempt.
  const played = new Set(finished.map((a) => a.date));
  const todayIdx = dayIndexFor(localDateISO());
  let current = 0;
  let cursor = played.has(localDateISO()) ? todayIdx : todayIdx - 1;
  while (cursor >= 1 && played.has(dateForDayIndex(cursor))) {
    current++;
    cursor--;
  }

  let max = 0;
  let run = 0;
  const indices = [...played].map(dayIndexFor).sort((a, b) => a - b);
  for (let i = 0; i < indices.length; i++) {
    run = i > 0 && indices[i] === indices[i - 1] + 1 ? run + 1 : 1;
    if (run > max) max = run;
  }

  return {
    played: finished.length,
    perfect,
    currentStreak: current,
    maxStreak: max,
    distribution,
    bestPoints: best,
  };
}

export function newAttempt(
  date: string,
  poolVersion: number,
  seedHex: string,
): DailyAttempt {
  return {
    date,
    poolVersion,
    algoVersion: ALGO_VERSION,
    seedHex,
    status: 'in_progress',
    rounds: [],
    errors: 0,
    streak: 0,
    rawActiveMs: 0,
    startedAtEpochMs: Date.now(),
  };
}

/** mm:ss, used everywhere a duration is shown. */
export function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
