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

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLAYLIST_ID = process.argv[2] || '15689112801';
const DEEZER_API = 'https://api.deezer.com';
const DISCOGS_API = 'https://api.discogs.com';
const DISCOGS_TOKEN = 'OXqSRtMwoprSCPxRbJaVSFWwUEEjMOqZCzEMMRGt';
const DISCOGS_UA = 'HitsTime/1.0';

const __dirname = dirname(fileURLToPath(import.meta.url));
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

async function discogsSearch(artist, title, retries = 3) {
  // Clean up title: remove "(Remastered ...)", "(Remasterisé ...)", "(Radio Edit)", etc.
  const cleanTitle = title
    .replace(/\(Remasteris[ée][^)]*\)/gi, '')
    .replace(/\(Remaster(ed)?[^)]*\)/gi, '')
    .replace(/\(Radio Edit\)/gi, '')
    .replace(/\(Album Version\)/gi, '')
    .replace(/\(Original Version\)/gi, '')
    .replace(/\(Live[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const query = encodeURIComponent(cleanTitle);
  const artistEnc = encodeURIComponent(artist);
  const url = `${DISCOGS_API}/database/search?q=${query}&artist=${artistEnc}&type=release&per_page=10&sort=year&sort_order=asc`;

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

      // Find the earliest year from results
      let earliest = null;
      for (const r of results) {
        const y = parseInt(r.year, 10);
        if (y && y >= 1900 && y <= 2100) {
          if (!earliest || y < earliest) earliest = y;
        }
      }
      return earliest;
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

    // Rate-limit: ~1 req/sec for Discogs (60/min)
    await sleep(1050);

    const discogsYear = await discogsSearch(artist, t.title);

    if (discogsYear) {
      overrides[trackId] = `${discogsYear}-01-01`;
      fixed++;
      process.stdout.write(
        `\r[${checked}/${playlistTracks.length}] ${t.title} — ${discogsYear}\n`,
      );
    } else {
      process.stdout.write(`\r[${checked}/${playlistTracks.length}] ${t.title} — no Discogs data`);
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
