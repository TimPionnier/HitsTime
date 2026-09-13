#!/usr/bin/env node
/**
 * Builds an IMMUTABLE pool snapshot for the Daily Challenge.
 *
 * The daily challenge must regenerate identically forever, so it cannot read
 * `date-overrides.json` — that file is rewritten every Monday by the
 * `update-dates` workflow, which would silently rewrite the whole archive.
 * This script takes a one-time photograph of the resolved years instead.
 *
 * Outputs: src/daily/pools/pool-v<N>.json
 *
 * A pool file is written ONCE and then never edited. To add songs, build the
 * next version and register it in src/daily/pools/registry.ts with an
 * `activeFrom` date in the future — past challenges keep using the old pool.
 *
 * Usage:
 *   node scripts/build-daily-pool.mjs [version] [playlist_id]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const VERSION = Number(process.argv[2] || 1);
const PLAYLIST_ID = process.argv[3] || '15689112801';
const API = 'https://api.deezer.com';
const OUTPUT = resolve(__dirname, `../src/daily/pools/pool-v${VERSION}.json`);
const OVERRIDES = resolve(__dirname, '../src/providers/deezer/date-overrides.json');

if (existsSync(OUTPUT)) {
  console.error(
    `${OUTPUT} already exists.\n` +
      `Pool snapshots are immutable — editing one silently rewrites every past\n` +
      `challenge that used it. Build the NEXT version instead:\n` +
      `  node scripts/build-daily-pool.mjs ${VERSION + 1}`,
  );
  process.exit(1);
}

const overrides = JSON.parse(readFileSync(OVERRIDES, 'utf-8'));

// ---------------------------------------------------------------------------
// Helpers — deliberately duplicated from src/providers/deezer/api.ts.
// This is a build script (.mjs) and cannot import the TS module; keeping the
// copy here also means a later refactor of the runtime helpers can never
// retroactively change an already-frozen pool.
// ---------------------------------------------------------------------------

function parseYear(d) {
  if (!d) return null;
  const y = Number(String(d).slice(0, 4));
  if (!Number.isInteger(y) || y < 1000 || y > 2100) return null;
  return y;
}

const normalize = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function cleanTitle(title) {
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
    .replace(/^["\u201C\u201D]+|["\u201C\u201D]+$/g, '')
    .trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      // Deezer signals quota exhaustion with a 200 + error body.
      if (data?.error?.code === 4) {
        await sleep(2000);
        continue;
      }
      return data;
    }
    await sleep(1000 * (attempt + 1));
  }
  throw new Error(`Deezer request failed after retries: ${url}`);
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchPlaylistTracks(playlistId) {
  const tracks = [];
  let index = 0;
  while (tracks.length < 2000) {
    const data = await getJson(`${API}/playlist/${playlistId}/tracks?limit=100&index=${index}`);
    const batch = data.data ?? [];
    if (batch.length === 0) break;
    tracks.push(...batch);
    if (!data.next) break;
    index += 100;
    await sleep(120);
  }
  return tracks;
}

/**
 * Resolve a release year per track, mirroring the runtime rule exactly:
 * manual override first, then the earlier of track.release_date and
 * album.release_date (the original release is always older than a reissue).
 */
async function resolveYear(track) {
  const id = String(track.id);
  if (overrides[id]) return parseYear(overrides[id]);
  const full = await getJson(`${API}/track/${track.id}`);
  const d1 = full?.release_date;
  const d2 = full?.album?.release_date;
  const date = d1 && d2 ? (d1 < d2 ? d1 : d2) : (d1 ?? d2);
  return parseYear(date);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const raw = await fetchPlaylistTracks(PLAYLIST_ID);
console.log(`Fetched ${raw.length} tracks from playlist ${PLAYLIST_ID}`);

// Only tracks that are actually playable can enter the pool — a track without a
// preview would surface later as a silent card in an archived challenge, and
// removing it then would change that day's answer.
const playable = raw.filter((t) => t.readable && t.preview);
console.log(`${playable.length} are readable with a preview`);

const seenIds = new Set();
const seenSongs = new Set();
const tracks = [];
let skipped = 0;

for (let i = 0; i < playable.length; i++) {
  const t = playable[i];
  const id = String(t.id);
  const artist = t.artist?.name ?? '';
  const songKey = normalize(`${artist} ${t.title}`);
  if (seenIds.has(id) || seenSongs.has(songKey)) continue;

  let year = null;
  try {
    year = await resolveYear(t);
  } catch (err) {
    console.warn(`  ! ${artist} — ${t.title}: ${err.message}`);
  }
  if (year === null) {
    skipped++;
    continue;
  }

  seenIds.add(id);
  seenSongs.add(songKey);
  tracks.push({
    id,
    title: cleanTitle(t.title),
    artist,
    year,
    decade: Math.floor(year / 10) * 10,
    cover: t.album?.cover_medium ?? undefined,
  });

  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${playable.length}…`);
  if (!overrides[id]) await sleep(120);
}

// Sorting by id makes the file order part of the contract: a rebuild that
// fetches the playlist in a different order still produces identical bytes.
tracks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const years = new Set(tracks.map((t) => t.year));
const decades = new Set(tracks.map((t) => t.decade));

console.log(
  `\nPool v${VERSION}: ${tracks.length} tracks, ${years.size} distinct years, ${decades.size} decades (${skipped} dropped, no usable date)`,
);

// Guards from the architecture doc §7 — a pool that fails these will deadlock
// the constrained draw or produce monotonous puzzles.
const problems = [];
if (tracks.length < 120) problems.push(`only ${tracks.length} tracks (need >= 120)`);
if (years.size < 25) problems.push(`only ${years.size} distinct years (need >= 25)`);
if (decades.size < 8) problems.push(`only ${decades.size} decades (need >= 8)`);
if (problems.length) {
  console.error(`\nPool rejected:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}

const contentHash = createHash('sha256')
  .update(JSON.stringify(tracks))
  .digest('hex');

writeFileSync(
  OUTPUT,
  JSON.stringify({ version: VERSION, contentHash, tracks }, null, 2) + '\n',
);

console.log(`\nWrote ${OUTPUT}`);
console.log(`contentHash ${contentHash}`);
console.log(`\nNext: register it in src/daily/pools/registry.ts with a FUTURE activeFrom date.`);
