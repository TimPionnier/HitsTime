/**
 * HitsTime analytics Worker.
 *
 * Counts plays, distinct visitors, and a score distribution per game mode. It
 * does NOT verify scores, and therefore deliberately publishes no best score —
 * see worker/schema.sql and docs/analytics-architecture.md §1.3. When the
 * verifying endpoints of docs/anti-cheat-architecture.md §2 are built, they
 * belong in THIS Worker, next to these routes, sharing this ticket: the two
 * designs were converging on the same thing.
 *
 * Routes:
 *   POST /v1/start   -> { ticket }   announce a run, take a ticket
 *   POST /v1/finish  -> 204          report a finished run
 *   POST /v1/ops     -> 204          operational counter (missing shard)
 *   GET  /v1/stats   -> aggregates   read path, edge-cached
 */
import type { D1Database, Env, ExecutionContext } from './env';
import { BUCKETS_V, bucketCount, bucketOf, bucketSpecFor } from './buckets';
import { canonicalScope, directionFor, isMode, scoreInRange, type Mode } from './scope';
import { TICKET_TTL_MS, newNonce, signTicket, verifyTicket } from './ticket';
import { utcDay, visitorHash } from './visitor';

/**
 * Below this many clean runs, an average and a percentile are noise dressed as
 * insight — "faster than 83% of players" out of six players says nothing. The
 * gate lives here rather than in the UI so the client cannot be tempted.
 */
const MIN_SAMPLE = 30;

/**
 * Runs per visitor per day that reach the score aggregates.
 *
 * Everything above it still counts as a play. This is what makes the average
 * robust: flooding costs uniques, not the mean.
 */
const SCORED_RUNS_CAP = 5;

/** Starts per visitor per day before the Worker stops issuing tickets. */
const START_CAP = 200;

/** Visitor rows are kept this long, then purged. */
const VISITOR_RETENTION_DAYS = 30;

/** How far out of the calendar a daily scope may sit before it is refused. */
const SCOPE_DATE_SLACK_DAYS = 2;

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  // An exact echo, never "*": a wildcard here would let any page on the web
  // spend this Worker's quota from a real browser.
  const ok = origin !== null && allowed.includes(origin);
  return {
    ...(ok ? { 'access-control-allow-origin': origin } : {}),
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function json(data: unknown, init: ResponseInit = {}, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...extra, ...(init.headers ?? {}) },
  });
}

/**
 * Read a JSON body, or null.
 *
 * Capped: an unbounded body is free CPU and memory for an attacker, and no
 * legitimate payload here is more than a few hundred bytes.
 */
async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > 4_096) return null;
  try {
    const data = (await req.json()) as unknown;
    return data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The caller's address, for hashing only.
 *
 * CF-Connecting-IP is set by the edge and cannot be spoofed by the client;
 * X-Forwarded-For can be, and is deliberately not consulted. The value is used
 * within this request and never stored — see visitor.ts.
 */
function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? 'unknown';
}

function userAgent(req: Request): string {
  return (req.headers.get('user-agent') ?? '').slice(0, 256);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Is a daily scope's date anywhere near the present?
 *
 * The archive is playable back to day 1, so an old date is legitimate — but a
 * date in the far future is not, and each distinct value is its own row. The
 * slack covers the timezone spread: UTC+14 is already on tomorrow while UTC-12
 * is still on yesterday.
 */
function scopeDatePlausible(mode: Mode, scope: string, now: Date): boolean {
  if (mode !== 'daily') return true;
  const date = scope.slice(2);
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  const slack = SCOPE_DATE_SLACK_DAYS * 86_400_000;
  if (t > now.getTime() + slack) return false;
  // Nothing predates the archive's first day by more than a year's grace.
  return t > Date.parse('2020-01-01T00:00:00Z');
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleStart(req: Request, env: Env, now: Date): Promise<Response> {
  const body = await readJson(req);
  if (!body) return json({ error: 'bad_request' }, { status: 400 });

  const mode = body.mode;
  if (!isMode(mode)) return json({ error: 'bad_mode' }, { status: 400 });

  const scope = canonicalScope(mode, body.scope);
  if (scope === null) return json({ error: 'bad_scope' }, { status: 400 });
  if (!scopeDatePlausible(mode, scope, now)) return json({ error: 'bad_scope' }, { status: 400 });

  const day = utcDay(now);
  const vh = await visitorHash(env.SALT_KEY, day, clientIp(req), userAgent(req));

  // One statement does the uniqueness bookkeeping and the per-visitor cap.
  const seen = await env.DB.prepare(
    `INSERT INTO visitor_day (day, vh, mode, starts, runs) VALUES (?, ?, ?, 1, 0)
       ON CONFLICT (day, vh, mode) DO UPDATE SET starts = starts + 1
     RETURNING starts`,
  )
    .bind(day, vh, mode)
    .first<{ starts: number }>();

  if ((seen?.starts ?? 1) > START_CAP) {
    // Not an error the game should ever see; a human cannot start 200 runs a
    // day. Retry-After keeps a well-behaved client from hammering.
    return json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '3600' } });
  }

  await bumpModeDaily(env.DB, day, mode, scope, { starts: 1 });

  const ticket = await signTicket(env.TICKET_KEY, {
    m: mode,
    s: scope,
    iat: now.getTime(),
    n: newNonce(),
    vh,
    d: day,
  });

  return json({ ticket });
}

