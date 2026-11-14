import { describe, expect, it } from "vitest";
import {
  newAttempt,
  perfectTrackIds,
  pointsOf,
  statsFrom,
  type DailyRound,
} from "./dailyStore";

const round = (overrides: Partial<DailyRound> = {}): DailyRound => ({
  trackId: "a",
  chosenIndex: 0,
  correctIndex: 0,
  correct: true,
  thinkMs: 30_000,
  ...overrides,
});

describe("perfectTrackIds", () => {
  it("keeps only well-placed cards with title and artist both found", () => {
    const found = { titleFound: true, artistFound: true };
    const rounds = [
      round({ trackId: "gold", ...found }),
      round({ trackId: "misplaced", correct: false, ...found }),
      round({ trackId: "title-only", titleFound: true, artistFound: false }),
    ];
    expect([...perfectTrackIds(rounds)]).toEqual(["gold"]);
  });
});

describe("pointsOf", () => {
  it("is derived from the rounds", () => {
    const attempt = { rounds: [round(), round({ correct: false })] };
    expect(pointsOf(attempt)).toBe(100 - 25);
  });
});

describe("statsFrom", () => {
  const finished = (date: string, rounds: DailyRound[]) => ({
    ...newAttempt(date, 1, "abc"),
    status: "finished" as const,
    rounds,
  });

  it("reports the best score as the highest points", () => {
    const stats = statsFrom({
      "2026-09-13": finished("2026-09-13", [round()]),
      "2026-09-14": finished("2026-09-14", [round(), round()]),
      "2026-09-15": finished("2026-09-15", [round({ correct: false })]),
    });
    expect(stats.bestPoints).toBe(200);
  });

  it("has no best score before any finished run", () => {
    expect(statsFrom({}).bestPoints).toBeNull();
  });
});
