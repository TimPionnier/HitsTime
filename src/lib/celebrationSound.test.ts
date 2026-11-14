import { describe, expect, it } from "vitest";
import { SCHEDULE } from "./celebration";
import { buildSoundSchedule } from "./celebrationSound";

function seededRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe("buildSoundSchedule", () => {
  const normal = buildSoundSchedule(false, seededRng(5));
  const golden = buildSoundSchedule(true, seededRng(5));

  it("pops on every confetti wave", () => {
    const popTimes = normal.filter((e) => e.kind === "pop").map((e) => e.at);
    expect(popTimes).toContain(SCHEDULE.firstBurst.at);
    expect(popTimes).toContain(SCHEDULE.cannons.at);
    expect(popTimes).toContain(SCHEDULE.secondBurst.at);
    expect(popTimes).toContain(SCHEDULE.finale.at);
  });

  it("fires the two cannons on opposite sides", () => {
    const pans = normal.filter((e) => e.kind === "pop" && e.at === SCHEDULE.cannons.at);
    expect(pans.map((e) => e.kind === "pop" && e.pan).sort()).toEqual([-0.8, 0.8]);
  });

  it("sparkles only while the confetti rains", () => {
    const sparkles = normal.filter((e) => e.kind === "sparkle");
    expect(sparkles.length).toBeGreaterThan(0);
    expect(sparkles.every((e) => e.at >= SCHEDULE.rain.from && e.at <= SCHEDULE.rain.to)).toBe(
      true,
    );
  });

  it("ends on a chord at the finale", () => {
    const chord = normal.find((e) => e.kind === "chord");
    expect(chord?.at).toBe(SCHEDULE.finale.at);
  });

  it("makes a golden run richer: more sparkles and a fuller chord", () => {
    const count = (events: typeof normal, kind: string) =>
      events.filter((e) => e.kind === kind).length;
    const chordSize = (events: typeof normal) => {
      const chord = events.find((e) => e.kind === "chord");
      return chord?.kind === "chord" ? chord.hz.length : 0;
    };
    expect(count(golden, "sparkle")).toBeGreaterThan(count(normal, "sparkle"));
    expect(chordSize(golden)).toBeGreaterThan(chordSize(normal));
  });

  it("never schedules a sound before the start", () => {
    expect(normal.every((e) => e.at >= 0)).toBe(true);
  });
});
