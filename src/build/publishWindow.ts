/**
 * Which dates may be published at a given moment.
 *
 * This is the whole of the "publish on the day, not in advance" rule, and it is
 * the only thing standing between the site and a readable future archive — so
 * it lives on its own, as a pure function, with tests.
 *
 * THE TIMEZONE PROBLEM, which has no solution on static hosting:
 *
 * A challenge is keyed to the player's LOCAL date (see localDateISO). Kiritimati
 * is UTC+14, so its Tuesday begins 14 hours before Tuesday UTC. For a player
 * there to have a puzzle at their midnight, Tuesday's file must already be on
 * the origin — where everyone else can read it too, Baker Island (UTC-12)
 * included, whose Tuesday starts 26 hours later.
 *
 * So a day's shard is necessarily public for up to ~26 hours before the last
 * player's day begins. Publishing on the day seals the FAR future absolutely;
 * it cannot seal tomorrow. Closing that window needs a server that can refuse a
 * request until the caller's own day has started — see
 * docs/anti-cheat-architecture.md §2.
 */
import { dateForDayIndex, dayIndexFor } from '../engine/daily';

/** The easternmost real offset in use (Kiritimati, Samoa in DST). */
export const MAX_UTC_OFFSET_HOURS = 14;

/**
 * The latest date any player on Earth can currently be on.
 *
 * Deliberately NOT "today in UTC": from 10:00 UTC onward, UTC+14 is already on
 * tomorrow, and serving them yesterday's puzzle would hand a whole timezone the
 * wrong challenge — the mirror image of the toISOString() bug this codebase
 * already guards against.
 */
export function maxPublishableDate(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + MAX_UTC_OFFSET_HOURS * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}`;
}

/**
 * Every date the build should emit: EPOCH through the last currently-reachable
 * day, inclusive. Empty before launch.
 *
 * The whole archive is regenerated on every build rather than accumulated
 * commit by commit. It costs about a second, and it means a missed scheduled
 * run can never leave a hole: the next build of any kind fills it.
 */
export function publishableDates(now: Date = new Date()): string[] {
  const last = dayIndexFor(maxPublishableDate(now));
  if (last < 1) return [];

  const out: string[] = [];
  for (let i = 1; i <= last; i++) out.push(dateForDayIndex(i));
  return out;
}
