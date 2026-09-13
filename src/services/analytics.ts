/**
 * Anonymous engagement and score telemetry.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * Three properties hold this file together, and each one is load-bearing:
 *
 *  1. **It cannot affect the game.** Every call is fire-and-forget, wrapped, and
 *     time-limited. A dead endpoint, a 500, a hung connection and a blocked
 *     request must all look identical to the player: nothing happened.
 *
 *  2. **It touches no storage API.** No cookie, no localStorage, no
 *     sessionStorage, no IndexedDB, no persistent id of any kind. Nothing is
 *     written to the player's device, which is precisely why the app needs no
 *     consent banner. A retry queue would be the obvious "improvement" and
 *     would cost exactly that property — see docs/analytics-architecture.md
 *     §1.2. A dropped run is an acceptable loss; a cookie banner is not.
 *
 *  3. **It sends no identifier and no free text.** Mode, a scope key, a score,
 *     and a few flags. Distinct-player counting happens server-side from a
 *     rotating salted hash the client never sees.
 *
 * Unconfigured (no VITE_ANALYTICS_URL) every function is a no-op, which is the
 * state of the repo as shipped: the endpoint is opt-in at build time.
 */

/** Trailing slash stripped so `${API}/v1/...` cannot become a double slash. */
const API = String(import.meta.env.VITE_ANALYTICS_URL ?? '').replace(/\/+$/, '');

const START_TIMEOUT_MS = 3_000;

/**
 * Honour Do Not Track and Global Privacy Control.
 *
 * Read once at module load: both are user-agent settings, not something that
 * changes mid-session, and re-reading per call would only invite a
 * `navigator`-undefined crash in a non-browser test run.
 */
const optedOut = (() => {
  if (typeof navigator === 'undefined') return true;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.doNotTrack === '1' || nav.globalPrivacyControl === true;
})();

export function analyticsEnabled(): boolean {
  return API !== '' && !optedOut;
}

/** Scope key for a daily run: the puzzle's date, which is the same for everyone. */
export function dailyScope(dateISO: string): string {
  return `d:${dateISO}`;
}

/**
 * Scope key for a free-play run.
 *
 * The playlist ID only — never `playlist.name`, which is text written by
 * whoever owns the playlist and has no business leaving the browser.
 */
export function playlistScope(providerId: string, playlistId: string): string {
  return `${providerId}:${playlistId}`;
}

export interface RunVersions {
  algoVersion?: number;
  poolVersion?: number;
}

/**
 * What a finished run reports.
 *
 * Deliberately minimal: the per-round log is NOT sent. Nothing on the server
 * replays a run yet, so a round log would be data collected for no live purpose
 * — and the day a verifying endpoint exists (Option B in
 * docs/anti-cheat-architecture.md §2) is the day to add it, deliberately.
 */
export interface RunResult {
  /** Points for the free-play modes, adjustedMs for daily. */
  score: number;
  cleared: boolean;
  errors?: number;
  /** Peeked runs are counted but excluded from averages — a 5-minute penalty
   *  from a heuristic would otherwise dominate a distribution measured in
   *  seconds. See docs/analytics-architecture.md §1.6. */
  peeks?: number;
  suspect?: boolean;
}

/**
 * The current run's ticket, or null.
 *
 * Module-level rather than in the store: it is not UI state, nothing renders
 * from it, and a null ticket must stay invisible to every screen.
 */
let ticket: string | null = null;

function withTimeout(input: string, init: RequestInit, ms: number): Promise<Response> {
  // AbortController rather than Promise.race: race leaves the request running,
  // and a hung connection would hold a socket for the rest of the session.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    // keepalive so a submit survives the player closing the tab on the end
    // screen. sendBeacon cannot set a content-type; keepalive can.
    keepalive: true,
  });
}

/**
 * Announce a run start and pick up a ticket.
 *
 * Awaitable, but callers must NOT block the game on it — see the call sites in
 * store/index.ts, which fire it alongside the deal rather than before it. A
 * failure leaves `ticket` null and the run simply goes uncounted.
 */
export async function beginRun(
  mode: string,
  scope: string,
  versions: RunVersions = {},
): Promise<void> {
  ticket = null;
  if (!analyticsEnabled()) return;

  try {
    const res = await withTimeout(
      `${API}/v1/start`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, scope, ...versions }),
      },
      START_TIMEOUT_MS,
    );
    if (!res.ok) return;
    const data = (await res.json()) as { ticket?: unknown };
    if (typeof data.ticket === 'string') ticket = data.ticket;
  } catch {
    /* Analytics must never surface an error into the game. */
  }
}

/**
 * Report a finished run.
 *
 * No ticket means no report: an unstarted run cannot be finished, and that rule
 * is what stops a submission flood from costing an attacker nothing — the
 * ticket carries a server-issued timestamp, so a fake run has to wait out real
 * wall-clock time.
 */
export function reportRun(result: RunResult): void {
  if (!analyticsEnabled() || !ticket) return;
  const body = { ticket, ...result };
  // Cleared before the request, not after: a ticket is single-use server-side
  // too, and re-sending it would only burn the nonce twice.
  ticket = null;
  try {
    void post('/v1/finish', body).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

/** Drop the current ticket without reporting — an abandoned run. */
export function abandonRun(): void {
  ticket = null;
}

/**
 * A day's shard was missing.
 *
 * The most valuable counter in the file, and the one nobody would think to ask
 * for. The scheduled deploy is what publishes each new day, and GitHub disables
 * scheduled workflows on a repo with no commits for 60 days — at which point
 * the site keeps working and serves the last built day forever. A silent
 * freeze. This is the smoke alarm for it.
 *
 * Fires with no ticket: it is not a run, and a 404 happens before any run
 * exists.
 */
export function reportShardMissing(dateISO: string): void {
  if (!analyticsEnabled()) return;
  try {
    void post('/v1/ops', { event: 'shard_missing', scope: dailyScope(dateISO) }).catch(
      () => undefined,
    );
  } catch {
    /* ignore */
  }
}

/** Test seam: the ticket is module state, and a test must be able to clear it. */
export function __resetForTests(): void {
  ticket = null;
}
