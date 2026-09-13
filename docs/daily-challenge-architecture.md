# Daily Challenge — Technical Architecture

Status: design proposal. Target: HitsTime (React 18 + Vite, **fully static**, GitHub Pages,
Deezer public API via JSONP, no backend, no accounts).

**Format:** the existing *frise chronologique* mode, fixed at 10 scored placements, played
incrementally — one card at a time. A wrong placement does **not** end the run: the card is
inserted at its correct position, shown in red, and costs +30 s. The run always reaches round
10, so every player's result is comparable. Score = total thinking time + 30 s per error.

The governing constraint: **there is no server**. Every design choice below either lives inside
that constraint or is explicitly marked as the upgrade path for when a server appears.

---

## Phase 1 — Architectural Plan

### 1. Core idea

A daily challenge is a **pure function of a date**, not a database row:

```
challengeFor(dateISO) -> { dayIndex, poolVersion, algoVersion, anchor, draw[10] }
```

Nothing is pre-generated and nothing is stored. Day 1 and day 4000 are produced by the same
call. The archive is therefore *virtual*: the list of playable dates is simply
`[EPOCH .. localToday]`.

This only works if the function is **stable forever**. Everything in §2–§4 exists to protect
that stability.

### 2. Data model

#### 2.1 Frozen pool snapshots (build-time artifacts)

`date-overrides.json` is rewritten weekly by a GitHub Action, and the Deezer playlist can be
edited by its owner at any time. Neither may feed challenge generation directly. Instead a
build step emits an **immutable, content-addressed snapshot**:

```
src/daily/pools/pool-v1.json     // immutable once shipped — never edited, only superseded
src/daily/pools/registry.ts
```

```ts
/** One immutable snapshot of the playable track universe. */
export interface DailyPool {
  version: number;                  // 1, 2, 3…
  /** sha256 of the canonical serialization of `tracks` — asserted by a unit test. */
  contentHash: string;
  /** Sorted by id ascending. Order is part of the contract. */
  tracks: DailyPoolTrack[];
}

export interface DailyPoolTrack {
  id: string;        // Deezer track id — the stable key
  title: string;     // already run through cleanTitle()
  artist: string;
  year: number;      // resolved at snapshot time, frozen
  cover?: string;
  decade: number;    // derived, denormalized for constraint checks
}

/** Which pool governs which date range. Append-only. */
export interface PoolEpoch {
  version: number;
  activeFrom: string;  // 'YYYY-MM-DD', inclusive
}

export const POOL_REGISTRY: PoolEpoch[] = [
  { version: 1, activeFrom: '2026-10-01' },
];
```

Selection for date `D` uses the pool whose `activeFrom` is the latest `<= D`. Adding tracks
later means shipping `pool-v2.json` with `activeFrom` set to a **future** date — every past
challenge keeps regenerating identically because it keeps using v1.

Pool files are loaded with a dynamic `import()` keyed by version, so a decade of snapshots
doesn't bloat the main bundle (a 320-track pool is ~50 KB).

#### 2.2 The challenge (derived, never stored)

```ts
export interface DailyChallenge {
  date: string;          // 'YYYY-MM-DD' local calendar date
  dayIndex: number;      // 1-based, days since EPOCH
  poolVersion: number;
  algoVersion: number;
  seedHex: string;       // first 32 hex chars of the digest — cheap integrity tag
  /** Dealt face-up at the start. Scores nothing — it only anchors the timeline. */
  anchor: DailyPoolTrack;
  /** The 10 scored rounds, in deterministic draw order. Years are all distinct. */
  draw: DailyPoolTrack[];
}
```

11 tracks are drawn: 1 anchor + 10 scored placements. Drawing only 10 would leave 9 scored
rounds, and "7/10" reads better than "7/9" on a share card for the sake of one constant.

#### 2.3 Play rules

- Cards are drawn one at a time, exactly like today's timeline mode: listen, pick a gap,
  validate, reveal.
- **A wrong placement does not end the run.** The card is inserted at its *correct* index and
  stays on the timeline marked red for the rest of the game; `errors` increments and the timer
  takes **+30 s**.
- The run always reaches round 10. Every player therefore produces a comparable result.

Two properties fall out of "insert at the correct index", and both matter:

1. **The timeline is always genuinely sorted.** Later rounds are never played against a
   corrupted board, so one mistake cannot cascade into several. You are punished once.
