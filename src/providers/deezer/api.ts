import type { GameTrack, PlaylistMeta } from '../../engine/types';
import type { RawTrackData } from '../types';
import { shuffle } from '../../engine/game';
import dateOverrides from './date-overrides.json';
import { RateLimiter, isTransientDeezerError } from './rateLimit';

const API = 'https://api.deezer.com';

/** Manual date corrections from MusicBrainz cross-reference. */
const overrides = dateOverrides as Record<string, string>;

// ---------------------------------------------------------------------------
// JSONP transport — Deezer doesn't send CORS headers, but supports JSONP.
// ---------------------------------------------------------------------------

let jsonpCounter = 0;

/**
 * Deezer's public API allows 50 requests per rolling 5 seconds, then answers
 * {"error":{"code":4,"message":"Quota limit exceeded"}} for ~5s.
 *
 * Two things made that bite:
 *   - JSONP RESOLVES with that error body instead of rejecting, so a quota hit
 *     was indistinguishable from a real answer and surfaced to the player as
 *     "this song has no preview" — a permanent-sounding message for a
 *     condition that clears itself in five seconds;
 *   - booting the app costs ~44 requests (playlist pagination + the 40 track
 *     lookups behind the regular-mode prefetch), so anything else asked for in
 *     the same window went over the line.
 *
 * The limiter below keeps us under the ceiling, and dzRequest retries the
 * errors that mean "ask again shortly".
 */
const RATE_WINDOW_MS = 5000;
const limiter = new RateLimiter({ windowMs: RATE_WINDOW_MS, max: 45 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DzError {
  error?: { code?: number; message?: string };
}

/**
 * The only entry point that should be used for Deezer calls: rate-limited, and
 * it turns a transient quota error into a retry instead of a fake answer.
 */
async function dzRequest<T>(url: string, attempts = 4): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await limiter.acquire();
    let data: T;
    try {
      data = await jsonp<T>(url);
    } catch (err) {
      if (attempt >= attempts - 1) throw err;
      await sleep(400 * (attempt + 1));
      continue;
    }
    const code = (data as DzError)?.error?.code;
    if (code === undefined) return data;
    if (!isTransientDeezerError(code) || attempt >= attempts - 1) {
      throw new Error(`Deezer error ${code}: ${(data as DzError).error?.message ?? url}`);
    }
    // The window is 5s wide, so waiting it out is the fastest way through.
    await sleep(RATE_WINDOW_MS + 250 * attempt);
  }
}

function jsonp<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const cbName = `__dz_cb_${++jsonpCounter}_${Date.now()}`;
    const script = document.createElement('script');

    const cleanup = () => {
      delete (window as unknown as Record<string, unknown>)[cbName];
      script.remove();
    };

    (window as unknown as Record<string, unknown>)[cbName] = (data: T) => {
      cleanup();
      resolve(data);
    };

    script.src = `${url}${url.includes('?') ? '&' : '?'}output=jsonp&callback=${cbName}`;
    script.onerror = () => {
      cleanup();
      reject(new Error(`Deezer request failed: ${url}`));
    };

    document.head.appendChild(script);
  });
}

// ---------------------------------------------------------------------------
// Types matching Deezer's JSON shapes
// ---------------------------------------------------------------------------

interface DzPlaylist {
  id: number;
  title: string;
  nb_tracks: number;
  picture_medium?: string;
  user?: { name?: string };
}

export interface DzTrack {
  id: number;
  title: string;
  preview: string; // 30s MP3 URL
  readable: boolean;
  artist?: { name?: string };
  album?: { id?: number; title?: string; cover_medium?: string };
}

