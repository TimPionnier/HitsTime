/** Sound of the flawless-run celebration, synthesized so no audio file ships. */
import { SCHEDULE, type Rng } from "./celebration";

export type SoundEvent =
  | { kind: "pop"; at: number; pan: number; gain: number }
  | { kind: "note"; at: number; hz: number; pan: number; gain: number }
  | { kind: "sparkle"; at: number; hz: number; pan: number; gain: number }
  | { kind: "chord"; at: number; hz: number[]; gain: number };

const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const C6 = 1046.5;
const E6 = 1318.5;
const G6 = 1568;
const C7 = 2093;
const SPARKLE_SCALE = [1046.5, 1174.7, 1318.5, 1568, 1760, 2093];
const ARPEGGIO_STEP_S = 0.07;
const SPARKLES = { normal: 14, golden: 26 };
const SPARKLE_GAIN = 0.07;
const POP_GAIN = 0.55;
const NOTE_GAIN = 0.2;
const CHORD_GAIN = 0.16;
const MASTER_GAIN = 0.6;

const NOTE_ATTACK_S = 0.006;
const NOTE_DECAY_S = 0.55;
const SPARKLE_DECAY_S = 0.3;
const CHORD_DECAY_S = 1.6;
const POP_NOISE_S = 0.14;
const POP_THUMP_S = 0.16;
const SILENCE = 0.0001;

function arpeggio(at: number, hz: number[], gain: number): SoundEvent[] {
  return hz.map((freq, index) => ({
    kind: "note" as const,
    at: at + index * ARPEGGIO_STEP_S,
    hz: freq,
    pan: 0,
    gain,
  }));
}

/** Every sound of the celebration, on the beats of the confetti waves. */
export function buildSoundSchedule(golden: boolean, rng: Rng): SoundEvent[] {
  const { firstBurst, cannons, secondBurst, rain, finale } = SCHEDULE;
  const sparkleCount = golden ? SPARKLES.golden : SPARKLES.normal;

  const sparkles: SoundEvent[] = Array.from({ length: sparkleCount }, () => ({
    kind: "sparkle" as const,
    at: rain.from + rng() * (rain.to - rain.from),
    hz: SPARKLE_SCALE[Math.floor(rng() * SPARKLE_SCALE.length)],
    pan: rng() * 2 - 1,
    gain: SPARKLE_GAIN,
  }));

  const finaleChord = golden ? [C5, E5, G5, C6, E6, G6, C7] : [C5, E5, G5, C6];

  return [
    { kind: "pop", at: firstBurst.at, pan: 0, gain: POP_GAIN },
    ...arpeggio(firstBurst.at, [C5, E5, G5, C6, E6], NOTE_GAIN),
    { kind: "pop", at: cannons.at, pan: -0.8, gain: POP_GAIN * 0.8 },
    { kind: "pop", at: cannons.at, pan: 0.8, gain: POP_GAIN * 0.8 },
    { kind: "note", at: cannons.at, hz: G5, pan: -0.6, gain: NOTE_GAIN },
    { kind: "note", at: cannons.at, hz: C6, pan: 0.6, gain: NOTE_GAIN },
    { kind: "pop", at: secondBurst.at, pan: 0, gain: POP_GAIN },
    ...arpeggio(secondBurst.at, [C6, E6, G6], NOTE_GAIN),
    ...sparkles,
    { kind: "pop", at: finale.at, pan: 0, gain: POP_GAIN * 1.2 },
    { kind: "chord", at: finale.at, hz: finaleChord, gain: CHORD_GAIN },
  ];
}

function envelope(
  ctx: AudioContext,
  start: number,
  peak: number,
  attackS: number,
  decayS: number,
): GainNode {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(SILENCE, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + attackS);
  gain.gain.exponentialRampToValueAtTime(SILENCE, start + attackS + decayS);
  return gain;
}

function panned(ctx: AudioContext, pan: number, output: AudioNode): AudioNode {
  const panner = ctx.createStereoPanner();
  panner.pan.value = pan;
  panner.connect(output);
  return panner;
}

function tone(
  ctx: AudioContext,
  output: AudioNode,
  type: OscillatorType,
  hz: number,
  start: number,
  peak: number,
  decayS: number,
  pan: number,
): void {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = hz;
  const gain = envelope(ctx, start, peak, NOTE_ATTACK_S, decayS);
  osc.connect(gain);
  gain.connect(panned(ctx, pan, output));
  osc.start(start);
  osc.stop(start + NOTE_ATTACK_S + decayS + 0.05);
}

function pop(
  ctx: AudioContext,
  output: AudioNode,
  noise: AudioBuffer,
  start: number,
  gain: number,
  pan: number,
): void {
  const destination = panned(ctx, pan, output);

  const source = ctx.createBufferSource();
  source.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(5000, start);
  filter.frequency.exponentialRampToValueAtTime(600, start + POP_NOISE_S);
  const noiseGain = envelope(ctx, start, gain, 0.003, POP_NOISE_S);
  source.connect(filter);
  filter.connect(noiseGain);
  noiseGain.connect(destination);
  source.start(start);
  source.stop(start + POP_NOISE_S + 0.05);

  const thump = ctx.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(170, start);
  thump.frequency.exponentialRampToValueAtTime(45, start + POP_THUMP_S);
  const thumpGain = envelope(ctx, start, gain, 0.003, POP_THUMP_S);
  thump.connect(thumpGain);
  thumpGain.connect(destination);
  thump.start(start);
  thump.stop(start + POP_THUMP_S + 0.05);
}

function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const length = Math.ceil(ctx.sampleRate * POP_NOISE_S);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** Plays the schedule from now; the returned function stops it at once. */
export function playCelebrationSound(events: SoundEvent[]): () => void {
  const ctx = new AudioContext();
  const compressor = ctx.createDynamicsCompressor();
  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(compressor);
  compressor.connect(ctx.destination);

  // Browsers keep the context suspended until the page has been interacted with.
  void ctx.resume().catch(() => undefined);

  const noise = noiseBuffer(ctx);
  const origin = ctx.currentTime + 0.05;

  for (const event of events) {
    const start = origin + event.at;
    if (event.kind === "pop") pop(ctx, master, noise, start, event.gain, event.pan);
    if (event.kind === "note") {
      tone(ctx, master, "triangle", event.hz, start, event.gain, NOTE_DECAY_S, event.pan);
    }
    if (event.kind === "sparkle") {
      tone(ctx, master, "sine", event.hz, start, event.gain, SPARKLE_DECAY_S, event.pan);
    }
    if (event.kind === "chord") {
      for (const hz of event.hz) {
        tone(ctx, master, "triangle", hz, start, event.gain, CHORD_DECAY_S, 0);
      }
    }
  }

  return () => {
    void ctx.close().catch(() => undefined);
  };
}