2. **The board grows to 11 cards for everyone**, so the difficulty curve is identical for all
   players — a precondition for ranking them against each other.

#### 2.4 Player state (localStorage)

Kept in its own key, **not** in the existing `hitstime.leaderboard.v1` array — that one is
capped at 200 entries and daily play would evict the player's game history.

```ts
const KEY = 'hitstime.daily.v1';
const ERROR_PENALTY_MS = 30_000;

/** One round of the run — a full replay log, not just a final answer. */
export interface DailyRound {
  trackId: string;
  chosenIndex: number;
  correctIndex: number;
  correct: boolean;
  thinkMs: number;      // time from clip-ready to validate, excluding the reveal animation
}

export interface DailyAttempt {
  date: string;
  poolVersion: number;
  algoVersion: number;
  seedHex: string;              // guards against replaying a stale attempt against a new pool
  status: 'in_progress' | 'finished';
  rounds: DailyRound[];         // up to 10
  errors: number;               // 0..10
  /** Correct placements before the first error — the spec'd streak. Freezes, never resets. */
  streak: number;
  rawActiveMs: number;          // monotonic thinking time, reveal animations excluded
  adjustedMs: number;           // rawActiveMs + errors * ERROR_PENALTY_MS  ← the score
  startedAtEpochMs: number;     // wall clock, for display only
  finishedAtEpochMs?: number;
  suspect?: boolean;            // failed a plausibility check — excluded from any shared board
}

export interface DailyStore {
  attempts: Record<string, DailyAttempt>;   // keyed by date — a map, not an array
  currentStreak: number;                    // consecutive days played
  maxStreak: number;
  lastPlayedDate: string | null;
  /** Histogram of `errors` 0..10, for the stats panel. */
  distribution: number[];
}
```

Storing the full `rounds` log rather than a final ordering costs ~60 B extra per attempt and
buys three things: a real end-screen review, per-round plausibility checks, and trivial
server-side validation later (replay the log against the canonical solution).

Budget: ~350 B/attempt → 365 days ≈ 128 KB, inside the 5 MB quota. The existing
try/catch-on-write pattern from `services/leaderboard.ts` carries over.

#### 2.5 Server schema (upgrade path, not needed at launch)

```sql
CREATE TABLE daily_attempt (
  user_id      uuid        NOT NULL,
  day_index    integer     NOT NULL,
  errors       smallint    NOT NULL,   -- recomputed server-side, never trusted from client
  adjusted_ms  integer     NOT NULL,   -- raw time from the server's own token, + penalties
  rounds       jsonb       NOT NULL,   -- the replay log
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day_index)     -- enforces one attempt per day
);
CREATE INDEX daily_attempt_board ON daily_attempt (day_index, adjusted_ms ASC);
```

The `PRIMARY KEY` is the one-attempt-per-day rule; the index is the leaderboard query. The
generation and grading modules stay isomorphic TS so the server runs the *exact same* code.

### 3. Seed generation

```ts
const EPOCH = '2026-10-01';
const ALGO_VERSION = 1;

/** Local calendar date — NEVER toISOString(), which silently shifts for UTC-negative zones. */
export function localDateISO(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** DST-safe: anchor both ends at UTC midnight, so no day is 23 or 25 hours long. */
export function dayIndexFor(dateISO: string): number {
  const at = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(dateISO) - at(EPOCH)) / 86_400_000) + 1;
}

export async function seedFor(dateISO: string, poolVersion: number): Promise<Uint32Array> {
  const msg = `hitstime/daily|algo:${ALGO_VERSION}|pool:${poolVersion}|date:${dateISO}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
  return new Uint32Array(digest.slice(0, 16));   // 4 × 32-bit words
}
```

Why SHA-256 rather than a hand-rolled string hash: consecutive dates differ by one character,
and a weak hash leaves that correlation in the low bits — consecutive puzzles then look
suspiciously alike. SHA-256 decorrelates completely and is specified identically in every
runtime (browser, Node verification script, future server). `crypto.subtle` is async, which is
free here since the daily screen loads asynchronously anyway.

The digest words seed **sfc32**, warmed 12 iterations, giving a synchronous
`rng: () => number` — the exact signature the existing `shuffle(arr, rng)` already accepts.

### 4. Selection algorithm

Not "shuffle and take 11". A good puzzle needs constraints, and one of them is load-bearing:

**Distinct years are mandatory.** `isCorrectPlacement()` deliberately treats equal years as
correct on either side. With ties, a card has two valid slots, so "insert the red card at *the*
correct index" has no single answer and the grading of every later round shifts depending on
which side you chose. Forcing distinct years makes every round's correct index unique.

Days are not generated one at a time. A whole **14-day cycle** is drawn from a single seed,
each day taking from what the earlier days left behind:

```
selectCycle(pool, cycleSeed):
  consumed = {}
  for slot in 0..13:
    for nonce in 0..63:                       # re-roll until the day is hard enough
      order = seeded Fisher-Yates over pool indices
      for rung in 0..3:                       # relax only if the walk comes up short
        picks = walk(order, excluding `consumed`, rung)
        if picks and interiorPlacements(picks) >= 4: accept
    consumed += picks

