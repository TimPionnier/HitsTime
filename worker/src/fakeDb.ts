/**
 * An in-memory stand-in for the D1 binding, for tests only.
 *
 * NOT a SQL engine. It recognises the handful of statements index.ts actually
 * issues, by table name and shape, and applies them to plain Maps. That is a
 * real limitation: a rewritten query that this file does not recognise will
 * throw here rather than silently pass, which is the failure mode to prefer.
 *
 * The alternative was miniflare plus a local D1, which brings a dependency and
 * a container to a repo whose whole test suite currently runs in 1.5 s.
 */
import type { D1Database, D1PreparedStatement, D1Result } from './env';

interface AggRow {
  day: string;
  mode: string;
  scope: string;
  direction: string;
  starts: number;
  finishes: number;
  cleared: number;
  peeked: number;
  suspect: number;
  score_count: number;
  score_sum: number;
}

const AGG_COLS = [
  'starts',
  'finishes',
  'cleared',
  'peeked',
  'suspect',
  'score_count',
  'score_sum',
] as const;

export class FakeDb implements D1Database {
  visitors = new Map<string, { day: string; mode: string; starts: number; runs: number }>();
  tickets = new Map<string, number>();
  agg = new Map<string, AggRow>();
  buckets = new Map<string, { day: string; mode: string; scope: string; v: number; bucket: number; n: number }>();
  ops = new Map<string, number>();

  prepare(query: string): D1PreparedStatement {
    return new FakeStatement(this, query);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const out: D1Result[] = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }
}

class FakeStatement implements D1PreparedStatement {
  private args: unknown[] = [];

  constructor(
    private db: FakeDb,
    private sql: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.args = values;
    return this;
  }

  async run(): Promise<D1Result> {
    await this.exec();
    return { success: true };
  }

  async first<T = unknown>(): Promise<T | null> {
    return (await this.exec()) as T | null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const rows = (await this.exec()) as unknown;
    return { success: true, results: (Array.isArray(rows) ? rows : []) as T[] };
  }

  private async exec(): Promise<unknown> {
    const sql = this.sql.replace(/\s+/g, ' ').trim();
    const a = this.args;

    if (sql.startsWith('INSERT INTO visitor_day')) {
      const [day, vh, mode] = a as [string, string, string];
      const key = `${day}|${vh}|${mode}`;
      const row = this.db.visitors.get(key) ?? { day, mode, starts: 0, runs: 0 };
      // The two call sites differ only in which counter they seed.
      if (sql.includes('starts = starts + 1')) row.starts += 1;
      else row.runs += 1;
      this.db.visitors.set(key, row);
      return { starts: row.starts, runs: row.runs };
    }

    if (sql.startsWith('INSERT INTO used_ticket')) {
      const [nonce, exp] = a as [string, number];
      if (this.db.tickets.has(nonce)) return null; // ON CONFLICT DO NOTHING
      this.db.tickets.set(nonce, exp);
      return { nonce };
    }

    if (sql.startsWith('INSERT INTO mode_daily')) {
      const [day, mode, scope, direction] = a as [string, string, string, string];
      const deltas = a.slice(4, 4 + AGG_COLS.length) as number[];
      const key = `${day}|${mode}|${scope}`;
      const row: AggRow =
        this.db.agg.get(key) ??
        ({
          day,
          mode,
          scope,
          direction,
          starts: 0,
          finishes: 0,
          cleared: 0,
          peeked: 0,
          suspect: 0,
          score_count: 0,
          score_sum: 0,
        } as AggRow);
      AGG_COLS.forEach((c, i) => {
        row[c] = row[c] + (deltas[i] ?? 0);
      });
      this.db.agg.set(key, row);
      return null;
    }

    if (sql.startsWith('INSERT INTO score_bucket')) {
      const [day, mode, scope, v, bucket] = a as [string, string, string, number, number];
      const key = `${day}|${mode}|${scope}|${v}|${bucket}`;
      const row = this.db.buckets.get(key) ?? { day, mode, scope, v, bucket, n: 0 };
      row.n += 1;
      this.db.buckets.set(key, row);
      return null;
    }

    if (sql.startsWith('INSERT INTO ops_daily')) {
      const [day, event, scope] = a as [string, string, string];
      const key = `${day}|${event}|${scope}`;
      this.db.ops.set(key, (this.db.ops.get(key) ?? 0) + 1);
      return null;
    }

    if (sql.startsWith('DELETE FROM visitor_day')) {
      const [cutoff] = a as [string];
      for (const [key, row] of this.db.visitors) if (row.day < cutoff) this.db.visitors.delete(key);
      return null;
    }

    if (sql.startsWith('DELETE FROM used_ticket')) {
      const [nowMs] = a as [number];
      for (const [nonce, exp] of this.db.tickets) if (exp < nowMs) this.db.tickets.delete(nonce);
      return null;
    }

    if (sql.includes('FROM mode_daily')) {
      const byDay = sql.includes('AND day = ?');
      const [mode, arg] = a as [string, string];
      const rows = [...this.db.agg.values()].filter(
        (r) => r.mode === mode && (byDay ? r.day === arg : r.scope === arg),
      );
      const sum = (c: (typeof AGG_COLS)[number]) => rows.reduce((n, r) => n + r[c], 0);
      return {
        starts: sum('starts'),
        finishes: sum('finishes'),
        cleared: sum('cleared'),
        peeked: sum('peeked'),
        score_count: sum('score_count'),
        score_sum: sum('score_sum'),
      };
    }

    if (sql.includes('FROM visitor_day')) {
      const [mode, day] = a as [string, string];
      return {
        n: [...this.db.visitors.values()].filter((v) => v.mode === mode && v.day === day).length,
      };
    }

    if (sql.includes('FROM score_bucket')) {
      const byDay = sql.includes('AND day = ?');
      const [mode, arg, v] = a as [string, string, number];
      const grouped = new Map<number, number>();
      for (const row of this.db.buckets.values()) {
        if (row.mode !== mode || row.v !== v) continue;
        if (byDay ? row.day !== arg : row.scope !== arg) continue;
        grouped.set(row.bucket, (grouped.get(row.bucket) ?? 0) + row.n);
      }
      return [...grouped.entries()].map(([bucket, n]) => ({ bucket, n }));
    }

    throw new Error(`FakeDb does not know this statement: ${sql}`);
  }
}
