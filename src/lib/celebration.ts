/** Particles of the flawless-run celebration: green confetti and music notes. */

export type ParticleKind = "burst" | "rain" | "note";

export type Particle = {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  spin: number;
  width: number;
  height: number;
  color: string;
  /** Seconds since birth; starts negative so a particle can wait for its wave. */
  age: number;
  life: number;
  sway: number;
  phase: number;
};

export type Point = { x: number; y: number };
export type Viewport = { width: number; height: number };
export type Rng = () => number;

/** `accent` is the rare contrasting colour sprinkled among the main ones. */
export type Palette = { colors: string[]; accent: string };

export const GREEN_PALETTE: Palette = {
  colors: ["#1db954", "#169c46", "#5ee08a", "#b7f5cc"],
  accent: "#f5c518",
};

export const GOLD_PALETTE: Palette = {
  colors: ["#f5c518", "#ffd95a", "#e0a800", "#ffe9a0"],
  accent: "#fff8dc",
};

const ACCENT_SHARE = 0.18;

const GRAVITY_PX_S2: Record<ParticleKind, number> = { burst: 950, rain: 0, note: 140 };
/** Fraction of its speed a particle keeps after one second. */
const SPEED_KEPT_PER_S: Record<ParticleKind, number> = { burst: 0.3, rain: 1, note: 0.45 };
const SWAY_SPEED = 3;
const FADE_OUT_S = 0.9;

const BURST_SPEED = { min: 320, max: 980 };
const BURST_LIFE_S = { min: 2.6, max: 4 };
const BURST_UPWARD_BIAS = 160;
const CANNON_SPEED = { min: 750, max: 1250 };
const CANNON_ANGLE_SPREAD = 0.35;
const CANNON_ANGLE_FROM_UP = 0.62;
const RAIN_SPEED = { min: 170, max: 340 };
const NOTE_SPEED = { min: 220, max: 560 };
const NOTE_LIFE_S = { min: 3.4, max: 5.2 };
const NOTE_SIZE = { min: 14, max: 26 };
const CONFETTI_WIDTH = { min: 6, max: 10 };
const CONFETTI_HEIGHT = { min: 10, max: 16 };
const MAX_SPIN = 9;
const MAX_SWAY_PX_S = 38;
const OFFSCREEN_MARGIN = 80;

/** What the celebration spawns, and when. Times in seconds; the sound follows the same beats. */
export const SCHEDULE = {
  firstBurst: { at: 0, confetti: 170, notes: 14 },
  cannons: { at: 0.3, confettiPerSide: 120, notesPerSide: 9 },
  secondBurst: { at: 0.85, confetti: 140, notes: 10 },
  rain: { from: 0.6, to: 2.8, confetti: 160 },
  finale: { at: 1.5, confetti: 110, notes: 12 },
};

function between(rng: Rng, range: { min: number; max: number }): number {
  return range.min + rng() * (range.max - range.min);
}

function confettiColor(rng: Rng, palette: Palette): string {
  if (rng() < ACCENT_SHARE) return palette.accent;
  return palette.colors[Math.floor(rng() * palette.colors.length)];
}

function confetti(
  kind: ParticleKind,
  position: Point,
  velocity: Point,
  delay: number,
  life: number,
  rng: Rng,
  palette: Palette,
): Particle {
  return {
    kind,
    x: position.x,
    y: position.y,
    vx: velocity.x,
    vy: velocity.y,
    rotation: rng() * Math.PI * 2,
    spin: (rng() * 2 - 1) * MAX_SPIN,
    width: between(rng, CONFETTI_WIDTH),
    height: between(rng, CONFETTI_HEIGHT),
    color: confettiColor(rng, palette),
    age: -delay,
    life,
    sway: rng() * MAX_SWAY_PX_S,
    phase: rng() * Math.PI * 2,
  };
}

function burstConfetti(
  origin: Point,
  count: number,
  delay: number,
  rng: Rng,
  palette: Palette,
): Particle[] {
  return Array.from({ length: count }, () => {
    const angle = rng() * Math.PI * 2;
    const speed = between(rng, BURST_SPEED);
    const velocity = {
      x: Math.cos(angle) * speed,
      y: Math.sin(angle) * speed - BURST_UPWARD_BIAS,
    };
    return confetti("burst", origin, velocity, delay, between(rng, BURST_LIFE_S), rng, palette);
  });
}

