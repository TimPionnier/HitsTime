#!/usr/bin/env node
/**
 * Publishes the latest daily challenge as a public Spotify playlist named
 * "HitsTime Daily Challenge #N", through ListenBrainz.
 *
 * Spotify offers no API key, so ListenBrainz does the Spotify side: it holds
 * the OAuth link to the Spotify account, and its export endpoint creates the
 * playlist there. Each export creates a NEW playlist, hence one per day.
 *
 * Idempotency: a playlist titled "#N" is first created on ListenBrainz and
 * that copy is what gets exported. If it already exists, the day was already
 * done and the script exits. A failed export deletes the copy so the next
 * run can retry.
 *
 * Track resolution: Deezer id -> ISRC (Deezer public API) -> MusicBrainz
 * recording that ListenBrainz links to a Spotify track. The exporter only
 * carries such recordings, so the search goes through the ISRC's recordings,
 * then faithful same-song recordings found by name, then any version of the
 * song (a complete playlist matters more than a perfect one).
 *
 * Reads dist/daily/YYYY-MM-DD.json, so run "npx vite build" first.
 *
 *   LISTENBRAINZ_TOKEN=... node scripts/export-daily-playlist.mjs [YYYY-MM-DD] [--dry-run]
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHARD_DIR = resolve(__dirname, "../dist/daily");

const DEEZER_API = "https://api.deezer.com";
const MUSICBRAINZ_API = "https://musicbrainz.org/ws/2";
const LISTENBRAINZ_API = "https://api.listenbrainz.org";
const SPOTIFY_LOOKUP_URL = "https://labs.api.listenbrainz.org/spotify-id-from-mbid/json";
// MusicBrainz rejects anonymous clients and allows about one request per second.
const USER_AGENT = "hitstime-daily-playlist/1.0 (https://github.com/TimPionnier/HitsTime)";
const MUSICBRAINZ_DELAY_MS = 1100;
const MUSICBRAINZ_RETRY_DELAY_MS = 5000;
const MAX_ATTEMPTS = 4;
const LISTED_PLAYLISTS_COUNT = 100;
const SEARCH_LIMIT = 100;
const SEARCH_PAGES = 3;
// Cap on single-recording Spotify checks per track, to bound the run time.
const MAX_LINK_CHECKS = 40;
// Pushes live/remix takes behind any studio-like one in the any-version ranking.
const FALLBACK_ALTERNATE_PENALTY_SECONDS = 1000;
// Wide enough for radio edit vs album version (30 s on "Yeah!"), narrow enough to
// reject most extended mixes and live takes.
const MAX_DURATION_GAP_SECONDS = 45;
const TRACK_EXTENSION_URI = "https://musicbrainz.org/doc/jspf#track";
const PLAYLIST_EXTENSION_URI = "https://musicbrainz.org/doc/jspf#playlist";
const SHARD_NAME = /^(\d{4}-\d{2}-\d{2})\.json$/;
const ALTERNATE_VERSION =
  /\b(live|remix|mix|cover|karaoke|instrumental|acoustic|demo|medley|outtake|take \d+)\b/i;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function latestShardName(fileNames) {
  const shards = fileNames.filter((name) => SHARD_NAME.test(name)).sort();
  return shards.at(-1) ?? null;
}

export function playlistTitle(dayIndex) {
  return `HitsTime Daily Challenge #${dayIndex}`;
}

/** Anchor first, then the ten scored rounds in play order (the playlist reorders them by year). */
export function tracksOf(challenge) {
  return [challenge.anchor, ...challenge.draw];
}

/** Stable: songs from the same year keep their play order. */
export function oldestFirst(resolvedTracks) {
  return [...resolvedTracks].sort((a, b) => a.track.year - b.track.year);
}

/**
 * The extension on every track is required by ListenBrainz's exporter even
 * when empty (it reads it unconditionally).
 */
export function buildJspf(challenge, resolvedTracks) {
  return {
    title: playlistTitle(challenge.dayIndex),
    annotation: `Challenge #${challenge.dayIndex} (${challenge.date})`,
    extension: { [PLAYLIST_EXTENSION_URI]: { public: true } },
    track: oldestFirst(resolvedTracks).map(({ track, mbid }) => ({
      identifier: `https://musicbrainz.org/recording/${mbid}`,
      title: track.title,
      creator: track.artist,
      extension: { [TRACK_EXTENSION_URI]: {} },
    })),
  };
}

class HttpError extends Error {
  constructor(url, status) {
    super(`${url}: HTTP ${status}`);
    this.status = status;
  }
}

