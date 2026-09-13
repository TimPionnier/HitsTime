import { describe, expect, it } from 'vitest';
import { EPOCH, dateForDayIndex, dayIndexFor } from '../engine/daily';
import { MAX_UTC_OFFSET_HOURS, maxPublishableDate, publishableDates } from './publishWindow';

const at = (iso: string) => new Date(iso);

describe('maxPublishableDate', () => {
  it('is today in UTC before the eastern rollover', () => {
    expect(maxPublishableDate(at('2026-09-20T09:00:00Z'))).toBe('2026-09-20');
  });

  /**
   * The rule the whole design rests on: at 10:00 UTC, Kiritimati (UTC+14) has
   * already begun the 21st. Publishing only through the 20th would hand a whole
   * timezone the wrong puzzle.
   */
  it('rolls to tomorrow once UTC+14 has started its day', () => {
    expect(maxPublishableDate(at('2026-09-20T10:00:00Z'))).toBe('2026-09-21');
    expect(maxPublishableDate(at('2026-09-20T23:59:00Z'))).toBe('2026-09-21');
  });

  it('never publishes further than one day ahead of UTC', () => {
    for (let h = 0; h < 24; h++) {
      const now = at(`2026-09-20T${String(h).padStart(2, '0')}:30:00Z`);
      const ahead = dayIndexFor(maxPublishableDate(now)) - dayIndexFor('2026-09-20');
      expect(ahead, `${h}:30 UTC`).toBeLessThanOrEqual(1);
      expect(ahead, `${h}:30 UTC`).toBeGreaterThanOrEqual(0);
    }
  });

  it('matches the offset it claims to cover', () => {
    expect(MAX_UTC_OFFSET_HOURS).toBe(14);
  });
});

describe('publishableDates', () => {
  it('is empty before the epoch — nothing is playable yet', () => {
    expect(publishableDates(at('2020-01-01T00:00:00Z'))).toEqual([]);
  });

  it('starts at the epoch and runs to the window edge, with no gaps', () => {
    const dates = publishableDates(at('2026-09-20T09:00:00Z'));
    expect(dates[0]).toBe(EPOCH);
    expect(dates.at(-1)).toBe('2026-09-20');
    expect(dates.length).toBe(dayIndexFor('2026-09-20'));
    dates.forEach((d, i) => expect(d).toBe(dateForDayIndex(i + 1)));
  });

  it('publishes exactly one day on the epoch itself', () => {
    expect(publishableDates(at('2026-09-13T09:00:00Z'))).toEqual([EPOCH]);
  });

  // The point of the whole exercise: a date beyond the window has no file, so
  // a player who winds their clock forward gets a 404 rather than the answers.
  it('never contains a date beyond the window', () => {
    const now = at('2026-09-20T09:00:00Z');
    expect(publishableDates(now)).not.toContain('2026-09-21');
  });
});