walk accepts a track iff:
  rung < 3 : not already consumed in this cycle
  always   : its year is not already taken       <- never relaxed
  rung < 2 : its artist is not already taken
  rung < 1 : its decade has < 4 picks
```

`challengeFor(date)` then takes `cycle = floor((dayIndex-1)/14)` and `slot = (dayIndex-1)%14`.

**Why a cycle rather than "exclude the last 7 days".** That rule is recursive with no base
case: day D's exclusions are the actual draws of D-1..D-7, each of which needs *its* previous
seven, and so on back to day 1. Either you recurse unboundedly or you compute the exclusion
against a draw that isn't the one people actually played, which guarantees nothing. Drawing a
cycle together is O(14) and guarantees the real thing.

**Step 7 — the difficulty guard.** In incremental play the *draw order* is the difficulty. If
the 10 cards happen to arrive in ascending year order, every placement goes at the far right
end of the timeline and the puzzle is free. Same if the anchor is an outlier and every other
card lands on one side of it. So: simulate a perfect run, count the rounds whose correct index
is strictly *interior* (neither 0 nor `timeline.length`), and require **>= 4**. Re-roll with an
incrementing nonce otherwise. Deterministic, and it puts a floor under how easy a day can be.

Cost per challenge: one SHA-256 plus at most 14 constrained walks over a ~300-track pool —
microseconds, and only when a date is actually opened.

### 5. Uniqueness

Two distinct claims, stated honestly:

- **Guaranteed, inside a cycle:** days in the same 14-day cycle draw from disjoint remainders
  of the pool, so **no track can appear twice in any cycle** — repetition is impossible, not
  merely unlikely.
- **Across a cycle boundary:** the two cycles have independent seeds and *can* share a track.
  With ~300 tracks and 11 per day the expected overlap is 11x11/300 ~ 0.4 tracks, so roughly
  one boundary in three shares a single song — about 2.7% of all consecutive-day pairs. This is
  the honest limit of the design; closing it would reintroduce the recursion.
- **Probabilistic, globally:** `C(298,11) ~ 1.6e18` possible sets, so over 10 000 days the
  birthday probability of a repeated *set* is ~3e-11.

The last claim is a checked property rather than a hope: a CI test replays 1095 days, hashes
each sorted id-tuple, and asserts no duplicates. It also asserts that every track in the pool
gets drawn and that no track is drawn more than 1.6x the mean — a starved track would mean the
walk is biased by pool order rather than by the seed.

### 6. Round validation

No new grading logic is needed — `src/engine/game.ts` already has both pure helpers:

```ts
const correct = isCorrectPlacement(timeline, track.year, chosenIndex);
const correctIndex = correctIndexFor(timeline, track.year);   // where the red card goes
```

What changes is what happens on a miss. The existing `validate()` returns `gameOver`; daily
needs "insert anyway, in red". Rather than branch inside the tested sudden-death path, add an
explicit option so every current test stays green by default:

```ts
export type OnError = 'end' | 'continue';

