import { useEffect, useRef, type RefObject } from "react";
import { buildSoundSchedule, playCelebrationSound } from "../../lib/celebrationSound";
import {
  buildCelebration,
  isAlive,
  opacityOf,
  stepParticle,
  GOLD_PALETTE,
  GREEN_PALETTE,
  type Particle,
} from "../../lib/celebration";

type PerfectRunCelebrationProps = {
  /** The confetti bursts from the middle of this element. */
  originRef: RefObject<HTMLElement | null>;
  /** Every round was a perfect: the confetti turns gold. */
  golden?: boolean;
  /** Whether the synchronized sound plays. Turning it off mid-way stops it. */
  soundEnabled?: boolean;
};

const MAX_FRAME_S = 0.05;
const MS_PER_SECOND = 1000;
const NOTE_STEM_RATIO = 1.1;

function drawConfetti(ctx: CanvasRenderingContext2D, p: Particle): void {
  // Squashing the height with the spin fakes the flutter of a paper flake.
  const flutter = Math.cos(p.rotation * 2);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rotation);
  ctx.scale(1, flutter);
  ctx.fillStyle = p.color;
  ctx.fillRect(-p.width / 2, -p.height / 2, p.width, p.height);
  ctx.restore();
}

function drawNote(ctx: CanvasRenderingContext2D, p: Particle): void {
  const size = p.width;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rotation);
  ctx.fillStyle = p.color;
  ctx.strokeStyle = p.color;
  ctx.lineWidth = Math.max(2, size / 8);
  ctx.beginPath();
  ctx.ellipse(0, 0, size * 0.45, size * 0.32, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(size * 0.4, -size * 0.1);
  ctx.lineTo(size * 0.4, -size * NOTE_STEM_RATIO);
  ctx.quadraticCurveTo(size * 0.9, -size * 0.8, size * 0.7, -size * 0.4);
  ctx.stroke();
  ctx.restore();
}

/** Full-screen confetti and music notes, played once when the component mounts. */
export function PerfectRunCelebration({
  originRef,
  golden = false,
  soundEnabled = true,
}: PerfectRunCelebrationProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stopSoundRef = useRef<(() => void) | null>(null);
  // Read once at the start: switching it on halfway would play out of sync.
  const soundWantedAtStart = useRef(soundEnabled);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!soundWantedAtStart.current || typeof AudioContext === "undefined") return;
    try {
      stopSoundRef.current = playCelebrationSound(buildSoundSchedule(golden, Math.random));
    } catch {
      stopSoundRef.current = null;
    }
    return () => {
      stopSoundRef.current?.();
      stopSoundRef.current = null;
    };
  }, [golden]);

  useEffect(() => {
    if (!soundEnabled) {
      stopSoundRef.current?.();
      stopSoundRef.current = null;
    }
  }, [soundEnabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const dpr = window.devicePixelRatio || 1;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    canvas.width = viewport.width * dpr;
    canvas.height = viewport.height * dpr;
    ctx.scale(dpr, dpr);

    const box = originRef.current?.getBoundingClientRect();
    const origin = box
      ? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
      : { x: viewport.width / 2, y: viewport.height / 3 };

    let particles = buildCelebration(
      origin,
      viewport,
      Math.random,
      golden ? GOLD_PALETTE : GREEN_PALETTE,
    );
    let previous = performance.now();
    let frameId = 0;

    const frame = (now: number) => {
      const dtS = Math.min(MAX_FRAME_S, (now - previous) / MS_PER_SECOND);
      previous = now;
      ctx.clearRect(0, 0, viewport.width, viewport.height);
      for (const p of particles) {
        stepParticle(p, dtS);
        const opacity = opacityOf(p);
        if (opacity <= 0) continue;
        ctx.globalAlpha = opacity;
        if (p.kind === "note") drawNote(ctx, p);
        else drawConfetti(ctx, p);
      }
      ctx.globalAlpha = 1;
      particles = particles.filter(isAlive);
      if (particles.length > 0) frameId = requestAnimationFrame(frame);
    };
    frameId = requestAnimationFrame(frame);

    return () => cancelAnimationFrame(frameId);
  }, [originRef, golden]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-40 size-full"
    />
  );
}
