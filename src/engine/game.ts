import type { GameState, GameTrack } from './types';

/** Deterministic-friendly shuffle (Fisher–Yates); rng injectable for tests. */
export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Is placing a card of `year` at slot `index` correct?
 * Slot i means: between timeline[i-1] and timeline[i]
 * (0 = before the first card, timeline.length = after the last).
 * Missing neighbors count as -Infinity / +Infinity.
 * Equal years are correct on either side (≤ on both bounds).
 */
export function isCorrectPlacement(timeline: GameTrack[], year: number, index: number): boolean {
  const left = index > 0 ? timeline[index - 1].year : -Infinity;
  const right = index < timeline.length ? timeline[index].year : Infinity;
  return left <= year && year <= right;
}

/** Lowest slot index where the card would be correct (always exists in a sorted timeline). */
export function correctIndexFor(timeline: GameTrack[], year: number): number {
  for (let i = 0; i <= timeline.length; i++) {
    if (isCorrectPlacement(timeline, year, i)) return i;
  }
  /* istanbul ignore next -- unreachable on a sorted timeline */
  return timeline.length;
}

/**
 * Start a game: shuffle the tracks, seed the timeline with one visible card
 * (scores nothing), draw the first mystery.
 * Requires at least 2 tracks.
 */
export function startGame(tracks: GameTrack[], rng: () => number = Math.random): GameState {
  if (tracks.length < 2) {
    throw new Error('A game needs at least 2 playable tracks.');
  }
  const deck = shuffle(tracks, rng);
  const seed = deck.shift()!;
  const mystery = deck.shift()!;
  return {
    phase: 'listening',
    timeline: [seed],
    mystery,
    pendingIndex: null,
    score: 0,
    streak: 0,
    deck,
    reveal: null,
  };
}

/** Provisionally place (or move) the mystery card at slot `index`. Not submitted yet. */
export function placeAt(state: GameState, index: number): GameState {
  if (state.mystery === null) return state;
  if (state.phase !== 'listening' && state.phase !== 'pendingValidation') return state;
  const clamped = Math.max(0, Math.min(index, state.timeline.length));
  return { ...state, pendingIndex: clamped, phase: 'pendingValidation' };
}

/** Withdraw the provisional placement. */
export function unplace(state: GameState): GameState {
  if (state.phase !== 'pendingValidation') return state;
  return { ...state, pendingIndex: null, phase: 'listening' };
}

/** Second click: validate the provisional placement and reveal the result. */
export function validate(state: GameState): GameState {
  if (state.phase !== 'pendingValidation' || state.pendingIndex === null || !state.mystery) {
    return state;
  }
  const { timeline, mystery, pendingIndex } = state;
  const correct = isCorrectPlacement(timeline, mystery.year, pendingIndex);
  const pointsAwarded = correct ? 1 : 0;
  const reveal = {
    correct,
    correctIndex: correctIndexFor(timeline, mystery.year),
    chosenIndex: pendingIndex,
    track: mystery,
    pointsAwarded,
  };
  if (!correct) {
    return { ...state, phase: 'revealing', reveal };
  }
  const newTimeline = [...timeline];
  newTimeline.splice(pendingIndex, 0, mystery);
  return {
    ...state,
    phase: 'revealing',
    timeline: newTimeline,
    score: state.score + 1,
    streak: state.streak + 1,
    reveal,
  };
}

/**
 * Replace an unplayable mystery track with the next one from the deck
 * (used when a provider fails to play a clip). Empty deck → the run ends
 * as cleared with the current score.
 */
export function skipMystery(state: GameState): GameState {
  if (!state.mystery || (state.phase !== 'listening' && state.phase !== 'pendingValidation')) {
    return state;
  }
  if (state.deck.length === 0) {
    return { ...state, phase: 'cleared', mystery: null, pendingIndex: null, reveal: null };
  }
  const deck = [...state.deck];
  const mystery = deck.shift()!;
  return { ...state, phase: 'listening', mystery, pendingIndex: null, deck };
}

/** After the reveal animation: advance to next round, game over, or cleared. */
export function nextRound(state: GameState): GameState {
  if (state.phase !== 'revealing' || !state.reveal) return state;
  if (!state.reveal.correct) {
    return { ...state, phase: 'gameOver', mystery: null, pendingIndex: null };
  }
  if (state.deck.length === 0) {
    return { ...state, phase: 'cleared', mystery: null, pendingIndex: null, reveal: null };
  }
  const deck = [...state.deck];
  const mystery = deck.shift()!;
  return { ...state, phase: 'listening', mystery, pendingIndex: null, deck, reveal: null };
}
