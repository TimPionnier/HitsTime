/**
 * Fetches the day's challenge instead of computing it.
 *
 * The client no longer holds the pool or the generator, so there is nothing to
 * read ahead: a date the build has not published yet simply 404s. That is also
 * what makes clock-tampering pointless — setting the system date to next year
 * used to hand the player next year's puzzle, and now returns NotPublishedYet.
 */
import type { DailyChallenge } from '../engine/daily';
import { CARDS_PER_DAY } from '../engine/daily';

/** The day exists in the archive but the build has not published it. */
export class NotPublishedYet extends Error {
  constructor(readonly date: string) {
    super(`No challenge published for ${date}.`);
    this.name = 'NotPublishedYet';
  }
}

const cache = new Map<string, Promise<DailyChallenge>>();

/**
 * Enough of a shape check to fail loudly on a truncated or half-deployed file.
 *
 * A challenge that loads with nine cards would otherwise produce a run that
 * cannot be compared with anyone else's, silently — far worse than an error.
 */
function parse(date: string, data: unknown): DailyChallenge {
  const c = data as Partial<DailyChallenge>;
  if (
    !c ||
    c.date !== date ||
    typeof c.dayIndex !== 'number' ||
    typeof c.seedHex !== 'string' ||
    !c.anchor ||
    !Array.isArray(c.draw) ||
    c.draw.length + 1 !== CARDS_PER_DAY
  ) {
    throw new Error(`Malformed challenge for ${date}.`);
  }
  return c as DailyChallenge;
}

export function loadChallenge(dateISO: string): Promise<DailyChallenge> {
  let p = cache.get(dateISO);
  if (!p) {
    // BASE_URL, not a leading slash: the site is deployed under a repository
    // subpath on GitHub Pages, where '/daily/...' would resolve to the domain
    // root and 404 for every player.
    p = fetch(`${import.meta.env.BASE_URL}daily/${dateISO}.json`, { cache: 'no-cache' })
      .then((res) => {
        if (res.status === 404) throw new NotPublishedYet(dateISO);
        if (!res.ok) throw new Error(`Challenge fetch failed: ${res.status}`);
        return res.json();
      })
      .then((data) => parse(dateISO, data));

    // A failed load must not be cached, or a player who opened the app a minute
    // before their local midnight would keep the 404 for the rest of the day.
    p.catch(() => cache.delete(dateISO));
    cache.set(dateISO, p);
  }
  return p;
}
