/**
 * Minimal hand-written binding types.
 *
 * Deliberately not `@cloudflare/workers-types`: this Worker needs four
 * interfaces, and adding a dependency to the game's package.json so that a
 * sibling deploy target can type-check is a poor trade. Everything else the
 * Worker uses (Request, Response, crypto.subtle, URL) is web-standard and
 * already in the DOM lib.
 *
 * If this grows past a page, take the dependency instead.
 */

export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface Env {
  DB: D1Database;

  /** HMAC key for run tickets. `wrangler secret put TICKET_KEY`. */
  TICKET_KEY: string;

  /**
   * Root key the per-day visitor salt is derived from.
   *
   * Never stored anywhere else, never logged. Rotating it resets cross-day
   * linkability, which is a feature — schedule it quarterly.
   */
  SALT_KEY: string;

  /** Comma-separated exact origins allowed to call this Worker. */
  ALLOWED_ORIGINS: string;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