interface DzTrackFull {
  id: number;
  /** Top-level release_date is the original; album.release_date can be a reissue. */
  release_date?: string;
  album?: { release_date?: string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPlaylistMeta(p: DzPlaylist): PlaylistMeta {
  return {
    id: String(p.id),
    name: p.title,
    cover: p.picture_medium,
    trackCount: p.nb_tracks,
    owner: p.user?.name,
  };
}

/** "1973-05-11" | "1973-05" | "1973" → 1973 */
function parseYear(d: string | undefined | null): number | null {
  if (!d) return null;
  const y = Number(d.slice(0, 4));
  if (!Number.isInteger(y) || y < 1000 || y > 2100) return null;
  return y;
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Strip remaster/edition suffixes from track titles for cleaner display. */
function cleanTitle(title: string): string {
  return title
    .replace(/\((?:\d{4}\s+)?Remasteris[ée][^)]*\)/gi, '')
    .replace(/\((?:\d{4}\s+)?Remaster(?:ed)?[^)]*\)/gi, '')
    .replace(/\(Radio\s*Edit\)/gi, '')
    .replace(/\(Album\s*Version\)/gi, '')
    .replace(/\(Original\s*Version[^)]*\)/gi, '')
    .replace(/\(Deluxe[^)]*\)/gi, '')
    .replace(/\(Expanded[^)]*\)/gi, '')
    .replace(/\(\d+th\s+Anniversary[^)]*\)/gi, '')
    .replace(/\s+-\s+(?:\d{4}\s+)?Remasteris[ée].*$/gi, '')
    .replace(/\s+-\s+(?:\d{4}\s+)?Remaster(?:ed)?.*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[""\u201C\u201D]+|[""\u201C\u201D]+$/g, '')
    .trim();
}

/**
 * Fetch release dates by calling /track/{id} for each track.
 * The full track endpoint returns album.release_date with the original date,
 * unlike /album/{id} which can return reissue/remaster dates.
 * Requests are batched in parallel (up to 10 at a time) for speed.
 */
async function fetchTrackDates(trackIds: number[]): Promise<Map<number, string>> {
  const dates = new Map<number, string>();
  const BATCH = 10;

  for (let i = 0; i < trackIds.length; i += BATCH) {
    const batch = trackIds.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map((id) => dzRequest<DzTrackFull>(`${API}/track/${id}`)),
    );
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const t = result.value;
        // Use the earlier of track.release_date and album.release_date,
        // since the original release is always older than any reissue.
        const d1 = t.release_date;
        const d2 = t.album?.release_date;
        const date = d1 && d2 ? (d1 < d2 ? d1 : d2) : d1 ?? d2;
        if (date) dates.set(t.id, date);
      }
    }
  }

  return dates;
}

