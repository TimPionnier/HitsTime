import { describe, it, expect } from 'vitest';
import {
  isCorrectPlacement,
  correctIndexFor,
  startGame,
  placeAt,
  unplace,
  validate,
  nextRound,
  skipMystery,
} from './game';
import type { GameTrack } from './types';

const t = (id: string, year: number): GameTrack => ({
  id,
  title: `Song ${id}`,
  artist: `Artist ${id}`,
  year,
});

// rng that returns 0 => shuffle keeps original order-ish (deterministic)
const rng0 = () => 0;

describe('isCorrectPlacement', () => {
  const timeline = [t('a', 1970), t('b', 1985), t('c', 2000)];

  it('accepts a year in the right gap', () => {
    expect(isCorrectPlacement(timeline, 1990, 2)).toBe(true);
  });
  it('rejects a year in the wrong gap', () => {
    expect(isCorrectPlacement(timeline, 1990, 1)).toBe(false);
    expect(isCorrectPlacement(timeline, 1990, 0)).toBe(false);
    expect(isCorrectPlacement(timeline, 1990, 3)).toBe(false);
  });
  it('accepts before the first card for the oldest year', () => {
    expect(isCorrectPlacement(timeline, 1960, 0)).toBe(true);
  });
  it('accepts after the last card for the newest year', () => {
    expect(isCorrectPlacement(timeline, 2020, 3)).toBe(true);
  });
  it('equal year is correct on either side of the equal card', () => {
    expect(isCorrectPlacement(timeline, 1985, 1)).toBe(true); // just before b
    expect(isCorrectPlacement(timeline, 1985, 2)).toBe(true); // just after b
    expect(isCorrectPlacement(timeline, 1985, 0)).toBe(false);
    expect(isCorrectPlacement(timeline, 1985, 3)).toBe(false);
  });
  it('works on a single-card timeline', () => {
    const single = [t('a', 1990)];
    expect(isCorrectPlacement(single, 1980, 0)).toBe(true);
    expect(isCorrectPlacement(single, 2000, 1)).toBe(true);
    expect(isCorrectPlacement(single, 1990, 0)).toBe(true);
    expect(isCorrectPlacement(single, 1990, 1)).toBe(true);
  });
  it('handles clustered duplicate years', () => {
    const dup = [t('a', 1990), t('b', 1990), t('c', 1990)];
    for (let i = 0; i <= 3; i++) expect(isCorrectPlacement(dup, 1990, i)).toBe(true);
    expect(isCorrectPlacement(dup, 1989, 0)).toBe(true);
    expect(isCorrectPlacement(dup, 1989, 1)).toBe(false);
  });
});

describe('correctIndexFor', () => {
  it('returns the lowest valid slot', () => {
    const timeline = [t('a', 1970), t('b', 1985), t('c', 2000)];
    expect(correctIndexFor(timeline, 1985)).toBe(1);
    expect(correctIndexFor(timeline, 1960)).toBe(0);
    expect(correctIndexFor(timeline, 2020)).toBe(3);
    expect(correctIndexFor(timeline, 1990)).toBe(2);
  });
});

