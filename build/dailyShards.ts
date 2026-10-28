/**
 * Emits one JSON shard per playable day, at build time.
 *
 * This is the substance of Phase 1 of docs/anti-cheat-architecture.md. The
 * browser used to receive the frozen pool — 388 tracks with their years — AND
 * the generator, which together are every past and future challenge, obtainable
 * in one console line. Now it receives eleven songs for one date, and the pool
 * never leaves the repo.
 *
 * A Vite plugin rather than a standalone script, for two reasons: the generator
 * is TypeScript with extensionless imports, which Node cannot run without a
 * loader, and running inside the build means dev and production take exactly
 * the same path.
 *
 * Determinism is untouched. This calls the same challengeFor() the client used
 * to call, against the same frozen pool; only the location changed.
 * src/engine/daily.golden.json still pins the output.
 */
import type { Plugin } from 'vite';

import { challengeFor, type DailyChallenge, type DailyPool } from '../src/engine/daily';
import { poolVersionFor } from '../src/daily/pools/registry';
import { publishableDates } from '../src/build/publishWindow';
import poolV1 from '../src/daily/pools/pool-v1.json';
import poolV2 from '../src/daily/pools/pool-v2.json';

/**
 * Every frozen pool, imported statically.
 *
 * Deliberately a hand-maintained map rather than a dynamic read of the pools
 * directory: adding a version is already a two-step ritual (build the snapshot,
 * register an activeFrom), and a third explicit line is cheaper than a glob
 * that silently picks up a half-finished file.
 */
const POOLS: Record<number, DailyPool> = { 1: poolV1 as DailyPool, 2: poolV2 as DailyPool };

function poolFor(dateISO: string): DailyPool {
  const version = poolVersionFor(dateISO);
  const pool = POOLS[version];
  if (!pool) {
    throw new Error(
      `No pool v${version} imported in build/dailyShards.ts, but the registry ` +
        `activates it for ${dateISO}. Add it to POOLS.`,
    );
  }
  return pool;
}

export async function generateShards(now = new Date()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const date of publishableDates(now)) {
    const challenge: DailyChallenge = await challengeFor(date, poolFor(date));
    out.set(date, JSON.stringify(challenge));
  }
  return out;
}

export function dailyShards(): Plugin {
  return {
    name: 'hitstime:daily-shards',

    /**
     * Generated per request in dev rather than up front, so a machine left
     * running past midnight serves the new day without a restart — and so the
     * repo never accumulates generated files.
     */
    configureServer(server) {
      server.middlewares.use((req: { url?: string }, res, next) => {
        const match = /^\/daily\/(\d{4}-\d{2}-\d{2})\.json$/.exec((req.url ?? '').split('?')[0]);
        if (!match) return next();

        const date = match[1];
        // The publish window is re-evaluated on every request; a date outside
        // it must 404 exactly as it would in production.
        generateShards()
          .then((shards) => {
            const body = shards.get(date);
            if (!body) {
              res.statusCode = 404;
              res.end('Not published yet');
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(body);
          })
          .catch(next);
      });
    },

    async generateBundle() {
      const shards = await generateShards();
      for (const [date, source] of shards) {
        // emitFile, not a write into public/: nothing lands in the working
        // tree, so a stale tomorrow.json from an earlier build cannot survive
        // into a later one — which would be precisely the leak this closes.
        this.emitFile({ type: 'asset', fileName: `daily/${date}.json`, source });
      }
      this.info(`daily: ${shards.size} shard(s) published through today`);
    },
  };
}
