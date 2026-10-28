/**
 * Link to the Spotify playlist of a daily challenge.
 *
 * The playlist is created by a scheduled workflow a few minutes AFTER the site is
 * deployed, so its address cannot be baked into the build. The workflow records
 * it in a small JSON file on the `data` branch instead, and the end screen reads
 * it from there. A missing file, a missing day or a network error all mean "no
 * link": the playlist is a bonus and never blocks the end screen.
 */

const DEFAULT_PLAYLISTS_URL =
  "https://raw.githubusercontent.com/TimPionnier/HitsTime/data/playlists.json";

const SPOTIFY_PLAYLIST_PREFIX = "https://open.spotify.com/playlist/";

export type PlaylistLinks = Record<string, { date: string; url: string }>;

/**
 * Only a Spotify playlist address is ever accepted, so the data file cannot turn
 * the button into a link to anywhere else.
 */
export function parsePlaylistUrl(data: unknown, dayIndex: number): string | null {
  if (typeof data !== "object" || data === null) return null;
  const entry: unknown = (data as Record<string, unknown>)[String(dayIndex)];
  if (typeof entry !== "object" || entry === null) return null;
  const url: unknown = (entry as Record<string, unknown>).url;
  if (typeof url !== "string") return null;
  return url.startsWith(SPOTIFY_PLAYLIST_PREFIX) ? url : null;
}

let cached: Promise<unknown> | null = null;

function loadPlaylists(): Promise<unknown> {
  if (cached) return cached;
  // Overridable so a local run can point at a file of its own.
  const url = String(import.meta.env.VITE_PLAYLISTS_URL ?? "") || DEFAULT_PLAYLISTS_URL;
  cached = fetch(url)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  return cached;
}

export async function fetchPlaylistUrl(dayIndex: number): Promise<string | null> {
  return parsePlaylistUrl(await loadPlaylists(), dayIndex);
}
