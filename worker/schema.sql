-- HitsTime analytics store.
--
-- Aggregates only. There is deliberately no per-run table: a run row would be
-- data that has to be retained, minimised, and justified, and every question
-- asked of it ("how many plays", "what is the average", "where do I rank") is
-- answerable from counters and a histogram instead.
--
-- Apply with:
--   npx wrangler d1 execute hitstime-analytics --remote --file worker/schema.sql

-- One row per (UTC ingestion day, mode, scope).
--
-- NOTE THE ABSENCE OF A BEST-SCORE COLUMN. That is a decision, not an
-- oversight: nothing here verifies a score, so a best would be whatever the
-- most creative player submitted, permanently and unremovably. Averages
-- survive a cheater; an extremum does not. The client renders a percentile off
-- the histogram instead. Adding this column belongs with the verifying
-- endpoints in docs/anti-cheat-architecture.md §2, not before them.
CREATE TABLE IF NOT EXISTS mode_daily (
  day          TEXT    NOT NULL,
  mode         TEXT    NOT NULL,
  scope        TEXT    NOT NULL,
  direction    TEXT    NOT NULL CHECK (direction IN ('min', 'max')),
  starts       INTEGER NOT NULL DEFAULT 0,
  finishes     INTEGER NOT NULL DEFAULT 0,
  cleared      INTEGER NOT NULL DEFAULT 0,
  -- Counted, but excluded from the score aggregates below.
  peeked       INTEGER NOT NULL DEFAULT 0,
  suspect      INTEGER NOT NULL DEFAULT 0,
  -- Clean runs only: no peek, not suspect, within the per-visitor cap.
  score_count  INTEGER NOT NULL DEFAULT 0,
  score_sum    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, mode, scope)
) WITHOUT ROWID;

-- The histogram, one row per bin rather than a JSON array on mode_daily.
--
-- A JSON column would need read-modify-write, and two players finishing at the
-- same moment would lose an increment. An UPSERT on a bin is atomic.
CREATE TABLE IF NOT EXISTS score_bucket (
  day       TEXT    NOT NULL,
  mode      TEXT    NOT NULL,
  scope     TEXT    NOT NULL,
  buckets_v INTEGER NOT NULL,
  bucket    INTEGER NOT NULL,
  n         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, mode, scope, buckets_v, bucket)
) WITHOUT ROWID;

-- Distinct-visitor estimate. `vh` is HMAC(salt-of-the-day, ip + ua), and the
-- salt is derived fresh from a root secret each UTC day, so these rows cannot
-- be linked to a person, to each other across days, or to an address.
--
-- Purged at 30 days by the scheduled handler.
CREATE TABLE IF NOT EXISTS visitor_day (
  day    TEXT    NOT NULL,
  vh     TEXT    NOT NULL,
  mode   TEXT    NOT NULL,
  starts INTEGER NOT NULL DEFAULT 0,
  runs   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, vh, mode)
) WITHOUT ROWID;

-- Spent ticket nonces, so one ticket reports one run.
--
-- In D1 rather than KV on purpose: an INSERT .. ON CONFLICT DO NOTHING is
-- atomic and immediately consistent, where a KV read-then-write would let a
-- fast double-submit through the gap. Purged by the scheduled handler.
CREATE TABLE IF NOT EXISTS used_ticket (
  nonce  TEXT    NOT NULL PRIMARY KEY,
  exp_ms INTEGER NOT NULL
) WITHOUT ROWID;

-- Operational counters, currently just the missing-shard alarm.
--
-- The most valuable table here. The scheduled deploy is what publishes each new
-- daily puzzle, and GitHub disables scheduled workflows on a repo with no
-- commits for 60 days — after which the site keeps working and serves its last
-- built day forever. A spike in shard_missing is the only external signal that
-- this has happened.
CREATE TABLE IF NOT EXISTS ops_daily (
  day   TEXT    NOT NULL,
  event TEXT    NOT NULL,
  scope TEXT    NOT NULL,
  n     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event, scope)
) WITHOUT ROWID;
