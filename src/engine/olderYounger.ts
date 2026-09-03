import type { GameTrack } from './types';
import { shuffle } from './game';

export type OYGuess = 'older' | 'younger';

export type OYPhase =
  | 'listening'
  | 'pendingGuess'
  | 'revealing'
  | 'gameOver'
  | 'cleared';

export interface OYRevealResult {
  correct: boolean;
  guess: OYGuess;
  referenceYear: number;
  mysteryYear: number;
  pointsAwarded: number;
  track: GameTrack;
}

export interface OYState {
  phase: OYPhase;
  /** The visible card (year shown). */
  reference: GameTrack;
  /** The hidden card (year hidden until reveal). */
  mystery: GameTrack | null;
  guess: OYGuess | null;
  score: number;
  streak: number;
  deck: GameTrack[];
  reveal: OYRevealResult | null;
}

/**
 * Start an Older-or-Younger game.
 * Draws two cards: one as the visible reference, one as the mystery.
 * Requires at least 2 tracks.
 */
export function startOYGame(tracks: GameTrack[], rng: () => number = Math.random): OYState {
  if (tracks.length < 2) {
    throw new Error('A game needs at least 2 playable tracks.');
  }
  const deck = shuffle(tracks, rng);
  const reference = deck.shift()!;
  const mystery = deck.shift()!;
  return {
    phase: 'listening',
    reference,
    mystery,
    guess: null,
    score: 0,
    streak: 0,
    deck,
    reveal: null,
  };
}

/** Player has listened and is ready to guess. */
export function readyToGuess(state: OYState): OYState {
  if (state.phase !== 'listening') return state;
  return { ...state, phase: 'pendingGuess' };
}

/**
 * Submit a guess and reveal the result.
 * Same year → both guesses are correct.
 * No repeated songs: the mystery is consumed either way.
 */
export function guessOY(state: OYState, guess: OYGuess): OYState {
  if (state.phase !== 'pendingGuess' || !state.mystery) return state;

  const refYear = state.reference.year;
  const mysYear = state.mystery.year;

  let correct: boolean;
  if (refYear === mysYear) {
    correct = true; // same year: always correct
  } else if (guess === 'older') {
    correct = mysYear < refYear;
  } else {
    correct = mysYear > refYear;
  }

  const pointsAwarded = correct ? 1 : 0;

  const reveal: OYRevealResult = {
    correct,
    guess,
    referenceYear: refYear,
    mysteryYear: mysYear,
    pointsAwarded,
    track: state.mystery,
  };

  return {
    ...state,
    phase: 'revealing',
    guess,
    score: correct ? state.score + 1 : state.score,
    streak: correct ? state.streak + 1 : 0,
    reveal,
  };
}

/**
 * After reveal animation: advance to next round.
 * If correct, the mystery becomes the new reference. Draw new mystery from deck.
 * If wrong → game over. If deck empty → cleared.
 */
export function nextOYRound(state: OYState): OYState {
  if (state.phase !== 'revealing' || !state.reveal) return state;

  if (!state.reveal.correct) {
    return { ...state, phase: 'gameOver', mystery: null, guess: null };
  }

  // Mystery becomes the new reference
  const newReference = state.reveal.track;

  if (state.deck.length === 0) {
    return {
      ...state,
      phase: 'cleared',
      reference: newReference,
      mystery: null,
      guess: null,
      reveal: null,
    };
  }

  const deck = [...state.deck];
  const mystery = deck.shift()!;
  return {
    ...state,
    phase: 'listening',
    reference: newReference,
    mystery,
    guess: null,
    deck,
    reveal: null,
  };
}

/** Skip an unplayable mystery track. */
export function skipOYMystery(state: OYState): OYState {
  if (!state.mystery || (state.phase !== 'listening' && state.phase !== 'pendingGuess')) {
    return state;
  }
  if (state.deck.length === 0) {
    return { ...state, phase: 'cleared', mystery: null, guess: null, reveal: null };
  }
  const deck = [...state.deck];
  const mystery = deck.shift()!;
  return { ...state, phase: 'listening', mystery, guess: null, deck };
}
