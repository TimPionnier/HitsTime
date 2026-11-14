/** Points scoring of the daily challenge: higher is better. */

export const PLACEMENT_POINTS = 100;
export const WRONG_PLACEMENT_PENALTY = 25;
export const SPEED_BONUS_MAX = 30;
/** Thinking time at or under which a correct placement earns the full speed bonus. */
export const SPEED_FULL_MS = 5_000;
/** Thinking time at or over which the speed bonus is gone: the length of the clip. */
export const SPEED_ZERO_MS = 30_000;
export const TITLE_POINTS = 10;
export const ARTIST_POINTS = 10;
/** Extra points for a well-placed card whose title and artist were both found. */
export const PERFECT_POINTS = 20;

export type ScoredRound = {
  correct: boolean;
  thinkMs: number;
  titleFound?: boolean;
  artistFound?: boolean;
};

export type RoundPoints = {
  placement: number;
  speed: number;
  guesses: number;
  perfect: number;
  total: number;
};

export type PointsBreakdown = RoundPoints;

/** Linear from the full bonus at SPEED_FULL_MS down to nothing at SPEED_ZERO_MS. */
export function speedBonus(thinkMs: number): number {
  if (thinkMs <= SPEED_FULL_MS) return SPEED_BONUS_MAX;
  if (thinkMs >= SPEED_ZERO_MS) return 0;
  const remaining = (SPEED_ZERO_MS - thinkMs) / (SPEED_ZERO_MS - SPEED_FULL_MS);
  return Math.round(SPEED_BONUS_MAX * remaining);
}

/**
 * Points of one round, split by source. A wrong placement keeps the guess
 * points: a good title or artist is rewarded wherever the card landed, and a
 * missed guess never costs anything.
 */
export function roundPoints(round: ScoredRound): RoundPoints {
  const titlePoints = round.titleFound === true ? TITLE_POINTS : 0;
  const artistPoints = round.artistFound === true ? ARTIST_POINTS : 0;
  const guesses = titlePoints + artistPoints;
  const isPerfect = round.correct && guesses === TITLE_POINTS + ARTIST_POINTS;

  const placement = round.correct ? PLACEMENT_POINTS : -WRONG_PLACEMENT_PENALTY;
  const speed = round.correct ? speedBonus(round.thinkMs) : 0;
  const perfect = isPerfect ? PERFECT_POINTS : 0;

  return { placement, speed, guesses, perfect, total: placement + speed + guesses + perfect };
}

/** Sum over the rounds, never below zero. */
export function pointsBreakdown(rounds: ScoredRound[]): PointsBreakdown {
  const sum = rounds.map(roundPoints).reduce(
    (acc, r) => ({
      placement: acc.placement + r.placement,
      speed: acc.speed + r.speed,
      guesses: acc.guesses + r.guesses,
      perfect: acc.perfect + r.perfect,
      total: acc.total + r.total,
    }),
    { placement: 0, speed: 0, guesses: 0, perfect: 0, total: 0 },
  );
  return { ...sum, total: Math.max(0, sum.total) };
}

export function totalPoints(rounds: ScoredRound[]): number {
  return pointsBreakdown(rounds).total;
}