async function handleFinish(req: Request, env: Env, now: Date): Promise<Response> {
  const body = await readJson(req);
  if (!body) return json({ error: 'bad_request' }, { status: 400 });

  const ticket = await verifyTicket(env.TICKET_KEY, body.ticket, now.getTime());
  // A missing, forged or expired ticket is not an error worth distinguishing:
  // the client cannot act on the difference and an attacker should not learn it.
  if (!ticket) return json({ error: 'bad_ticket' }, { status: 400 });

  const mode = ticket.m;
  if (!isMode(mode)) return json({ error: 'bad_ticket' }, { status: 400 });

  // Single-use. DO NOTHING on conflict plus RETURNING gives "did I win the
  // insert" atomically, which a read-then-write could not.
  const claimed = await env.DB.prepare(
    `INSERT INTO used_ticket (nonce, exp_ms) VALUES (?, ?)
       ON CONFLICT (nonce) DO NOTHING
     RETURNING nonce`,
  )
    .bind(ticket.n, ticket.iat + TICKET_TTL_MS)
    .first<{ nonce: string }>();
  if (!claimed) return json({ error: 'replay' }, { status: 409 });

  // Validated AFTER the nonce is burned, on purpose: otherwise one ticket could
  // be used to probe what the server accepts, a rejected attempt at a time.
  const score = body.score;
  if (!scoreInRange(mode, score)) return json({ error: 'bad_score' }, { status: 400 });

  const peeks = typeof body.peeks === 'number' && body.peeks > 0;
  const suspect = body.suspect === true;
  const cleared = body.cleared === true;

  // The one-sided clamp. A run cannot have taken longer than the ticket has
  // existed. Note what is NOT done: a fast run is never rejected — a genuinely
  // quick player is indistinguishable from a lucky one, and refusing them would
  // be a worse bug than counting a cheat.
  const overrun = mode === 'daily' && (score as number) > now.getTime() - ticket.iat + 5_000;

  // The day the ticket was ISSUED, so a run spanning midnight lands in one row
  // rather than splitting its start and finish across two.
  const day = ticket.d;

  const clean = !peeks && !suspect && !overrun;

  const bump = await env.DB.prepare(
    `INSERT INTO visitor_day (day, vh, mode, starts, runs) VALUES (?, ?, ?, 0, 1)
       ON CONFLICT (day, vh, mode) DO UPDATE SET runs = runs + 1
     RETURNING runs`,
  )
    .bind(day, ticket.vh, mode)
    .first<{ runs: number }>();

  const withinCap = (bump?.runs ?? 1) <= SCORED_RUNS_CAP;
  const scored = clean && withinCap;

  await bumpModeDaily(env.DB, day, mode, ticket.s, {
    finishes: 1,
    cleared: cleared ? 1 : 0,
    peeked: peeks ? 1 : 0,
    suspect: suspect ? 1 : 0,
    score_count: scored ? 1 : 0,
    score_sum: scored ? (score as number) : 0,
  });

  if (scored) {
    const spec = bucketSpecFor(mode);
    await env.DB.prepare(
      `INSERT INTO score_bucket (day, mode, scope, buckets_v, bucket, n) VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT (day, mode, scope, buckets_v, bucket) DO UPDATE SET n = n + 1`,
    )
      .bind(day, mode, ticket.s, spec.v, bucketOf(spec, score as number))
      .run();
  }

  return new Response(null, { status: 204 });
}

