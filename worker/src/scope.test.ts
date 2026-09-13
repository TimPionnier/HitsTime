import { describe, expect, it } from 'vitest';

import { canonicalScope, directionFor, isMode, scoreInRange } from './scope';

describe('mode', () => {
  it('accepts only the three real modes', () => {
    expect(isMode('daily')).toBe(true);
    expect(isMode('timeline')).toBe(true);
    expect(isMode('olderYounger')).toBe(true);
    expect(isMode('Daily')).toBe(false);
    expect(isMode('')).toBe(false);
    expect(isMode(null)).toBe(false);
  });

  it('gives daily the min direction and the point modes max', () => {
    // If this ever flips, "best score" silently becomes "worst score".
    expect(directionFor('daily')).toBe('min');
    expect(directionFor('timeline')).toBe('max');
    expect(directionFor('olderYounger')).toBe('max');
  });
});

describe('canonicalScope', () => {
  it('keeps a well-formed daily date', () => {
    expect(canonicalScope('daily', 'd:2026-09-13')).toBe('d:2026-09-13');
  });

  it('rejects a daily scope that is not a date', () => {
    expect(canonicalScope('daily', 'd:not-a-date')).toBeNull();
    expect(canonicalScope('daily', '2026-09-13')).toBeNull();
    expect(canonicalScope('daily', 'deezer:1')).toBeNull();
  });

  it('keeps an allowlisted playlist apart', () => {
    expect(canonicalScope('timeline', 'deezer:15689112801')).toBe('deezer:15689112801');
  });

  it('collapses every other playlist to one row', () => {
    // The cardinality attack: a loop of random ids must not write a row each.
    expect(canonicalScope('timeline', 'deezer:1')).toBe('other');
    expect(canonicalScope('timeline', 'deezer:99999999')).toBe('other');
    expect(canonicalScope('olderYounger', 'spotify:42')).toBe('other');
  });

  it('rejects a malformed playlist scope outright', () => {
    expect(canonicalScope('timeline', 'deezer:abc')).toBeNull();
    expect(canonicalScope('timeline', "deezer:1'; DROP TABLE mode_daily;--")).toBeNull();
    expect(canonicalScope('timeline', 'x'.repeat(200))).toBeNull();
    expect(canonicalScope('timeline', 42)).toBeNull();
  });
});

describe('scoreInRange', () => {
  it('accepts a realistic daily time', () => {
    expect(scoreInRange('daily', 62_000)).toBe(true);
  });

  it('rejects an absurd value that would wreck an average', () => {
    expect(scoreInRange('daily', Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(scoreInRange('daily', 1_000)).toBe(false);
    expect(scoreInRange('daily', -5)).toBe(false);
    expect(scoreInRange('timeline', 10_000)).toBe(false);
  });

  it('rejects non-integers and non-numbers', () => {
    expect(scoreInRange('daily', 62_000.5)).toBe(false);
    expect(scoreInRange('daily', NaN)).toBe(false);
    expect(scoreInRange('daily', Infinity)).toBe(false);
    expect(scoreInRange('daily', '62000')).toBe(false);
    expect(scoreInRange('daily', null)).toBe(false);
  });

  it('accepts a zero-point run, which is a real outcome', () => {
    expect(scoreInRange('timeline', 0)).toBe(true);
  });
});