validate(state, onError: OnError = 'end')
// onError: 'continue'  →  splice the card in at `correctIndex`,
//                          push its id into `wrongIds`, increment `errors`,
//                          phase stays 'revealing' → next round as usual
```

`GameState` gains two fields, both ignored by the existing modes:

```ts
errors: number;
wrongIds: string[];   // rendered red, and reused for the end-screen review
```

**Metrics produced:**

| Metric | Definition | Role |
|---|---|---|
| `errors` | misplacements, 0–10 | the thing the player feels |
| `streak` | correct rounds before the first error — **freezes**, never resets | the spec'd metric, good for flavour |
| `rawActiveMs` | monotonic thinking time | input to the score |
| `adjustedMs` | `rawActiveMs + errors × 30 000` | **the score** |

### 7. Scoring — one number, not two

Ranking is `adjustedMs ASC`. Nothing else.

This is the direct consequence of the +30 s penalty, and it is worth being explicit about:
**if you rank by `errors` first and use time only as a tiebreak, the +30 s does nothing** — it
would only ever reorder players who already have the same error count, and the ranking would be
identical without it. The penalty is only meaningful if error cost and time cost live on the
same axis. They then trade off against each other, which is the interesting decision:

> 0 errors in 200 s (= 200) beats 2 errors in 150 s (= 150 + 60 = 210).

30 s is roughly one careful placement, so one mistake costs about one round's worth of
thinking. It is a single tunable constant; if the daily plays too punishing, lower it — but
change it only from a future `algoVersion` date, never retroactively, or every archived
result silently re-ranks.

Show the penalty **live**: the timer jumps +30 with a red flash on a miss. It makes the stakes
legible and removes any end-screen surprise.

### 8. Time tracking

```ts
// Monotonic — immune to the player changing their system clock or a DST jump.
const t = performance.now();
```

The timer accumulates **only during `listening` and `pendingValidation`** — the phases where
the player is actually deciding. It is paused during:

- `revealing` (the 1600 ms `REVEAL_MS` animation) — the player cannot influence it, and
  charging for it would penalize an error twice: +30 s *and* the reveal it triggered;
- `document.hidden`;
- any single tick > 2000 ms (background-tab throttling, laptop sleep).

`rawActiveMs` is persisted on every mutation, so a mid-game reload resumes rather than
restarts. Wall-clock `Date.now()` is recorded too, but only for display ("played at 08:12").

**Clip playback time is charged.** The 30 s preview runs inside `listening`, so deciding you
have heard enough is part of the game and a player who listens to all ten clips in full pays
~300 s for it. This is deliberate — it is what makes the daily a speed/accuracy trade-off
rather than a pure accuracy test — but it is the other obvious tuning knob if playtesting says
the clip dominates the score.

### 9. Anti-cheat — what is actually achievable

Stated plainly: **a static client-side app cannot prevent cheating.** The bundle ships the
pool, the years, and the generator. Anything else would be theatre. What the design does:

| Layer | Measure | Honest strength |
|---|---|---|
| Casual devtools | Pool years XOR-masked with a keystream derived from the daily seed | Obfuscation only — raises effort from 10 s to ~10 min |
| Clock tampering | `performance.now()` for scoring; future dates refused | Defeats accidental clock drift, not deliberate farming |
| Timer farming | Pause on hidden/revealing, cap idle gaps, persist across reload | Solid |
| Implausible play | any `thinkMs < 400`, or `rawActiveMs < 10 000` over 10 rounds → `suspect: true` | Flags, never silently discards |
| Replay | Attempt bound on first interaction; write-once per date | localStorage is clearable — this is a nudge |
| Real integrity | Server tier (below) | The only actual answer |

The per-round `thinkMs` log makes the plausibility check much sharper than a single total would:
a human cannot hear a clip and place a card in 400 ms, ten times running.

Server tier, when it exists: `GET /daily/:date` issues a short-lived signed token carrying the
server's own `iat`; `POST /daily/:date` submits the round log and must present it. The server
holds the pool, replays the log against its own canonical solution, and computes `errors` and
`adjustedMs` itself. Nothing self-reported is ever trusted.

Until then: local stats are the player's own, and **no public leaderboard should be shipped**,
because an unvalidated one is simply a list of who edited localStorage most creatively.

---

## Phase 2 — Adversarial Review

Reviewing the above as the design of someone else, looking for the ways it breaks.

### 1. The weekly Action rewrites the source data — **critical**

`.github/workflows/update-dates.yml` runs every Monday and commits changes to
`date-overrides.json`. If generation read that file, **every past challenge would silently
change every Monday**, and every archived attempt would be graded against a different puzzle
than the one played.

*Fix:* the frozen `pool-vN.json` snapshot (§2.1). A pool file is written once, then treated as
immutable — enforced by a unit test asserting `contentHash`, so a stray edit fails CI. The
weekly job keeps improving `date-overrides.json` for the regular game modes; those corrections
reach daily play only when a human ships `pool-v2` with a future `activeFrom`.

### 2. `toISOString()` — the most likely real bug

`new Date().toISOString().slice(0,10)` returns the **UTC** date. For any player west of
Greenwich, from local 16:00–19:00 onward it reports tomorrow, so they get tomorrow's puzzle in
the afternoon and the same puzzle twice. *Fix:* `localDateISO()` built from
`getFullYear/getMonth/getDate` (§3), and a lint rule / test banning `toISOString` in `src/daily`.

### 3. Timezone policy

Two coherent options, and they conflict:

- **Global UTC rollover** — everyone switches simultaneously, but for US players "today's
  puzzle" changes at 17:00 local, mid-session.
- **Local calendar date** — everyone gets the same puzzle for the same *named* date, rolling
  over at their own midnight.

*Decision:* local calendar date (what Wordle does). The cost is a spoiler window — Auckland
finishes puzzle #N about 21 h before Los Angeles starts it. That is acceptable and is why share
cards must carry the puzzle number and never the years. *Additional guard:* clamp the playable
range to `[EPOCH, localToday]`; a client clock set forward still farms tomorrow, which is
unpreventable client-side and is handled by the server's own clock once one exists.

### 4. DST arithmetic

`(Date.parse(a) - Date.parse(b)) / 86400000` is wrong on the two DST-transition days each year
— 23 h and 25 h days make `dayIndex` drift by ±1 and hand the player the wrong puzzle. *Fix:*
`Date.UTC(y, m-1, d)` anchoring (§3), which removes the timezone from the arithmetic entirely.
Regression test: every date across a DST boundary in `Europe/Paris` and `America/Los_Angeles`.

### 5. Seed correlation, not just collision

Collision is the wrong worry (§5 quantifies it as negligible). The real failure mode is
**correlation**: a cheap hash of `'2026-10-01'` vs `'2026-10-02'` differs in a few low bits, and
a weak PRNG seeded from it produces visibly similar draws on consecutive days. *Fix:* SHA-256 +
sfc32 with 12 warm-up rounds. *Test:* over 10 000 consecutive days, per-track selection
frequency must stay within ±3σ of uniform, and the mean overlap between day N and N+8 (the
first day the exclusion window releases) must match the random baseline.

### 6. Preview-URL rot, and the rate limit behind it

Deezer preview URLs expire and tracks get delisted. If an unplayable track were skipped and
replaced, the set would change and determinism would be gone.

*Fix:* the challenge **is** the 10 track ids; playability is a rendering concern. Preview URLs
resolve at play time; if one is missing the card still renders (title, artist, cover) with audio
disabled and a "place it blind" note. Never substitute.

**The failure this actually produced in practice was not rot but rate limiting.** Deezer allows
50 requests per rolling 5 seconds, then answers `{"error":{"code":4}}` for about five seconds —
and JSONP *resolves* with that body rather than rejecting, so an over-quota reply was
indistinguishable from a real one. Booting the app costs ~44 requests (playlist pagination plus
the 40 track lookups behind the regular-mode prefetch); a daily added 11 more, crossed the line,
and the tail of the batch came back as errors, was read as "no preview", and told the player
that perfectly good songs had none. Measured: the first quota error arrives at request 51, and
a single 5-second pause clears it.

Three defences, in order of how much they buy:

1. **Resolve daily previews from the listing the app already paginated.** `getRawTrackList`
   returns playlist entries that carry `preview` and the cover, so a day now costs **zero**
   extra requests instead of 11. Only pool ids absent from the current playlist fall back to
   individual lookups.
2. **A sliding-window limiter** (`rateLimit.ts`, 45 per 5s) in front of every Deezer call, plus
   retry-with-backoff on the codes that mean "ask again" (4 quota, 700 busy). Measured over a
   real boot: 106 calls, max 45 in any 5-second window, never reaching 50.
3. **Re-resolve once at play time** before declaring a preview missing — which also repairs a
   genuinely expired URL, since the retry fetches a freshly signed one.

Only after all three fail does the player see the blind-placement message, which is now a
statement about the track rather than about our request budget. The same limiter protects the
older modes, whose "that song could not be played, it was skipped" message had the same root
cause and silently shortened runs.

### 7. Constraint deadlock

A 14-day cycle consumes 154 of 298 tracks, so the last slots draw from a shrinking remainder.
Combined with distinct-year, one-artist and <=4-per-decade, a pool skewed toward one decade can
fail to fill a day. *Fix:* the deterministic relaxation ladder (§4) plus build-time asserts in
`build-daily-pool.mjs` — the pool must have >=120 tracks, >=25 distinct years and >=8 decades,
or the script refuses to write it. The live pool has 298 tracks, 61 distinct years and 8
decades, and the CI replay confirms 1095 consecutive days generate without ever throwing.

Reality check on the real data, after a pass of the Discogs override script. Pool v1: **388
tracks, 67 distinct years, 9 decades, 1947-2025**. The decade spread is still weighted toward
recent music (93 in the 2010s, 78 in the 2000s) but no longer lopsided: 39 in the 1960s, and 43
tracks predate 1970.

Two things that pass sit close enough to matter:

- **Year crowding, not decade crowding, is the real constraint.** Only one track per year can be
  drawn per day, so a track sharing 2016 with fifteen others is reached less often than one
  alone in its year — measured at 28.2 vs 35.7 draws over 1095 days, a ~21% penalty. Inherent to
  the distinct-year invariant and mild at this pool shape, but it grows as the pool deepens
  without widening. The lever is more *years*, not more tracks.
- **Discogs matching is a heuristic and gets some wrong.** The script takes the first search hit,
  which matched a reissue or an unrelated record for several tracks — Sinatra's "My Way" came
  back as 1951 (it is 1969), "Can't Take My Eyes off You" as 1960 (1967), "California Dreamin'"
  as 1999 (1965). Those are now pinned manual overrides, which the script preserves. **A pool
  build is not a substitute for eyeballing the pre-1970 entries**, where the error rate is
  highest and a wrong year is most conspicuous to a player.

### 8. Degenerate draw orders — the difficulty lottery

The pre-solved-board risk of a single-submit format is gone, but incremental play introduces a
sharper one: **the draw order is the difficulty.** A day whose 10 cards arrive in ascending
year order is trivial — every placement is "at the right end" — while a day that repeatedly
drops cards into a dense middle is genuinely hard. Unmanaged, daily difficulty swings wildly
and the leaderboard compares people across days that aren't comparable.

*Fix:* the interior-placement floor (§4 step 7) — simulate a perfect run, require ≥4 rounds
whose correct index is strictly interior, re-roll deterministically otherwise. *Test:* over
3650 replayed days, report the distribution of interior-placement counts and assert the floor
holds; eyeball the histogram before launch to pick the threshold.

### 9. Mid-game reload

Reset the timer on reload and the player farms a 10-second run by refreshing at round 9. Keep
the timer naively on wall clock and someone who leaves the tab open overnight scores 9 hours.
*Fix:* persist `{ rounds, rawActiveMs }` on every mutation; resume on reload; accumulate active
time only, pausing on `document.hidden`, on `revealing`, and discarding ticks > 2 s (§8). The
attempt binds to the date on first interaction and is write-once.

There is one genuinely new hole here: a player mid-run who is doing badly can clear
localStorage and start the day over. Client-side this is unfixable — it is the same nudge-only
guarantee as everywhere else, and it is why the leaderboard waits for a server.

### 10. Version skew — the silent desync

GitHub Pages plus an aggressive cache (or a service worker) can leave a player on a stale
bundle. They then generate the puzzle with *old code* and get a different 10 songs from
everyone else, with no error and no way to notice. *Fix:* challenges carry `algoVersion`; the
app fetches a tiny `version.json` with `cache: 'no-store'` on load and prompts a refresh when
stale. And the standing rule: **never change the algorithm in place** — a new `algoVersion`
activates from a future date through the same registry mechanism as pools.

### 11. Archive performance

A calendar of 1000+ days must not call `challengeFor()` per cell — that would be 1000 SHA-256
calls plus 8× that for exclusions, on every render. *Fix:* the calendar reads only
`DailyStore.attempts` (a plain map lookup) for its played/perfect badges; generation stays lazy
and happens exactly once, when a date is actually opened. Pool files load via dynamic
`import()` so only the versions actually touched are fetched.

### 12. Stale attempts after a pool bump

If a pool bug forced a correction, an archived attempt could be graded against a solution that
no longer matches what was played. *Fix:* attempts store `poolVersion` + `seedHex`; on reopening
an archive entry, mismatch → show "generated with an earlier pool version" rather than a wrong
result. This is why `seedHex` is stored at all.

### 13. Share cards leak the answer

The format gives a natural share grid — ten ✅/🟥 in draw order, plus the adjusted time. But a
grid encoding *where* each card went, or its year, can be reverse-engineered into the solution
across a handful of shares. *Fix:* encode correct/incorrect per round only, plus the puzzle
number and the adjusted time — never a year, never a track name, never a slot index.

### 14. Multi-device divergence

Phone and laptop keep independent localStorage, so the same day can be played twice and the
streak counter diverges. No client-only fix exists. *Disclosure:* label stats as
device-local; convergence is a feature of the account/server tier, not a bug to patch around.

### 15. Ranking by errors first would neutralize the +30 s

Worth calling out as a design bug waiting to happen, because it is the intuitive thing to
build: sort by `errors DESC, time ASC` and the penalty becomes decorative — it can only ever
reorder players who already tie on errors, which is exactly the ordering you get without it.
*Fix:* `adjustedMs` is the single ranking key (§7). If that feels too harsh on accurate-but-slow
players, the lever is the constant, not a second sort key.

### 16. Charging reveal-animation time double-penalizes errors

`REVEAL_MS` is 1600 ms and the player cannot influence it. If the timer runs during
`revealing`, an error costs 30 s *plus* the reveal it triggered, and a slow device costs more
than a fast one. *Fix:* the timer accumulates only in `listening` / `pendingValidation` (§8).
This also makes the clock honest — it measures thinking, which is the thing being ranked.

### 17. Changing the penalty re-ranks history

`ERROR_PENALTY_MS` and "is clip time charged?" both feed `adjustedMs`, which is stored per
attempt. Tuning either one after launch silently re-ranks every archived day if scores are
recomputed on read. *Fix:* store `adjustedMs` as computed on the day, never recompute it from
`rounds` on read; and gate any change behind a new `algoVersion` with a future `activeFrom`,
the same mechanism as pools.

### 18. Two unseeded shuffles on the existing path — **critical**

Every player must receive the same anchor and the same 10 songs **in the same order**: in
incremental play the draw order *is* the difficulty (a card is far easier to place against a
3-card timeline than a 9-card one), so a per-player order would make `adjustedMs` compare
people who played different puzzles, and the interior-placement guard would bound nothing.

Two call sites default to `Math.random` and would break this silently:

- `src/engine/game.ts:44` — `startGame()` shuffles `tracks` internally before dealing the seed
  card, so a deterministic `draw[]` gets scrambled per player.
- `src/providers/deezer/api.ts:260` — `resolveTrackBatch()` shuffles candidates and accepts no
  `rng` argument at all.

The failure is invisible: the same 11 tracks for everyone, in a different order each. *Fix:*
the daily path bypasses both. Selection runs in `daily.ts` against the frozen pool — Deezer is
asked only to resolve preview URLs for ids that are already fixed, never *which* tracks — and
dealing uses a new `startDailyGame(ordered: GameTrack[])` that builds `GameState` directly
(`ordered[0]` as anchor, the rest as deck) with no shuffle, leaving the tested `startGame`
untouched. *Test:* the golden fixture asserts the full ordered id list per date, not a set.

---

## Implementation order

1. `scripts/build-daily-pool.mjs` → `pool-v1.json` + `contentHash` test.
2. `src/engine/daily.ts` — `localDateISO`, `dayIndexFor`, `seedFor`, `sfc32`, `selectDaily`,
   plus the interior-placement guard. Pure, no React, unit-tested alongside `game.test.ts`.
   Add the `onError: 'end' | 'continue'` option to `validate()` in `game.ts` — default `'end'`
   keeps every existing test green.
3. Golden-fixture test: 30 known dates → exact **ordered** track-id lists. This single test
   catches pool mutation, algorithm drift, timezone regressions and any stray reshuffle at once.
4. `src/services/dailyStore.ts` — localStorage, resume, stats.
5. `src/screens/Daily.tsx` — reuses `Timeline`/`TimelineCard` with a red variant for
   `wrongIds`, plus the live +30 s timer; archive calendar; a third card in `ModeSelect`.
6. Share card.
7. (Later) server tier, real leaderboard.