describe('game flow', () => {
  const tracks = [t('a', 1970), t('b', 1985), t('c', 2000), t('d', 1995)];

  it('startGame seeds one visible card and draws a mystery', () => {
    const s = startGame(tracks, rng0);
    expect(s.timeline).toHaveLength(1);
    expect(s.mystery).not.toBeNull();
    expect(s.deck).toHaveLength(2);
    expect(s.score).toBe(0);
    expect(s.phase).toBe('listening');
  });

  it('rejects playlists with fewer than 2 tracks', () => {
    expect(() => startGame([t('a', 1990)], rng0)).toThrow();
  });

  it('two-step commit: placing does not score, validating does', () => {
    let s = startGame(tracks, rng0);
    const goodIndex = correctIndexFor(s.timeline, s.mystery!.year);
    s = placeAt(s, goodIndex);
    expect(s.phase).toBe('pendingValidation');
    expect(s.score).toBe(0);
    s = validate(s);
    expect(s.phase).toBe('revealing');
    expect(s.reveal?.correct).toBe(true);
    expect(s.reveal?.pointsAwarded).toBe(1);
    expect(s.score).toBe(1);
    expect(s.streak).toBe(1);
    expect(s.timeline).toHaveLength(2);
  });

  it('placement can be moved before validating', () => {
    let s = startGame(tracks, rng0);
    s = placeAt(s, 0);
    s = placeAt(s, 1);
    expect(s.pendingIndex).toBe(1);
    s = unplace(s);
    expect(s.pendingIndex).toBeNull();
    expect(s.phase).toBe('listening');
  });

  it('wrong placement ends the game without inserting the card', () => {
    let s = startGame(tracks, rng0);
    const good = correctIndexFor(s.timeline, s.mystery!.year);
    // find a wrong index (exists unless year equals the single seed's year on both sides)
    const wrong = [0, 1].find((i) => !isCorrectPlacement(s.timeline, s.mystery!.year, i));
    if (wrong === undefined) {
      // equal-year seed: any placement is correct — nothing to assert here
      expect(good).toBeGreaterThanOrEqual(0);
      return;
    }
    s = placeAt(s, wrong);
    s = validate(s);
    expect(s.reveal?.correct).toBe(false);
    expect(s.timeline).toHaveLength(1);
    expect(s.score).toBe(0);
    s = nextRound(s);
    expect(s.phase).toBe('gameOver');
  });

  it('clearing the whole deck wins', () => {
    let s = startGame(tracks, rng0);
    // play perfectly until the deck is empty
    let guard = 10;
    while (s.phase !== 'cleared' && guard-- > 0) {
      const idx = correctIndexFor(s.timeline, s.mystery!.year);
      s = validate(placeAt(s, idx));
      expect(s.reveal?.correct).toBe(true);
      s = nextRound(s);
    }
    expect(s.phase).toBe('cleared');
    expect(s.score).toBe(3); // flat +1 per round (4 tracks - 1 seed = 3 rounds)
    expect(s.timeline).toHaveLength(4);
    // timeline stays sorted
    const years = s.timeline.map((c) => c.year);
    expect(years).toEqual([...years].sort((x, y) => x - y));
  });

  it('skipMystery replaces the mystery and resets any pending placement', () => {
    let s = startGame(tracks, rng0);
    const skippedId = s.mystery!.id;
    s = placeAt(s, 0);
    s = skipMystery(s);
    expect(s.phase).toBe('listening');
    expect(s.pendingIndex).toBeNull();
    expect(s.mystery!.id).not.toBe(skippedId);
    expect(s.deck).toHaveLength(1);
  });

  it('skipMystery on an empty deck ends the run as cleared', () => {
    let s = startGame([t('a', 1970), t('b', 1985)], rng0);
    expect(s.deck).toHaveLength(0);
    s = skipMystery(s);
    expect(s.phase).toBe('cleared');
    expect(s.mystery).toBeNull();
  });

  it('flat scoring: +1 per correct, streak increments', () => {
    const tracks5 = [t('a', 1970), t('b', 1980), t('c', 1990), t('d', 2000), t('e', 2010)];
    let s = startGame(tracks5, rng0);
    for (let i = 1; i <= 4; i++) {
      const idx = correctIndexFor(s.timeline, s.mystery!.year);
      s = validate(placeAt(s, idx));
      expect(s.reveal?.pointsAwarded).toBe(1);
      expect(s.score).toBe(i);
      expect(s.streak).toBe(i);
      s = nextRound(s);
    }
    expect(s.phase).toBe('cleared');
    expect(s.score).toBe(4);
  });

  it('placeAt clamps out-of-range indices', () => {
    let s = startGame(tracks, rng0);
    s = placeAt(s, 99);
    expect(s.pendingIndex).toBe(s.timeline.length);
    s = placeAt(s, -5);
    expect(s.pendingIndex).toBe(0);
  });
});
