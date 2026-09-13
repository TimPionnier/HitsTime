import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker, { MIN_SAMPLE, SCORED_RUNS_CAP } from './index';
import type { Env } from './env';
import { FakeDb } from './fakeDb';

const ORIGIN = 'https://tpionnier.github.io';

/**
 * Fixed clock.
 *
 * Not a convenience: the elapsed-time clamp compares a claimed score against
 * how long the ticket has existed, so a test that starts and finishes in the
 * same millisecond makes every honest run look like an overrun. Time has to be
 * advanced deliberately, the way a real run advances it.
 */
const T0 = Date.parse('2026-09-13T12:00:00Z');

let db: FakeDb;
let env: Env;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  db = new FakeDb();
  env = {
    DB: db,
    TICKET_KEY: 'k-ticket',
    SALT_KEY: 'k-salt',
    ALLOWED_ORIGINS: `${ORIGIN},http://127.0.0.1:5173`,
  };
});

function req(
  path: string,
  init: { method?: string; body?: unknown; ip?: string; ua?: string; origin?: string | null } = {},
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'cf-connecting-ip': init.ip ?? '203.0.113.7',
    'user-agent': init.ua ?? 'TestAgent/1.0',
  };
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  if (body) headers['content-length'] = String(body.length);
  return new Request(`https://api.test${path}`, { method: init.method ?? 'GET', headers, body });
}

async function start(body: unknown, opts: { ip?: string } = {}): Promise<Response> {
  return worker.fetch(req('/v1/start', { method: 'POST', body, ...opts }), env);
}

async function ticketFor(mode: string, scope: string, ip = '203.0.113.7'): Promise<string> {
  const res = await start({ mode, scope }, { ip });
  const { ticket } = (await res.json()) as { ticket: string };
  return ticket;
}

async function finish(body: unknown): Promise<Response> {
  return worker.fetch(req('/v1/finish', { method: 'POST', body }), env);
}

afterEach(() => {
  vi.useRealTimers();
});

/** Start a run, let `scoreMs` of wall time pass, then report it. */
async function play(
  body: Record<string, unknown>,
  opts: { mode?: string; scope?: string; ip?: string; elapsedMs?: number } = {},
): Promise<Response> {
  const mode = opts.mode ?? 'daily';
  const ticket = await ticketFor(mode, opts.scope ?? 'd:2026-09-13', opts.ip);
  const advance = opts.elapsedMs ?? (typeof body.score === 'number' ? (body.score as number) : 0);
  vi.setSystemTime(Date.now() + advance);
  return finish({ ticket, ...body });
}

async function stats(query: string): Promise<Record<string, unknown>> {
  const res = await worker.fetch(req(`/v1/stats?${query}`), env);
  return (await res.json()) as Record<string, unknown>;
}

