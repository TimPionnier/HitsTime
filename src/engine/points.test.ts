import { describe, expect, it } from "vitest";
import {
  PERFECT_POINTS,
  PLACEMENT_POINTS,
  SPEED_BONUS_MAX,
  SPEED_FULL_MS,
  SPEED_ZERO_MS,
  WRONG_PLACEMENT_PENALTY,
  pointsBreakdown,
  roundPoints,
  speedBonus,
  totalPoints,
} from "./points";

const right = { correct: true, thinkMs: SPEED_ZERO_MS };
const wrong = { correct: false, thinkMs: 1_000 };

describe("speedBonus", () => {
  it("is full at or under the full-bonus time", () => {
    expect(speedBonus(0)).toBe(SPEED_BONUS_MAX);
    expect(speedBonus(SPEED_FULL_MS)).toBe(SPEED_BONUS_MAX);
  });

  it("is nothing at or over the clip length", () => {
    expect(speedBonus(SPEED_ZERO_MS)).toBe(0);
    expect(speedBonus(SPEED_ZERO_MS + 60_000)).toBe(0);
  });

  it("falls linearly in between", () => {
    expect(speedBonus(17_500)).toBe(SPEED_BONUS_MAX / 2);
    expect(speedBonus(12_000)).toBe(22);
  });
});

describe("roundPoints", () => {
  it("gives only the placement points to a slow correct card with no guess", () => {
    expect(roundPoints(right).total).toBe(PLACEMENT_POINTS);
  });

  it("adds the speed bonus to a correct card", () => {
    expect(roundPoints({ correct: true, thinkMs: 1_000 }).total).toBe(
      PLACEMENT_POINTS + SPEED_BONUS_MAX,
    );
  });

  it("charges a wrong placement and gives no speed bonus", () => {
    expect(roundPoints(wrong).total).toBe(-WRONG_PLACEMENT_PENALTY);
  });

  it("rewards the title and the artist independently", () => {
    expect(roundPoints({ ...right, titleFound: true }).guesses).toBe(10);
    expect(roundPoints({ ...right, artistFound: true }).guesses).toBe(10);
  });

  it("never charges for a missed guess", () => {
    const missed = roundPoints({ ...right, titleFound: false, artistFound: false });
    expect(missed.guesses).toBe(0);
    expect(missed.total).toBe(PLACEMENT_POINTS);
  });

  it("adds the perfect bonus only when placed and both found", () => {
    const both = { titleFound: true, artistFound: true };
    expect(roundPoints({ ...right, ...both }).perfect).toBe(PERFECT_POINTS);
    expect(roundPoints({ ...wrong, ...both }).perfect).toBe(0);
    expect(roundPoints({ ...right, titleFound: true }).perfect).toBe(0);
  });

  it("keeps the guess points on a wrong placement", () => {
    const result = roundPoints({ ...wrong, titleFound: true, artistFound: true });
    expect(result.total).toBe(-WRONG_PLACEMENT_PENALTY + 20);
  });

  it("caps a round at 170 points", () => {
    const best = roundPoints({ correct: true, thinkMs: 0, titleFound: true, artistFound: true });
    expect(best.total).toBe(170);
  });
});

describe("pointsBreakdown", () => {
  it("sums each source over the rounds", () => {
    const rounds = [
      { correct: true, thinkMs: 0, titleFound: true, artistFound: true },
      { correct: false, thinkMs: 0, titleFound: true },
    ];
    expect(pointsBreakdown(rounds)).toEqual({
      placement: PLACEMENT_POINTS - WRONG_PLACEMENT_PENALTY,
      speed: SPEED_BONUS_MAX,
      guesses: 30,
      perfect: PERFECT_POINTS,
      total: 75 + 30 + 30 + 20,
    });
  });

  it("never goes below zero", () => {
    expect(totalPoints([wrong, wrong])).toBe(0);
  });

  it("is zero without rounds", () => {
    expect(totalPoints([])).toBe(0);
  });
});
