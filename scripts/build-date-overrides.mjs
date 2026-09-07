#!/usr/bin/env node
/**
 * Fetches all tracks from the default Deezer playlist and cross-references
 * their release dates with Discogs (by artist + title search) to find the
 * original parution date.
 *
 * Outputs: src/providers/deezer/date-overrides.json
 *   { "<deezer_track_id>": "YYYY-MM-DD", ... }
 *
 * Manual overrides are preserved — if a track ID already exists in the file,
 * the script will NOT overwrite it. To re-check a track, delete its entry first.
 *
 * Usage:
 *   node scripts/build-date-overrides.mjs [playlist_id]
 *   (defaults to 15689112801 — Blindtest Hitstime)
 *
 * Discogs rate limit: 60 req/min — the script waits 1s between requests.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env file if present (for local use)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.+?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const PLAYLIST_ID = process.argv[2] || '15689112801';
const DEEZER_API = 'https://api.deezer.com';
const DISCOGS_API = 'https://api.discogs.com';
const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN;
if (!DISCOGS_TOKEN) {
  console.error('Missing DISCOGS_TOKEN. Set it in .env or as an environment variable.');
  process.exit(1);
}
const DISCOGS_UA = 'HitsTime/1.0';

const OUTPUT = resolve(__dirname, '../src/providers/deezer/date-overrides.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Deezer: fetch all tracks from the playlist
// ---------------------------------------------------------------------------

async function fetchPlaylistTracks(playlistId) {
  const tracks = [];
  let index = 0;
  while (tracks.length < 1000) {
    const res = await fetch(`${DEEZER_API}/playlist/${playlistId}/tracks?limit=100&index=${index}`);
    const data = await res.json();
    const batch = data.data ?? [];
    if (batch.length === 0) break;
    tracks.push(...batch);
    if (!data.next) break;
    index += 100;
  }
  return tracks;
}

// ---------------------------------------------------------------------------
// Discogs: search by artist + title to get earliest release year
// ---------------------------------------------------------------------------

/**
 * Strip remaster/edition/version suffixes from a track title.
 * Handles both parenthesized and dash-separated patterns, e.g.:
 *   "Heroes (2017 Remaster)" → "Heroes"
 *   "Heroes - 2017 Remaster" → "Heroes"
 *   'Sweet Dreams (Are Made of This) (2005 Remaster)' → 'Sweet Dreams (Are Made of This)'
 */
function cleanTrackTitle(title) {
  return title
    // Parenthesized suffixes
    .replace(/\((?:\d{4}\s+)?Remasteris[ée][^)]*\)/gi, '')
    .replace(/\((?:\d{4}\s+)?Remaster(?:ed)?[^)]*\)/gi, '')
    .replace(/\(Radio\s*Edit\)/gi, '')
    .replace(/\(Album\s*Version\)/gi, '')
    .replace(/\(Original\s*Version[^)]*\)/gi, '')
    .replace(/\(Live[^)]*\)/gi, '')
    .replace(/\(Deluxe[^)]*\)/gi, '')
    .replace(/\(Expanded[^)]*\)/gi, '')
    .replace(/\(\d+th\s+Anniversary[^)]*\)/gi, '')
    .replace(/\(Bonus\s*Track[^)]*\)/gi, '')
    .replace(/\(feat\.[^)]*\)/gi, '')
    .replace(/\(ft\.[^)]*\)/gi, '')
    // Dash-separated suffixes: " - 2017 Remaster", " - Remastered", etc.
    .replace(/\s+-\s+(?:\d{4}\s+)?Remasteris[ée].*$/gi, '')
    .replace(/\s+-\s+(?:\d{4}\s+)?Remaster(?:ed)?.*$/gi, '')
    .replace(/\s+-\s+Deluxe.*$/gi, '')
    .replace(/\s+-\s+Expanded.*$/gi, '')
    .replace(/\s+-\s+\d+th\s+Anniversary.*$/gi, '')
    // Collapse whitespace first, then strip surrounding quotes
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[""\u201C\u201D]+|[""\u201C\u201D]+$/g, '')
    .trim();
}

