import type { GameTrack } from "./types";

/** What the player typed for the mystery song in hard mode. */
export type TrackGuess = {
  title: string;
  artist: string;
};

export type GuessResult = {
  titleFound: boolean;
  artistFound: boolean;
};

export const EMPTY_GUESS: TrackGuess = { title: "", artist: "" };

/** Free-play timeline: points earned when both the title and the artist are right. */
export const GUESS_BONUS_POINTS = 2;

/** Below this length a single typo changes the word too much to be forgiven. */
const MIN_LENGTH_FOR_TYPOS = 5;
const CHARS_PER_TYPO = 5;
const MAX_TYPOS = 3;

/** A co-credited artist shorter than this is not accepted alone ("M", "U2" stay whole-name only). */
const MIN_ARTIST_PART_LENGTH = 4;

const BRACKETED = /\([^)]*\)|\[[^\]]*\]/g;
const BRACKET_CHARS = /[()[\]]/g;
/** " - Remastered 2011", " - Radio Edit", " - Live at Wembley"... */
const VERSION_SUFFIX =
  /\s-\s.*\b(?:remaster(?:ed)?|version|edit|mix|remix|live|mono|stereo|single|bonus|original|acoustic|deluxe|anniversary)\b.*$/;
const FEATURING = /\s(?:feat|ft|featuring)\b.*$/;
const LEADING_ARTICLE = /^(?:(?:the|le|la|les)\s+|l')/;
const ARTIST_SEPARATOR =
  /\s*(?:,|\+|\/|\band\b|\bet\b|\bfeat\b\.?|\bft\b\.?|\bfeaturing\b|\bvs\b\.?)\s*/;
const DIACRITICS = /\p{M}/gu;
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]/gu;

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/&/g, " and ")
    .trim();
}

/**
 * Comparison key: folded, leading article dropped, then every space and
 * punctuation mark removed so "D.A.N.C.E", "dance" and "d a n c e" are equal.
 */
export function normalizeGuess(text: string): string {
  const folded = fold(text);
  const withoutArticle = folded.replace(LEADING_ARTICLE, "");
  const compact = withoutArticle.replace(NOT_LETTER_OR_DIGIT, "");
  // "The The" must not normalize to nothing.
  return compact.length > 0 ? compact : folded.replace(NOT_LETTER_OR_DIGIT, "");
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

/** Typos forgiven for an answer of `length` normalized characters. */
export function allowedTypos(length: number): number {
  if (length < MIN_LENGTH_FOR_TYPOS) return 0;
  return Math.min(MAX_TYPOS, Math.floor(length / CHARS_PER_TYPO));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function titleAnswers(title: string): string[] {
  const folded = fold(title);
  const clean = (text: string): string => text.replace(VERSION_SUFFIX, "").replace(FEATURING, "");
  // Both readings of a bracket are accepted: "(I Can't Get No) Satisfaction"
  // is commonly typed with and without its bracketed part.
  const withoutBrackets = clean(folded.replace(BRACKETED, " "));
  const withBracketText = clean(folded.replace(BRACKET_CHARS, " "));
  return unique([normalizeGuess(withoutBrackets), normalizeGuess(withBracketText)]);
}

function artistAnswers(artist: string): string[] {
  const folded = fold(artist);
  const parts = folded
    .split(ARTIST_SEPARATOR)
    .map(normalizeGuess)
    .filter((part) => part.length >= MIN_ARTIST_PART_LENGTH);
  return unique([normalizeGuess(folded), ...parts]);
}

function matchesAny(guess: string, answers: string[]): boolean {
  const typed = normalizeGuess(guess);
  if (typed.length === 0) return false;
  return answers.some((answer) => levenshtein(typed, answer) <= allowedTypos(answer.length));
}

export function matchesTitle(guess: string, title: string): boolean {
  return matchesAny(guess, titleAnswers(title));
}

/** One of several co-credited artists is enough. */
export function matchesArtist(guess: string, artist: string): boolean {
  return matchesAny(guess, artistAnswers(artist));
}

export function checkGuess(
  guess: TrackGuess,
  track: Pick<GameTrack, "title" | "artist">,
): GuessResult {
  return {
    titleFound: matchesTitle(guess.title, track.title),
    artistFound: matchesArtist(guess.artist, track.artist),
  };
}

/** The bonus needs both answers; one alone earns nothing. */
export function isFullGuess(result: Partial<GuessResult>): boolean {
  return result.titleFound === true && result.artistFound === true;
}