/** Operational counters. No ticket: a missing shard happens before any run. */
async function handleOps(req: Request, env: Env, now: Date): Promise<Response> {
  const body = await readJson(req);
  if (!body) return json({ error: 'bad_request' }, { status: 400 });

  // An allowlist, not free text: this is a primary key.
  if (body.event !== 'shard_missing') return json({ error: 'bad_event' }, { status: 400 });

  const scope = canonicalScope('daily', body.scope);
  if (scope === null) return json({ error: 'bad_scope' }, { status: 400 });

  await env.DB.prepare(
    `INSERT INTO ops_daily (day, event, scope, n) VALUES (?, ?, ?, 1)
       ON CONFLICT (day, event, scope) DO UPDATE SET n = n + 1`,
  )
    .bind(utcDay(now), 'shard_missing', scope)
    .run();

  return new Response(null, { status: 204 });
}

interface StatsResponse {
  mode: Mode;
  scope: string | null;
  direction: 'min' | 'max';
  plays: number;
  finishes: number;
  cleared: number;
  /**
   * Distinct-visitor ESTIMATE for today, or null.
   *
   * Null for a scope-qualified query, deliberately: visitors are counted per
   * mode per day and NOT per scope (the same person playing two puzzles is one
   * visitor), so there is no honest per-puzzle number to give. Returning
   * today's count under a puzzle's label would be a lie with a plausible shape.
   */
  visitors_est: number | null;
  /** Null until MIN_SAMPLE clean runs exist. */
  avg: number | null;
  /** Clean runs behind `avg` and `buckets`. */
  n: number;
  min_sample: number;
  peeked: number;
  buckets: { v: number; edges: number[]; counts: number[] } | null;
}

/**
 * Read path.
 *
 * Two shapes, and the difference matters:
 *   ?mode=daily&scope=d:2026-09-13  -> that puzzle, across every ingestion day
 *   ?mode=daily                     -> today (UTC), across every scope
 *
 * The first is "how did I do against everyone who played this puzzle"; the
 * second is "is anyone here right now". Conflating them would double-count
 * around midnight, since the ingestion day and the puzzle date are different
 * calendars — the same trap as the local-vs-UTC bug in dateForDayIndex.
 */
