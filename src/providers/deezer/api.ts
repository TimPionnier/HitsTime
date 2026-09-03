import type { GameTrack, PlaylistMeta } from '../../engine/types';
import type { RawTrackData } from '../types';
import { shuffle } from '../../engine/game';
import dateOverrides from './date-overrides.json';

const API = 'https://api.deezer.com';

/** Manual date corrections from MusicBrainz cross-reference. */
const overrides = dateOverrides as Record<string, string>;

// ---------------------------------------------------------------------------
// JSONP transport — Deezer doesn't send CORS headers, but supports JSONP.
// ---------------------------------------------------------------------------

let jsonpCounter = 0;

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
      batch.map((id) => jsonp<DzTrackFull>(`${API}/track/${id}`)),
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
      title: t.title,
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
    const data = await jsonp<{ data?: DzTrack[]; next?: string }>(
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
  const data = await jsonp<{ data?: DzPlaylist[] }>(
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