/**
 * Clean an artist name for search: strip "feat." suffixes, "& ..." collaborators, etc.
 * We keep only the primary artist for more precise Discogs matching.
 */
function cleanArtist(artist) {
  return artist
    .replace(/\s+feat\.?\s+.*/i, '')
    .replace(/\s+ft\.?\s+.*/i, '')
    .replace(/\s+featuring\s+.*/i, '')
    .replace(/\s+&\s+.*/i, '')
    .trim();
}

/** Returns true if a Discogs result title looks like a remaster/compilation. */
function isReissue(resultTitle) {
  return /remaster|deluxe|expanded|anniversary|bonus|compil|greatest\s+hits/i.test(resultTitle ?? '');
}

async function discogsSearch(artist, title, retries = 3) {
  const cleanedTitle = cleanTrackTitle(title);
  const cleanedArtist = cleanArtist(artist);

  const query = encodeURIComponent(cleanedTitle);
  const artistEnc = encodeURIComponent(cleanedArtist);
  const url = `${DISCOGS_API}/database/search?q=${query}&artist=${artistEnc}&type=release&per_page=20&sort=year&sort_order=asc`;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Discogs token=${DISCOGS_TOKEN}`,
          'User-Agent': DISCOGS_UA,
        },
      });
      if (res.status === 429) {
        await sleep(3000);
        continue;
      }
      if (!res.ok) return null;
      const data = await res.json();
      const results = data.results ?? [];

      // Prefer original releases: skip reissues/remasters when possible
      let earliest = null;
      let earliestReissue = null;
      for (const r of results) {
        const y = parseInt(r.year, 10);
        if (!y || y < 1900 || y > 2100) continue;
        if (isReissue(r.title)) {
          if (!earliestReissue || y < earliestReissue) earliestReissue = y;
        } else {
          if (!earliest || y < earliest) earliest = y;
        }
      }
      // Use earliest non-reissue, fall back to earliest reissue if nothing else
      return earliest ?? earliestReissue;
    } catch {
      if (attempt < retries - 1) await sleep(2000);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Fetching tracks from playlist ${PLAYLIST_ID}...`);
  const playlistTracks = await fetchPlaylistTracks(PLAYLIST_ID);
  console.log(`Found ${playlistTracks.length} tracks.`);

  // Load existing overrides (manual entries are preserved)
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(OUTPUT, 'utf-8'));
    console.log(`Loaded ${Object.keys(existing).length} existing overrides.`);
  } catch {
    console.log('No existing overrides file — starting fresh.');
  }

  const saveProgress = () => {
    writeFileSync(OUTPUT, JSON.stringify(overrides, null, 2) + '\n');
  };

  const overrides = { ...existing };
  let checked = 0;
  let fixed = 0;
  let skipped = 0;

  for (const t of playlistTracks) {
    const trackId = String(t.id);
    checked++;

    // Skip if already overridden (preserves manual entries)
    if (overrides[trackId]) {
      skipped++;
      process.stdout.write(`\r[${checked}/${playlistTracks.length}] ${t.title} — cached`);
      continue;
    }

    const artist = t.artist?.name ?? '';
    const cleaned = cleanTrackTitle(t.title);
    const searchInfo = cleaned !== t.title ? `${t.title} → ${cleaned}` : t.title;

    // Rate-limit: ~1 req/sec for Discogs (60/min)
    await sleep(1050);

    const discogsYear = await discogsSearch(artist, t.title);

    if (discogsYear) {
      overrides[trackId] = `${discogsYear}-01-01`;
      fixed++;
      process.stdout.write(
        `\r[${checked}/${playlistTracks.length}] ${searchInfo} — ${discogsYear}\n`,
      );
    } else {
      process.stdout.write(`\r[${checked}/${playlistTracks.length}] ${searchInfo} — no Discogs data\n`);
    }

    // Save progress every 20 tracks
    if (checked % 20 === 0) saveProgress();
  }

  // Final write
  saveProgress();

  console.log(`\n\nDone! ${fixed} new fixes, ${skipped} cached (preserved), ${checked} total.`);
  console.log(`Written to: ${OUTPUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
