#!/usr/bin/env node
/**
 * Regenerates src/engine/daily.golden.json — the ordered draw for a spread of
 * known dates.
 *
 * The golden fixture is the strongest single guard in the project: it fails if
 * the pool is edited, if the selection algorithm drifts, if a stray reshuffle
 * creeps back in, or if date handling regresses.
 *
 * ONLY run this when deliberately shipping a new ALGO_VERSION. Regenerating it
 * to make a red test go green silently rewrites the archive.
 *
 * Usage: npx vite-node scripts/build-daily-golden.mjs
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { challengeFor, dateForDayIndex } from '../src/engine/daily.ts';
import { poolVersionFor } from '../src/daily/pools/registry.ts';
import poolV1 from '../src/daily/pools/pool-v1.json' with { type: 'json' };
import poolV2 from '../src/daily/pools/pool-v2.json' with { type: 'json' };

// Every date is drawn from the pool the registry routes it to, as in production.
const POOLS = { 1: poolV1, 2: poolV2 };

const __dirname = dirname(fileURLToPath(import.meta.url));

// Day 1, the first cycle, both sides of two cycle boundaries, and a few far-out
// days — the places where an off-by-one in the cycle maths would show up.
const days = [1, 2, 3, 7, 13, 14, 15, 16, 27, 28, 29, 30, 100, 200, 365, 366, 500, 1000, 1095, 3650];

const out = {};
for (const d of days) {
  const date = dateForDayIndex(d);
  const c = await challengeFor(date, POOLS[poolVersionFor(date)]);
  out[date] = [c.anchor, ...c.draw].map((t) => t.id).join(',');
}

const target = resolve(__dirname, '../src/engine/daily.golden.json');
writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${days.length} golden days to ${target}`);