async function handleStats(url: URL, env: Env, now: Date): Promise<Response> {
  const mode = url.searchParams.get('mode');
  if (!isMode(mode)) return json({ error: 'bad_mode' }, { status: 400 });

  const rawScope = url.searchParams.get('scope');
  const scope = rawScope === null ? null : canonicalScope(mode, rawScope);
  if (rawScope !== null && scope === null) return json({ error: 'bad_scope' }, { status: 400 });

  const where = scope === null ? 'mode = ? AND day = ?' : 'mode = ? AND scope = ?';
  const arg = scope === null ? utcDay(now) : scope;

  const totals = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(starts), 0)      AS starts,
       COALESCE(SUM(finishes), 0)    AS finishes,
       COALESCE(SUM(cleared), 0)     AS cleared,
       COALESCE(SUM(peeked), 0)      AS peeked,
       COALESCE(SUM(score_count), 0) AS score_count,
       COALESCE(SUM(score_sum), 0)   AS score_sum
     FROM mode_daily WHERE ${where}`,
  )
    .bind(mode, arg)
    .first<{
      starts: number;
      finishes: number;
      cleared: number;
      peeked: number;
      score_count: number;
      score_sum: number;
    }>();

  // Only asked for the scopeless ("is anyone here today") form — see the field
  // comment above. One fewer query for the end-screen path, too.
  const visitors =
    scope === null
      ? await env.DB.prepare(`SELECT COUNT(*) AS n FROM visitor_day WHERE mode = ? AND day = ?`)
          .bind(mode, utcDay(now))
          .first<{ n: number }>()
      : null;

  const n = totals?.score_count ?? 0;
  const spec = bucketSpecFor(mode);

  let buckets: StatsResponse['buckets'] = null;
  if (n >= MIN_SAMPLE) {
    const rows = await env.DB.prepare(
      `SELECT bucket, COALESCE(SUM(n), 0) AS n FROM score_bucket
        WHERE ${where} AND buckets_v = ? GROUP BY bucket`,
    )
      .bind(mode, arg, spec.v)
      .all<{ bucket: number; n: number }>();

    const counts = new Array<number>(bucketCount(spec)).fill(0);
    for (const row of rows.results ?? []) {
      if (row.bucket >= 0 && row.bucket < counts.length) counts[row.bucket] = row.n;
    }
    buckets = { v: spec.v, edges: spec.edges, counts };
  }

  const payload: StatsResponse = {
    mode,
    scope,
    direction: directionFor(mode),
    plays: totals?.starts ?? 0,
    finishes: totals?.finishes ?? 0,
    cleared: totals?.cleared ?? 0,
    visitors_est: scope === null ? (visitors?.n ?? 0) : null,
    avg: n >= MIN_SAMPLE ? Math.round((totals?.score_sum ?? 0) / n) : null,
    n,
    min_sample: MIN_SAMPLE,
    peeked: totals?.peeked ?? 0,
    buckets,
  };

  // Cached at the edge: the read path is the only one players hit repeatedly,
  // and 5 minutes of staleness on a play counter is invisible.
  return json(payload, {}, { 'cache-control': 'public, max-age=60, s-maxage=300' });
}

// ---------------------------------------------------------------------------
// Shared writes
// ---------------------------------------------------------------------------

type Bump = Partial<
  Record<'starts' | 'finishes' | 'cleared' | 'peeked' | 'suspect' | 'score_count' | 'score_sum', number>
>;

/**
 * Add to one aggregate row, creating it if needed.
 *
 * `direction` is written from the mode, never from the request. A row whose
 * direction disagreed with its mode would make a future "best" mean its
 * opposite, and nothing on a dashboard would look wrong.
 */
async function bumpModeDaily(
  db: D1Database,
  day: string,
  mode: Mode,
  scope: string,
  bump: Bump,
): Promise<void> {
  const cols = ['starts', 'finishes', 'cleared', 'peeked', 'suspect', 'score_count', 'score_sum'] as const;
  const values = cols.map((c) => bump[c] ?? 0);
  const sets = cols.map((c) => `${c} = ${c} + ?`).join(', ');

  await db
    .prepare(
      `INSERT INTO mode_daily (day, mode, scope, direction, ${cols.join(', ')})
         VALUES (?, ?, ?, ?, ${cols.map(() => '?').join(', ')})
         ON CONFLICT (day, mode, scope) DO UPDATE SET ${sets}`,
    )
    .bind(day, mode, scope, directionFor(mode), ...values, ...values)
    .run();
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get('origin');
    const cors = corsHeaders(env, origin);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const now = new Date();

    let res: Response;
    try {
      if (req.method === 'POST' && url.pathname === '/v1/start') {
        res = await handleStart(req, env, now);
      } else if (req.method === 'POST' && url.pathname === '/v1/finish') {
        res = await handleFinish(req, env, now);
      } else if (req.method === 'POST' && url.pathname === '/v1/ops') {
        res = await handleOps(req, env, now);
      } else if (req.method === 'GET' && url.pathname === '/v1/stats') {
        res = await handleStats(url, env, now);
      } else {
        res = json({ error: 'not_found' }, { status: 404 });
      }
    } catch {
      // A failure here must look like a failure to the game, which ignores it.
      // Never echo an internal error: the client has no use for it.
      res = json({ error: 'server_error' }, { status: 500 });
    }

    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  },

  /** Nightly purge. Retention is a privacy commitment, not housekeeping. */
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    const cutoff = new Date(Date.now() - VISITOR_RETENTION_DAYS * 86_400_000);
    ctx.waitUntil(
      (async () => {
        await env.DB.prepare(`DELETE FROM visitor_day WHERE day < ?`).bind(utcDay(cutoff)).run();
        await env.DB.prepare(`DELETE FROM used_ticket WHERE exp_ms < ?`).bind(Date.now()).run();
      })(),
    );
  },
};

export { BUCKETS_V, MIN_SAMPLE, SCORED_RUNS_CAP };