describe('POST /v1/start', () => {
  it('issues a ticket and counts the start', async () => {
    const res = await start({ mode: 'daily', scope: 'd:2026-09-13' });
    expect(res.status).toBe(200);
    expect((await res.json() as { ticket: string }).ticket).toMatch(/^[\w-]+\.[\w-]+$/);

    const agg = [...db.agg.values()][0];
    expect(agg.starts).toBe(1);
    expect(agg.direction).toBe('min');
  });

  it('rejects an unknown mode', async () => {
    expect((await start({ mode: 'speedrun', scope: 'd:2026-09-13' })).status).toBe(400);
  });

  it('rejects a malformed scope', async () => {
    expect((await start({ mode: 'daily', scope: 'nope' })).status).toBe(400);
    expect((await start({ mode: 'timeline', scope: 'deezer:abc' })).status).toBe(400);
  });

  it('refuses a daily date from the far future', async () => {
    // Clock-forwarding a client must not create a row for next year.
    expect((await start({ mode: 'daily', scope: 'd:2031-01-01' })).status).toBe(400);
  });

  it('collapses uncurated playlists into one row', async () => {
    await start({ mode: 'timeline', scope: 'deezer:111' });
    await start({ mode: 'timeline', scope: 'deezer:222' });
    await start({ mode: 'timeline', scope: 'deezer:333' });

    // The cardinality attack: three ids, one row.
    expect(db.agg.size).toBe(1);
    expect([...db.agg.values()][0].scope).toBe('other');
  });

  it('keeps the curated playlist separate', async () => {
    await start({ mode: 'timeline', scope: 'deezer:15689112801' });
    expect([...db.agg.values()][0].scope).toBe('deezer:15689112801');
  });

  it('stops issuing tickets past the daily start cap', async () => {
    for (let i = 0; i < 200; i++) await start({ mode: 'daily', scope: 'd:2026-09-13' });
    const res = await start({ mode: 'daily', scope: 'd:2026-09-13' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
  });

  it('counts two different visitors separately', async () => {
    await start({ mode: 'daily', scope: 'd:2026-09-13' }, { ip: '203.0.113.7' });
    await start({ mode: 'daily', scope: 'd:2026-09-13' }, { ip: '203.0.113.8' });
    expect(db.visitors.size).toBe(2);
  });

  it('counts one visitor once however many runs they start', async () => {
    await start({ mode: 'daily', scope: 'd:2026-09-13' });
    await start({ mode: 'daily', scope: 'd:2026-09-13' });
    expect(db.visitors.size).toBe(1);
  });
});

describe('POST /v1/finish', () => {
  it('records a clean run', async () => {
    expect((await play({ score: 62_000, cleared: true, errors: 0, peeks: 0 })).status).toBe(204);

    const agg = [...db.agg.values()][0];
    expect(agg.finishes).toBe(1);
    expect(agg.score_count).toBe(1);
    expect(agg.score_sum).toBe(62_000);
    expect([...db.buckets.values()].reduce((n, b) => n + b.n, 0)).toBe(1);
  });

  it('refuses a run with no ticket', async () => {
    expect((await finish({ score: 62_000, cleared: true })).status).toBe(400);
  });

  it('refuses a forged ticket', async () => {
    expect((await finish({ ticket: 'abc.def', score: 62_000 })).status).toBe(400);
  });

  it('refuses a replay of the same ticket', async () => {
    const ticket = await ticketFor('daily', 'd:2026-09-13');
    vi.setSystemTime(Date.now() + 62_000);
    expect((await finish({ ticket, score: 62_000 })).status).toBe(204);

    // The flood this blocks: one good ticket, a thousand submissions.
    const again = await finish({ ticket, score: 62_000 });
    expect(again.status).toBe(409);
    expect([...db.agg.values()][0].score_count).toBe(1);
  });

  it('refuses an out-of-range score', async () => {
    const ticket = await ticketFor('daily', 'd:2026-09-13');
    expect((await finish({ ticket, score: Number.MAX_SAFE_INTEGER })).status).toBe(400);
  });

  it('counts a peeked run but keeps it out of the average', async () => {
    // The revision that mattered: a 5-minute heuristic penalty inside a
    // distribution measured in seconds would make the mean fiction.
    await play({ score: 362_000, cleared: true, errors: 0, peeks: 1 });

    const agg = [...db.agg.values()][0];
    expect(agg.finishes).toBe(1);
    expect(agg.peeked).toBe(1);
    expect(agg.score_count).toBe(0);
    expect(agg.score_sum).toBe(0);
    expect(db.buckets.size).toBe(0);
  });

  it('counts a suspect run but keeps it out of the average', async () => {
    await play({ score: 11_000, cleared: true, suspect: true });

    const agg = [...db.agg.values()][0];
    expect(agg.finishes).toBe(1);
    expect(agg.suspect).toBe(1);
    expect(agg.score_count).toBe(0);
  });

  it('keeps a daily run claiming more time than the ticket has existed out of the average', async () => {
    // 40 minutes claimed against a ticket seconds old.
    await play({ score: 2_400_000, cleared: true }, { elapsedMs: 3_000 });

    const agg = [...db.agg.values()][0];
    expect(agg.finishes).toBe(1);
    expect(agg.score_count).toBe(0);
  });

  it('never rejects a fast run — a quick player is not a cheat', async () => {
    // 21 s claimed after 21 s of real time: honest, unusual, and counted.
    const res = await play({ score: 21_000, cleared: true });
    expect(res.status).toBe(204);
    expect([...db.agg.values()][0].score_count).toBe(1);
  });

  it('caps how many runs one visitor contributes to the average', async () => {
    for (let i = 0; i < SCORED_RUNS_CAP + 3; i++) {
      await play({ score: 60_000 + i, cleared: true });
    }
    const agg = [...db.agg.values()][0];
    expect(agg.finishes).toBe(SCORED_RUNS_CAP + 3);
    expect(agg.score_count).toBe(SCORED_RUNS_CAP);
  });

  it('books a run under the day its ticket was issued', async () => {
    const ticket = await ticketFor('timeline', 'deezer:15689112801');
    // Across UTC midnight: the finish must land on the start's row.
    vi.setSystemTime(Date.parse('2026-09-14T00:00:30Z'));
    await finish({ ticket, score: 7, cleared: false });
    // One row, not one for the start and another for the finish.
    expect(db.agg.size).toBe(1);
  });
});

describe('GET /v1/stats', () => {
  async function seed(n: number, score = 60_000) {
    for (let i = 0; i < n; i++) {
      await play({ score, cleared: true }, { ip: `10.0.${i >> 8}.${i & 255}` });
    }
  }

  it('withholds the average and the histogram below the sample floor', async () => {
    await seed(MIN_SAMPLE - 1);
    const s = await stats('mode=daily&scope=d:2026-09-13');
    expect(s.n).toBe(MIN_SAMPLE - 1);
    expect(s.avg).toBeNull();
    expect(s.buckets).toBeNull();
    // Counts are still reported: "41 playing today" needs no sample floor.
    expect(s.finishes).toBe(MIN_SAMPLE - 1);
  });

  it('publishes them once the floor is met', async () => {
    await seed(MIN_SAMPLE);
    const s = await stats('mode=daily&scope=d:2026-09-13');
    expect(s.avg).toBe(60_000);
    const buckets = s.buckets as { counts: number[]; edges: number[] };
    expect(buckets.counts.reduce((a, b) => a + b, 0)).toBe(MIN_SAMPLE);
    expect(buckets.counts).toHaveLength(buckets.edges.length + 1);
  });

  it('reports the direction so a reader never has to guess', async () => {
    expect((await stats('mode=daily')).direction).toBe('min');
    expect((await stats('mode=timeline')).direction).toBe('max');
  });

  it('is edge-cacheable', async () => {
    const res = await worker.fetch(req('/v1/stats?mode=daily'), env);
    expect(res.headers.get('cache-control')).toContain('s-maxage=300');
  });

  it('rejects a bad mode or scope', async () => {
    expect((await worker.fetch(req('/v1/stats?mode=nope'), env)).status).toBe(400);
    expect((await worker.fetch(req('/v1/stats?mode=daily&scope=x'), env)).status).toBe(400);
  });

  it('gives no visitor estimate for a scoped query, rather than a wrong one', async () => {
    await seed(3);
    // Visitors are per mode per day, not per puzzle; today's count under a
    // puzzle's label would be a plausible-looking lie.
    expect((await stats('mode=daily&scope=d:2026-09-13')).visitors_est).toBeNull();
  });

  it('answers the scopeless form from today only', async () => {
    await seed(3);
    const s = await stats('mode=daily');
    expect(s.scope).toBeNull();
    expect(s.plays).toBe(3);
    expect(s.visitors_est).toBe(3);
  });
});

describe('POST /v1/ops', () => {
  it('counts a missing shard', async () => {
    const res = await worker.fetch(
      req('/v1/ops', { method: 'POST', body: { event: 'shard_missing', scope: 'd:2026-09-14' } }),
      env,
    );
    expect(res.status).toBe(204);
    expect([...db.ops.values()][0]).toBe(1);
  });

  it('refuses an event name it does not know', async () => {
    const res = await worker.fetch(
      req('/v1/ops', { method: 'POST', body: { event: 'anything', scope: 'd:2026-09-14' } }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe('transport', () => {
  it('echoes an allowed origin and never a wildcard', async () => {
    const res = await worker.fetch(req('/v1/stats?mode=daily'), env);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('sends no allow-origin to an unknown origin', async () => {
    const res = await worker.fetch(
      req('/v1/stats?mode=daily', { origin: 'https://evil.example' }),
      env,
    );
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers preflight', async () => {
    const res = await worker.fetch(req('/v1/start', { method: 'OPTIONS' }), env);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('404s an unknown route', async () => {
    expect((await worker.fetch(req('/v1/whatever'), env)).status).toBe(404);
  });

  it('rejects an oversized body', async () => {
    const res = await worker.fetch(
      new Request('https://api.test/v1/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '99999', origin: ORIGIN },
        body: JSON.stringify({ mode: 'daily', scope: 'd:2026-09-13', pad: 'x'.repeat(9000) }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('turns an internal failure into a 500 and nothing else', async () => {
    const broken: Env = {
      ...env,
      DB: {
        prepare() {
          throw new Error('d1 is down');
        },
        async batch() {
          return [];
        },
      },
    };
    const res = await worker.fetch(
      req('/v1/start', { method: 'POST', body: { mode: 'daily', scope: 'd:2026-09-13' } }),
      broken,
    );
    expect(res.status).toBe(500);
    // No internal detail escapes.
    expect(await res.text()).toBe(JSON.stringify({ error: 'server_error' }));
  });
});

describe('scheduled purge', () => {
  it('drops visitor rows past retention and expired nonces', async () => {
    db.visitors.set('2020-01-01|old|daily', { day: '2020-01-01', mode: 'daily', starts: 1, runs: 1 });
    const today = new Date().toISOString().slice(0, 10);
    db.visitors.set(`${today}|new|daily`, { day: today, mode: 'daily', starts: 1, runs: 1 });
    db.tickets.set('expired', Date.now() - 1);
    db.tickets.set('live', Date.now() + 60_000);

    const waits: Promise<unknown>[] = [];
    await worker.scheduled(null, env, { waitUntil: (p) => void waits.push(p) });
    await Promise.all(waits);

    expect(db.visitors.has('2020-01-01|old|daily')).toBe(false);
    expect(db.visitors.has(`${today}|new|daily`)).toBe(true);
    expect(db.tickets.has('expired')).toBe(false);
    expect(db.tickets.has('live')).toBe(true);
  });
});
