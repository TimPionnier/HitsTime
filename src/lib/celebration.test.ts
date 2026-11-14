import { describe, expect, it } from "vitest";
import {
  GOLD_PALETTE,
  GREEN_PALETTE,
  buildCelebration,
  isAlive,
  opacityOf,
  stepParticle,
  type Particle,
} from "./celebration";

const viewport = { width: 1000, height: 800 };
const origin = { x: 500, y: 200 };

function seededRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe("buildCelebration", () => {
  const particles = buildCelebration(origin, viewport, seededRng(7));

  it("spawns a lot of confetti and some notes", () => {
    expect(particles.filter((p) => p.kind !== "note").length).toBeGreaterThan(500);
    expect(particles.filter((p) => p.kind === "note").length).toBeGreaterThan(30);
  });

  it("makes every particle wait for its start time", () => {
    expect(particles.every((p) => p.age <= 0)).toBe(true);
    expect(particles.some((p) => p.age < -1)).toBe(true);
  });

  it("starts the bursts at the origin", () => {
    const first = particles[0];
    expect(first.x).toBe(origin.x);
    expect(first.y).toBe(origin.y);
  });

  it("gives every particle a positive life", () => {
    expect(particles.every((p) => p.life > 0)).toBe(true);
  });
});

describe("palettes", () => {
  const colorsOf = (palette = GREEN_PALETTE) =>
    new Set(buildCelebration(origin, viewport, seededRng(3), palette).map((p) => p.color));

  it("uses green by default, with a few gold flakes", () => {
    const colors = colorsOf();
    expect(colors.has(GREEN_PALETTE.accent)).toBe(true);
    expect(
      [...colors].every((c) => [...GREEN_PALETTE.colors, GREEN_PALETTE.accent].includes(c)),
    ).toBe(true);
  });

  it("uses only gold shades for a golden run", () => {
    const allowed = [...GOLD_PALETTE.colors, GOLD_PALETTE.accent];
    expect([...colorsOf(GOLD_PALETTE)].every((c) => allowed.includes(c))).toBe(true);
    expect(colorsOf(GOLD_PALETTE).has(GREEN_PALETTE.colors[0])).toBe(false);
  });
});

describe("stepParticle", () => {
  const fresh = (overrides: Partial<Particle> = {}): Particle => ({
    kind: "burst",
    x: 0,
    y: 0,
    vx: 100,
    vy: 0,
    rotation: 0,
    spin: 1,
    width: 6,
    height: 10,
    color: "#1db954",
    age: 0,
    life: 3,
    sway: 0,
    phase: 0,
    ...overrides,
  });

  it("does not move a particle that has not been born yet", () => {
    const p = fresh({ age: -1 });
    stepParticle(p, 0.5);
    expect(p.x).toBe(0);
    expect(p.age).toBe(-0.5);
  });

  it("moves along its velocity and falls under gravity", () => {
    const p = fresh();
    stepParticle(p, 0.1);
    expect(p.x).toBeGreaterThan(0);
    expect(p.vy).toBeGreaterThan(0);
    expect(p.y).toBeGreaterThan(0);
  });

  it("keeps rain falling at a constant speed", () => {
    const p = fresh({ kind: "rain", vx: 0, vy: 200 });
    stepParticle(p, 0.5);
    expect(p.vy).toBe(200);
  });

  it("lets notes rise, then slows them down", () => {
    const p = fresh({ kind: "note", vx: 0, vy: -400 });
    stepParticle(p, 0.5);
    expect(p.y).toBeLessThan(0);
    expect(Math.abs(p.vy)).toBeLessThan(400);
  });
});

describe("life cycle", () => {
  it("dies once its age reaches its life", () => {
    const base = buildCelebration(origin, viewport, seededRng(1))[0];
    expect(isAlive({ ...base, age: base.life - 0.1 })).toBe(true);
    expect(isAlive({ ...base, age: base.life })).toBe(false);
  });

  it("is invisible before birth, opaque mid-life and faded at the end", () => {
    const base = buildCelebration(origin, viewport, seededRng(1))[0];
    expect(opacityOf({ ...base, age: -0.2 })).toBe(0);
    expect(opacityOf({ ...base, age: base.life / 2 })).toBe(1);
    expect(opacityOf({ ...base, age: base.life - 0.1 })).toBeLessThan(0.2);
  });
});