function toGameTracks(
  tracks: DzTrack[],
  trackDates: Map<number, string>,
): GameTrack[] {
  const seenIds = new Set<string>();
  const seenSongs = new Set<string>();
  const out: GameTrack[] = [];

  for (const t of tracks) {
    if (!t.readable || !t.preview) continue;
    const id = String(t.id);
    // Check manual overrides first, then API dates
    const releaseDate = overrides[id] ?? trackDates.get(t.id);
    const year = parseYear(releaseDate);
    if (year === null) continue;

    const artist = t.artist?.name ?? '';
    const songKey = normalize(`${artist} ${t.title}`);
    if (seenIds.has(id) || seenSongs.has(songKey)) continue;
    seenIds.add(id);
    seenSongs.add(songKey);

    out.push({
      id,
      title: cleanTitle(t.title),
      artist,
      year,
      cover: t.album?.cover_medium,
      providerData: { previewUrl: t.preview },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Paginated track listing (fast — no album date resolution)
// ---------------------------------------------------------------------------

async function fetchAllDzTracks(playlistId: string): Promise<DzTrack[]> {
  const allTracks: DzTrack[] = [];
  let index = 0;
  const limit = 100;

  while (allTracks.length < 500) {
    const data = await dzRequest<{ data?: DzTrack[]; next?: string }>(
      `${API}/playlist/${playlistId}/tracks?limit=${limit}&index=${index}`,
    );
    const batch = data.data ?? [];
    if (batch.length === 0) break;
    allTracks.push(...batch);
    if (!data.next) break;
    index += limit;
  }

  // Pre-filter to only readable tracks with a preview
  return allTracks.filter((t) => t.readable && t.preview);
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function searchPlaylists(query: string): Promise<PlaylistMeta[]> {
  const q = query.trim();
  if (!q) return [];
  const data = await dzRequest<{ data?: DzPlaylist[] }>(
    `${API}/search/playlist?q=${encodeURIComponent(q)}&limit=25`,
  );
  return (data.data ?? []).map(toPlaylistMeta);
}

/** Full fetch: gets all tracks and resolves dates via /track/{id}. Used as fallback. */
export async function getPlayableTracks(playlistId: string): Promise<GameTrack[]> {
  const allTracks = await fetchAllDzTracks(playlistId);
  const trackIds = allTracks.map((t) => t.id);
  const trackDates = await fetchTrackDates(trackIds);
  return toGameTracks(allTracks, trackDates);
}

/**
 * Fast: fetch the track listing without resolving album dates.
 * Returns DzTrack[] as unresolvedTracks for later batch resolution.
 */
export async function getRawTrackList(playlistId: string): Promise<RawTrackData> {
  const dzTracks = await fetchAllDzTracks(playlistId);
  return {
    tracks: [],
    unresolvedTracks: dzTracks,
    totalCount: dzTracks.length,
  };
}

/**
 * Randomly sample `count` tracks from the raw listing, resolve their album dates,
 * and return fully playable GameTrack[]. Much faster than resolving all 500.
 */
export async function resolveTrackBatch(
  raw: RawTrackData,
  count: number,
  excludeIds?: Set<string>,
): Promise<GameTrack[]> {
  let dzTracks = raw.unresolvedTracks as DzTrack[];
  if (!dzTracks || dzTracks.length === 0) return [];

  // Filter out already-used tracks
  if (excludeIds && excludeIds.size > 0) {
    dzTracks = dzTracks.filter((t) => !excludeIds.has(String(t.id)));
  }

  // Shuffle and take more than needed to account for tracks that fail date resolution
  const candidates = shuffle(dzTracks).slice(0, Math.min(count + 30, dzTracks.length));

  const trackIds = candidates.map((t) => t.id);
  const trackDates = await fetchTrackDates(trackIds);
  const resolved = toGameTracks(candidates, trackDates);

  return resolved.slice(0, count);
}

/**
 * Resolve playback data for a FIXED, ordered list of track ids.
 *
 * Daily mode cannot use resolveTrackBatch: that one shuffles its candidates, so
 * every player would receive the same songs in a different order — generation
 * would still be perfectly deterministic while comparability quietly died,
 * since a card is far easier to place against a 3-card timeline than a 9-card
 * one. Here the ids are already decided; Deezer is only asked for the preview.
 *
 * `raw` is the playlist listing the app already paginated at boot. Its entries
 * carry `preview` and the cover, so passing it resolves the whole day for FREE
 * instead of spending 11 more calls against a 50-per-5s budget that boot has
 * already largely spent.
 *
 * A track whose preview has since expired returns no previewUrl rather than
 * being dropped: the challenge IS those ids, and substituting one would change
 * an archived day's answer.
 */
export async function getPlaybackData(
  ids: string[],
  raw?: RawTrackData,
): Promise<Map<string, { previewUrl?: string; cover?: string }>> {
  const out = new Map<string, { previewUrl?: string; cover?: string }>();

  const cached = (raw?.unresolvedTracks as DzTrack[] | undefined) ?? [];
  const byId = new Map(cached.map((t) => [String(t.id), t]));
  const missing: string[] = [];

  for (const id of ids) {
    const hit = byId.get(id);
    if (hit?.preview && hit.readable !== false) {
      out.set(id, { previewUrl: hit.preview, cover: hit.album?.cover_medium });
    } else {
      missing.push(id);
    }
  }

  const BATCH = 10;
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map((id) => dzRequest<DzTrack>(`${API}/track/${id}`)),
    );
    results.forEach((result, j) => {
      const id = batch[j];
      if (result.status === 'fulfilled' && result.value?.id) {
        const t = result.value;
        out.set(id, {
          previewUrl: t.readable === false ? undefined : t.preview || undefined,
          cover: t.album?.cover_medium,
        });
      } else {
        // Resolution failed rather than "this track has no preview". Left empty
        // so the caller can retry it lazily at play time.
        out.set(id, {});
      }
    });
  }

  return out;
}

/** Re-resolve one track — used when a preview turns out to be missing at play time. */
export async function getOnePlayback(
  id: string,
): Promise<{ previewUrl?: string; cover?: string }> {
  const t = await dzRequest<DzTrack>(`${API}/track/${id}`);
  return {
    previewUrl: t?.readable === false ? undefined : t?.preview || undefined,
    cover: t?.album?.cover_medium,
  };
}