// 503 is how MusicBrainz says "slow down", so it is retried with a growing pause.
async function getJson(url, attempt = 1) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (response.status === 503 && attempt < MAX_ATTEMPTS) {
    await sleep(MUSICBRAINZ_RETRY_DELAY_MS * attempt);
    return getJson(url, attempt + 1);
  }
  if (!response.ok) throw new HttpError(url, response.status);
  return response.json();
}

function normalize(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "Libérée, Délivrée (De "La Reine...")" -> "Libérée, Délivrée". */
function baseTitle(title) {
  return title.replace(/\s*[([].*$/, "").replace(/\s+-\s+.*$/, "");
}

// MusicBrainz marks such versions in the title ("(live)") or the disambiguation
// ("part of ... DJ-mix"). Wanted only if our own title says so.
function isAlternateVersion(recording, wantedTitle) {
  const description = `${recording.title} ${recording.disambiguation ?? ""}`;
  return ALTERNATE_VERSION.test(description) && !ALTERNATE_VERSION.test(wantedTitle);
}

// A recording without a length cannot be compared, so it is not excluded.
function durationGap(recording, durationSeconds) {
  if (!recording.length || !durationSeconds) return 0;
  return Math.abs(recording.length / 1000 - durationSeconds);
}

function sameSong(track, recordings) {
  const wantedTitle = normalize(baseTitle(track.title));
  const wantedArtist = normalize(track.artist);

  return recordings.filter((recording) => {
    if (normalize(baseTitle(recording.title)) !== wantedTitle) return false;
    const credited = normalize((recording["artist-credit"] ?? []).map((c) => c.name).join(" "));
    return credited.includes(wantedArtist) || wantedArtist.includes(credited);
  });
}

/**
 * Recordings of the same song that look like the original, best first: not a
 * live take, remix or cover, and a length within MAX_DURATION_GAP_SECONDS of
 * Deezer's, the closest first.
 */
export function rankFaithful(track, durationSeconds, recordings) {
  return sameSong(track, recordings)
    .filter(
      (recording) =>
        !isAlternateVersion(recording, track.title) &&
        durationGap(recording, durationSeconds) <= MAX_DURATION_GAP_SECONDS,
    )
    .sort((a, b) => durationGap(a, durationSeconds) - durationGap(b, durationSeconds));
}

/**
 * Last resort: any version of the same song by the same artist. A complete
 * playlist matters more than a studio-perfect one, so live takes and other
 * lengths are accepted, ranked after faithful versions and then by length.
 */
export function rankAnyVersion(track, durationSeconds, recordings) {
  const rank = (recording) =>
    (isAlternateVersion(recording, track.title) ? FALLBACK_ALTERNATE_PENALTY_SECONDS : 0) +
    durationGap(recording, durationSeconds);
  return sameSong(track, recordings).sort((a, b) => rank(a) - rank(b));
}

async function searchRecordings(track, offset) {
  const query = `recording:"${baseTitle(track.title)}" AND artist:"${track.artist}"`;
  const result = await getJson(
    `${MUSICBRAINZ_API}/recording?query=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}&offset=${offset}&fmt=json`,
  );
  return result.recordings ?? [];
}

async function recordingsForIsrc(isrc) {
  try {
    const result = await getJson(`${MUSICBRAINZ_API}/isrc/${isrc}?fmt=json`);
    return result.recordings ?? [];
  } catch (error) {
    // 404 means the ISRC is unknown to MusicBrainz, which is a normal miss.
    if (error instanceof HttpError && error.status === 404) return [];
    throw error;
  }
}

/**
 * Does ListenBrainz link this ONE recording to Spotify?
 *
 * Always asked for a single recording: with several in one request the answer
 * is unreliable (rows missing, repeated or labelled with another recording),
 * and a wrong "yes" means the exporter later drops the track from the playlist.
 */
async function isLinkedToSpotify(mbid) {
  const response = await fetch(SPOTIFY_LOOKUP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify([{ recording_mbid: mbid }]),
  });
  if (!response.ok) throw new HttpError(SPOTIFY_LOOKUP_URL, response.status);
  const rows = await response.json();
  return rows.some((row) => row.recording_mbid === mbid && row.spotify_track_ids.length > 0);
}

/** First recording of the ranked list that is linked to Spotify, or null. */
async function firstLinked(ranked, checked) {
  for (const recording of ranked) {
    if (!checked.has(recording.id)) {
      if (checked.size >= MAX_LINK_CHECKS) return null;
      checked.set(recording.id, await isLinkedToSpotify(recording.id));
    }
    if (checked.get(recording.id)) return recording;
  }
  return null;
}

/**
 * Finds the recording to put in the playlist, trying in order of fidelity:
 * the ISRC's own recordings, then faithful same-song recordings from a name
 * search (paged), then any version of the song.
 */
async function matchRecording(track, deezer) {
  const checked = new Map();

  await sleep(MUSICBRAINZ_DELAY_MS);
  const byIsrc = deezer.isrc ? await recordingsForIsrc(deezer.isrc) : [];
  const exact = await firstLinked(byIsrc, checked);
  if (exact) return { recording: exact, kind: "ISRC" };

  const seen = [];
  for (let page = 0; page < SEARCH_PAGES; page += 1) {
    await sleep(MUSICBRAINZ_DELAY_MS);
    const recordings = await searchRecordings(track, page * SEARCH_LIMIT);
    seen.push(...recordings);
    const faithful = await firstLinked(rankFaithful(track, deezer.duration, seen), checked);
    if (faithful) return { recording: faithful, kind: "name search" };
    if (recordings.length < SEARCH_LIMIT) break;
  }

  const other = await firstLinked(rankAnyVersion(track, deezer.duration, seen), checked);
  return other ? { recording: other, kind: "other version" } : null;
}

async function resolveTracks(tracks) {
  const resolved = [];
  for (const track of tracks) {
    const label = `${track.artist} - ${track.title}`;
    const deezer = await getJson(`${DEEZER_API}/track/${track.id}`);
    const match = await matchRecording(track, deezer);
    if (!match) {
      console.warn(`No Spotify match for ${label} (ISRC ${deezer.isrc})`);
      continue;
    }
    resolved.push({ track, mbid: match.recording.id });
    if (match.kind !== "ISRC") {
      const seconds = match.recording.length ? Math.round(match.recording.length / 1000) : "?";
      console.log(
        `Matched (${match.kind}): ${label} -> "${match.recording.title}" ${seconds}s (Deezer ${deezer.duration}s)`,
      );
    }
  }
  return resolved;
}

function listenbrainz(token) {
  async function call(method, path, body) {
    const response = await fetch(`${LISTENBRAINZ_API}${path}`, {
      method,
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text}`);
    return JSON.parse(text);
  }

  return {
    async userName() {
      const result = await call("GET", "/1/validate-token");
      if (!result.valid) throw new Error("LISTENBRAINZ_TOKEN is not valid.");
      return result.user_name;
    },
    async playlistTitles(userName) {
      const result = await call(
        "GET",
        `/1/user/${encodeURIComponent(userName)}/playlists?count=${LISTED_PLAYLISTS_COUNT}`,
      );
      return result.playlists.map((entry) => entry.playlist.title);
    },
    async create(jspf) {
      const result = await call("POST", "/1/playlist/create", { playlist: jspf });
      return result.playlist_mbid;
    },
    async exportToSpotify(mbid) {
      const result = await call("POST", `/1/playlist/${mbid}/export/spotify?is_public=true`);
      return result.external_url;
    },
    remove: (mbid) => call("POST", `/1/playlist/${mbid}/delete`),
  };
}

async function main() {
  const token = process.env.LISTENBRAINZ_TOKEN;
  if (!token) throw new Error("LISTENBRAINZ_TOKEN is not set.");

  const dateArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const shardName = dateArg ? `${dateArg}.json` : latestShardName(readdirSync(SHARD_DIR));
  if (!shardName) throw new Error(`No shard found in ${SHARD_DIR}. Run "npx vite build" first.`);
  const challenge = JSON.parse(readFileSync(resolve(SHARD_DIR, shardName), "utf-8"));
  const title = playlistTitle(challenge.dayIndex);

  const dryRun = process.argv.includes("--dry-run");
  const lb = listenbrainz(token);
  const userName = await lb.userName();
  if (!dryRun && (await lb.playlistTitles(userName)).includes(title)) {
    console.log(`"${title}" already exists, nothing to do.`);
    return;
  }

  const resolved = await resolveTracks(tracksOf(challenge));
  if (resolved.length === 0) throw new Error("No track could be matched to Spotify.");
  if (dryRun) {
    console.log(`Dry run "${title}": ${resolved.length}/${tracksOf(challenge).length} tracks.`);
    return;
  }

  const mbid = await lb.create(buildJspf(challenge, resolved));
  try {
    const url = await lb.exportToSpotify(mbid);
    console.log(`"${title}": ${resolved.length}/${tracksOf(challenge).length} tracks -> ${url}`);
  } catch (error) {
    await lb.remove(mbid);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
