import { describe, it, expect } from 'vitest';
import { startOYGame, readyToGuess, guessOY, nextOYRound, skipOYMystery } from './olderYounger';
import type { GameTrack } from './types';

const t = (id: string, year: number): GameTrack => ({
  id,
  title: `Song ${id}`,
  artist: `Artist ${id}`,
  year,
});

const rng0 = () => 0;

describe('olderYounger', () => {
  const tracks = [t('a', 1970), t('b', 1985), t('c', 2000), t('d', 1995)];

  it('startOYGame sets up reference and mystery', () => {
    const s = startOYGame(tracks, rng0);
    expect(s.reference).toBeTruthy();
    expect(s.mystery).toBeTruthy();
    expect(s.reference.id).not.toBe(s.mystery!.id);
    expect(s.deck).toHaveLength(2);
    expect(s.phase).toBe('listening');
    expect(s.score).toBe(0);
    expect(s.streak).toBe(0);
  });

  it('rejects fewer than 2 tracks', () => {
    expect(() => startOYGame([t('a', 1990)], rng0)).toThrow();
  });

  it('correct guess: older', () => {
    // rng0 keeps order: ref=a(1970), mystery=b(1985)
    let s = startOYGame(tracks, rng0);
    s = readyToGuess(s);
    expect(s.phase).toBe('pendingGuess');

    // b(1985) is younger than a(1970), so guessing 'younger' is correct
    s = guessOY(s, 'younger');
    expect(s.phase).toBe('revealing');
    expect(s.reveal?.correct).toBe(true);
    expect(s.reveal?.pointsAwarded).toBe(1);
    expect(s.score).toBe(1);
    expect(s.streak).toBe(1);
  });

  it('wrong guess ends game', () => {
    let s = startOYGame(tracks, rng0);
    s = readyToGuess(s);
    // b(1985) is younger than a(1970), guessing 'older' is wrong
    s = guessOY(s, 'older');
    expect(s.reveal?.correct).toBe(false);
    expect(s.reveal?.pointsAwarded).toBe(0);
    expect(s.score).toBe(0);
    s = nextOYRound(s);
    expect(s.phase).toBe('gameOver');
  });

  it('same year: both guesses correct', () => {
    // With rng0, shuffle of [a,b] produces [b,a] → ref=b, mystery=a, both 1990
    const sameTracks = [t('a', 1990), t('b', 1990)];
    let s = startOYGame(sameTracks, rng0);
    expect(s.reference.year).toBe(s.mystery!.year);
    s = readyToGuess(s);
    s = guessOY(s, 'older');
    expect(s.reveal?.correct).toBe(true);

    // Also test the other direction
    let s2 = startOYGame(sameTracks, rng0);
    s2 = readyToGuess(s2);
    s2 = guessOY(s2, 'younger');
    expect(s2.reveal?.correct).toBe(true);
  });

  it('mystery becomes new reference on correct answer', () => {
    let s = startOYGame(tracks, rng0);
    const mysteryId = s.mystery!.id;
    s = readyToGuess(s);
    s = guessOY(s, 'younger'); // correct
    s = nextOYRound(s);
    expect(s.reference.id).toBe(mysteryId);
    expect(s.mystery).toBeTruthy();
    expect(s.mystery!.id).not.toBe(mysteryId);
    expect(s.phase).toBe('listening');
  });

  it('flat scoring: +1 per correct, streak increments', () => {
    let s = startOYGame(tracks, rng0);
    for (let i = 1; i <= 3; i++) {
      s = readyToGuess(s);
      const guess = s.mystery!.year >= s.reference.year ? 'younger' : 'older';
      s = guessOY(s, guess);
      expect(s.reveal?.correct).toBe(true);
      expect(s.reveal?.pointsAwarded).toBe(1);
      expect(s.score).toBe(i);
      expect(s.streak).toBe(i);
      s = nextOYRound(s);
    }
    expect(s.phase).toBe('cleared');
    expect(s.score).toBe(3);
  });

  it('clearing the deck wins', () => {
    let s = startOYGame(tracks, rng0);
    let guard = 10;
    while (s.phase !== 'cleared' && guard-- > 0) {
      s = readyToGuess(s);
      const guess = s.mystery!.year >= s.reference.year ? 'younger' : 'older';
      s = guessOY(s, guess);
      s = nextOYRound(s);
    }
    expect(s.phase).toBe('cleared');
  });

  it('skipOYMystery draws next card', () => {
    let s = startOYGame(tracks, rng0);
    const skippedId = s.mystery!.id;
    s = skipOYMystery(s);
    expect(s.mystery!.id).not.toBe(skippedId);
    expect(s.phase).toBe('listening');
  });

  it('skipOYMystery on empty deck clears', () => {
    let s = startOYGame([t('a', 1970), t('b', 1985)], rng0);
    expect(s.deck).toHaveLength(0);
    s = skipOYMystery(s);
    expect(s.phase).toBe('cleared');
  });
});