function cannonConfetti(
  origin: Point,
  towardsRight: boolean,
  count: number,
  delay: number,
  rng: Rng,
  palette: Palette,
): Particle[] {
  return Array.from({ length: count }, () => {
    const lean = towardsRight ? CANNON_ANGLE_FROM_UP : -CANNON_ANGLE_FROM_UP;
    const angle = lean + (rng() * 2 - 1) * CANNON_ANGLE_SPREAD;
    const speed = between(rng, CANNON_SPEED);
    const velocity = { x: Math.sin(angle) * speed, y: -Math.cos(angle) * speed };
    return confetti("burst", origin, velocity, delay, between(rng, BURST_LIFE_S), rng, palette);
  });
}

function rainConfetti(viewport: Viewport, count: number, rng: Rng, palette: Palette): Particle[] {
  return Array.from({ length: count }, () => {
    const speed = between(rng, RAIN_SPEED);
    const delay = SCHEDULE.rain.from + rng() * (SCHEDULE.rain.to - SCHEDULE.rain.from);
    const life = (viewport.height + OFFSCREEN_MARGIN) / speed;
    const position = { x: rng() * viewport.width, y: -OFFSCREEN_MARGIN / 2 };
    return confetti("rain", position, { x: 0, y: speed }, delay, life, rng, palette);
  });
}

function notes(
  origin: Point,
  count: number,
  delay: number,
  spread: number,
  rng: Rng,
  palette: Palette,
): Particle[] {
  return Array.from({ length: count }, () => {
    const angle = -Math.PI / 2 + (rng() * 2 - 1) * spread;
    const speed = between(rng, NOTE_SPEED);
    const size = between(rng, NOTE_SIZE);
    return {
      kind: "note" as const,
      x: origin.x,
      y: origin.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rotation: (rng() * 2 - 1) * 0.5,
      spin: (rng() * 2 - 1) * 0.8,
      width: size,
      height: size,
      color: confettiColor(rng, palette),
      age: -delay - rng() * 0.15,
      life: between(rng, NOTE_LIFE_S),
      sway: rng() * MAX_SWAY_PX_S,
      phase: rng() * Math.PI * 2,
    };
  });
}

/** Every particle of the celebration, each waiting for its own start time. */
export function buildCelebration(
  origin: Point,
  viewport: Viewport,
  rng: Rng,
  palette: Palette = GREEN_PALETTE,
): Particle[] {
  const { firstBurst, cannons, secondBurst, rain, finale } = SCHEDULE;
  const bottomLeft = { x: 0, y: viewport.height };
  const bottomRight = { x: viewport.width, y: viewport.height };
  return [
    ...burstConfetti(origin, firstBurst.confetti, firstBurst.at, rng, palette),
    ...notes(origin, firstBurst.notes, firstBurst.at, 1.1, rng, palette),
    ...cannonConfetti(bottomLeft, true, cannons.confettiPerSide, cannons.at, rng, palette),
    ...cannonConfetti(bottomRight, false, cannons.confettiPerSide, cannons.at, rng, palette),
    ...notes(bottomLeft, cannons.notesPerSide, cannons.at, 0.5, rng, palette),
    ...notes(bottomRight, cannons.notesPerSide, cannons.at, 0.5, rng, palette),
    ...burstConfetti(origin, secondBurst.confetti, secondBurst.at, rng, palette),
    ...notes(origin, secondBurst.notes, secondBurst.at, 1.3, rng, palette),
    ...rainConfetti(viewport, rain.confetti, rng, palette),
    ...burstConfetti(origin, finale.confetti, finale.at, rng, palette),
    ...notes(origin, finale.notes, finale.at, 1.4, rng, palette),
  ];
}

/** Advances one particle by `dtS` seconds, in place. */
export function stepParticle(p: Particle, dtS: number): void {
  p.age += dtS;
  if (p.age < 0) return;
  const kept = Math.pow(SPEED_KEPT_PER_S[p.kind], dtS);
  p.vx *= kept;
  p.vy = p.vy * kept + GRAVITY_PX_S2[p.kind] * dtS;
  p.x += p.vx * dtS + Math.sin(p.age * SWAY_SPEED + p.phase) * p.sway * dtS;
  p.y += p.vy * dtS;
  p.rotation += p.spin * dtS;
}

export function isAlive(p: Particle): boolean {
  return p.age < p.life;
}

/** 0 before birth, 1 while alive, fading to 0 over the last moments of its life. */
export function opacityOf(p: Particle): number {
  if (p.age < 0) return 0;
  return Math.min(1, Math.max(0, (p.life - p.age) / FADE_OUT_S));
}
