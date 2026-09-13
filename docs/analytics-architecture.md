# Engagement & Score Analytics — Technical Architecture

Status: **Phase 1 implemented** (client wiring, Worker, UI). Not deployed — with no
`VITE_ANALYTICS_URL` at build time the whole feature is inert, which is how the repo ships.

Target: HitsTime (React 18 + Vite, **fully static**, GitHub Pages, Deezer public API via JSONP,
no backend, no accounts).

Goal: per game mode (`daily`, `timeline`, `olderYounger`), know

1. **Engagement** — how many people play, how many runs they play;
2. **Performance** — average score, and where a player stands.

Companion documents, both of which constrain this one:
[daily-challenge-architecture.md](daily-challenge-architecture.md) (what a score means) and
[anti-cheat-architecture.md](anti-cheat-architecture.md) (what a score can be trusted to mean).

---

## Phase 0 — Feasibility

### 0.1 What "static" has to mean

Two readings, and only one of them survives:

| Reading | Verdict |
|---|---|
| **The site** is a static bundle on GitHub Pages, no hosting migration | ✅ Achievable, and what was built |
| **The system** has no server-side code anywhere | ❌ Not achievable for these metrics |

GitHub Pages is untouched — same build, same workflow, same `dist/`. One Cloudflare Worker on a
separate origin does the counting. Option B in the sense of *migrating the frontend* is not
required.

### 0.2 Why browser-direct BaaS is the option that fails

Supabase or Firebase called straight from the bundle with the public anon key hits three walls:

1. **The write key is public by construction.** PKCE-style "it's a public identifier" reasoning
   holds for an auth client id; it does not hold for a row-insert endpoint. With anonymous writes
   enabled — and there are no accounts, so they must be — RLS constrains *shape*, never *truth*:
   `insert into scores (mode, score) values ('timeline', 999999)` satisfies every policy that can
   be written.
2. **No server-side identity derivation.** Counting distinct players without storing an
   identifier needs `HMAC(secret salt, ip ‖ ua)` computed where the client cannot read the salt or
   forge the address. A browser-direct design has nowhere to put it, so "player count" degrades to
   a persistent client id (a tracking identifier → consent banner) or nothing.
3. **No place for rate limiting or replay defence.** Quota exhaustion becomes the only
   backpressure, and exhausting a shared project's quota also takes the read path down.

Firebase App Check closes (1) and (3) partly, by shipping Google's reCAPTCHA into the page — which
trades away the privacy property the whole design exists for.

### 0.3 Why hosted analytics is not enough either

Plausible / GoatCounter / Cloudflare Web Analytics are the right *privacy* model — §1.2 copies
Plausible's rotating-salt trick — but they answer half the question:

| Need | Hosted analytics |
|---|---|
| Runs per mode | ✅ custom event per mode |
| Distinct players per day | ✅ that is their job |
| Average score per mode | ⚠️ only via bucketed event props |
| Where does this player stand | ❌ no distribution to read back |
| Read the number into the game UI | ❌ no public query API on free tiers |

Worth adding alongside for page traffic. Not a substitute.

### 0.4 The verification argument, after `d79fb7a`

The usual reason to demand a real backend is score verification. Two commits changed the shape of
that argument here:

- **The pool and the generator left the browser.** Challenges are generated at build time
  (`build/dailyShards.ts`) into one JSON file per day; the client fetches a day and the 388-track
  pool never leaves the repo. An earlier draft of this document called the global best score
  "unfixable" because `pool-v1.json` shipped every year to every player. That is no longer true.
- **The engine is server-runnable.** `src/engine/daily.ts` is pure TypeScript with no DOM
  dependency, so a Worker can import the same module and the same frozen pool, regenerate a day,
  and replay a player's round log against its own canonical solution. The verifier would not be a
  reimplementation that can drift — it is the client's own code.

What remains true: the encryption steps of anti-cheat §4.2–4.3 are not built, so **today's**
published shard is plaintext, and the timezone window means tomorrow's is public up to ~26 hours
early. Today's answers are obtainable with effort. That is a much smaller claim than "the whole
archive ships to everyone", and §1.3 is calibrated to it.

### 0.5 Recommendation, as built

```
GitHub Pages (unchanged)                Cloudflare Worker              Cloudflare D1
┌────────────────────────┐  POST /v1/start   ┌────────────────┐   ┌────────────────────┐
│ HitsTime bundle        │ ─────────────────►│ ticket (HMAC)  │   │ mode_daily         │
│  services/analytics.ts │ ◄─────────────────│                │   │ score_bucket       │
│  services/stats.ts     │  POST /v1/finish  │ clamp, cap,    │──►│ visitor_day        │
│  components/           │ ─────────────────►│ aggregate      │   │ used_ticket        │
│    GlobalStats.tsx     │  POST /v1/ops     │                │   │ ops_daily          │
│                        │ ─────────────────►│ rotating-salt  │   └────────────────────┘
│                        │  GET  /v1/stats   │ visitor hash   │
│                        │ ◄─────────────────│ (edge-cached)  │
└────────────────────────┘                   └────────────────┘
```

Trade-offs accepted: one more deploy target, one more DNS name, a dependency whose outage must be
invisible (§2.8), and a free tier whose real risk is abuse rather than traffic (§2.7).

**This is the same Worker as anti-cheat §2.** That document already specifies a Cloudflare Worker
with `start`/`round`/`finish` routes, an HMAC token carrying a server-side `iat`, and
server-computed scores. This design was independently converging on it. When the verifying routes
are built they belong beside these ones, sharing this ticket — not in a second service.

One correction to that plan: it names Workers KV for storage. KV has no atomic increment, so two
players finishing together read the same counter and one write is lost. Counters live in **D1**;
KV turned out not to be needed at all, since `used_ticket` also wants strong consistency.

---

## Phase 1 — Architecture

### 1.1 Metric definitions

The three modes do not produce comparable numbers, and pretending otherwise is the easiest way to
ship a meaningless dashboard.

| Mode | Score | Direction | Comparable across players? |
|---|---|---|---|
| `daily` | `adjustedMs` = think time + 30 s × errors + 5 min × peeks | **lower is better** | ✅ same 10 cards, same day, same order |
| `timeline` | streak points (1 + 2 + 3 …), sudden death | higher is better | ❌ bounded by playlist length and composition |
| `olderYounger` | points | higher is better | ❌ same reason |

Consequences, enforced in code:

- Every aggregate is keyed by **`(mode, scope)`**, never mode alone. `scope` is the puzzle date
  for `daily` and `provider:playlistId` for the others. A "global best for timeline" with no
  playlist scope is not a number — a 300-track playlist outranks a 20-track one arithmetically.
- `direction` is derived from the mode **server-side** (`worker/src/scope.ts`) and never read off
  a request. A row whose direction disagreed with its mode would make "best" mean its opposite,
  and nothing on a dashboard would look wrong. There is a test for it.
- **Scope cardinality is capped.** Playlist ids are attacker-controlled text reaching a primary
  key. Only allowlisted ids keep their identity; everything else collapses to `scope = 'other'`.

### 1.2 Privacy model

The target is **no consent banner, honestly earned**.

| Property | Choice |
|---|---|
| Cookies | none |
| Client-side identifier | **none** — no UUID, no fingerprint, no storage of any kind |
| IP address | used in-memory to derive a hash, **never written, never logged** |
| User agent | same |
| Distinct-player counting | `vh = HMAC(salt_of_day, len‖ip ‖ len‖ua)`, truncated to 64 bits |
| Salt | `HKDF(SALT_KEY, utc_date)` — derived per request, never stored |
| Payload | mode, scope, score, three flags. No free text, no round log |
| Retention | `visitor_day` purged at 30 days; aggregates kept (not personal data) |
| Opt-out | `doNotTrack === '1'` or `globalPrivacyControl` → the client sends nothing |
| Region | create D1 with an EU location hint |

Two implementation details that are load-bearing rather than incidental:

- **The salt is derived, not stored.** A stored salt needs a rotation job, and reading it per
  request from an eventually-consistent store would hand two edge locations different salts around
  midnight — silently double-counting every visitor in flight. HKDF from a root secret gives every
  location the same value with no read and no rotation window.
- **The hash input is length-prefixed.** Plain concatenation would let a crafted user agent make
  two visitors hash alike (`"1.2.3.4" + "Foo"` vs `"1.2.3.4F" + "oo"`). There is a test for it.

Because nothing is written to the player's device, the ePrivacy consent trigger is not pulled.
**This property is fragile.** The day someone adds an `analyticsId` to localStorage "just to dedupe
better", the banner becomes mandatory. `analytics.test.ts` asserts no storage API is touched;
argue with that test first.

Cost of honesty: uniques are an estimate. Phone + laptop counts twice; two people behind one NAT
on the same browser build count once. The field is named `visitors_est`, never `players`.

### 1.3 The honest limit on a global best score

**No global best score is published, and none is stored.** `mode_daily` has no best-score column —
a structural decision, commented as one in `worker/schema.sql`.

Three reasons, in increasing order of how much they should worry you:

1. Nothing on the server verifies a score today. A best would be whatever the most creative
   player submitted, permanently, and unremovably — you cannot tell which entry was forged.
2. Today's shard is plaintext (§0.4), so a determined player can know the answers and set a
   genuine, unbeatable time.
3. [anti-cheat-architecture.md](anti-cheat-architecture.md) §3 already committed to this in
   writing: *do not ship a public leaderboard, ranked share codes, or any cross-player comparison
   until the verifying server exists.*

The line this design draws against that commitment:

| Number | Whose is it? | Shipped? |
|---|---|---|
| plays, `visitors_est`, average, distribution | nobody's — an aggregate | ✅ yes |
| a percentile computed **in the player's own browser** | nobody's — it reveals no individual run | ✅ yes |
| global best / high score / ranked list | one specific player's | ❌ no — this is the Option B trigger |

An aggregate no individual owns is not a cross-player comparison in the sense that commitment
protects against: one cheater moves a 300-sample mean by nothing, and no player ever sees another
player's result. A maximum fails both tests.

### 1.4 Data schema

Aggregates only. There is no per-run table — a run row would be data needing retention and
justification, and every question asked of it is answerable from counters and a histogram.
Authoritative version: [`worker/schema.sql`](../worker/schema.sql).

```sql
CREATE TABLE mode_daily (            -- one row per (UTC ingestion day, mode, scope)
  day, mode, scope, direction,       -- direction CHECK'd to ('min','max')
  starts, finishes, cleared,
  peeked, suspect,                   -- counted, and excluded from the two below
  score_count, score_sum,            -- clean runs only; avg = sum / count
  PRIMARY KEY (day, mode, scope)
) WITHOUT ROWID;                     -- NOTE: no score_best column. See §1.3.

CREATE TABLE score_bucket (          -- the histogram, one row per bin
  day, mode, scope, buckets_v, bucket, n,
  PRIMARY KEY (day, mode, scope, buckets_v, bucket)
) WITHOUT ROWID;

CREATE TABLE visitor_day (day, vh, mode, starts, runs, PRIMARY KEY (day, vh, mode)) WITHOUT ROWID;
CREATE TABLE used_ticket (nonce PRIMARY KEY, exp_ms) WITHOUT ROWID;
CREATE TABLE ops_daily  (day, event, scope, n, PRIMARY KEY (day, event, scope)) WITHOUT ROWID;
```

Two choices worth their comments:

- **The histogram is rows, not a JSON column.** A JSON array needs read-modify-write, and two
  players finishing in the same instant would lose an increment. An UPSERT on a bin is atomic.
- **Nonces are in D1, not KV.** `INSERT … ON CONFLICT DO NOTHING RETURNING` answers "did I win the
  insert" atomically; a KV read-then-write lets a fast double-submit through the gap.

`buckets_v` is a one-way door. Moving an edge silently re-slices history, and a pre-change
percentile compared with a post-change one is a fake trend — the same family of mistake as
changing the error penalty and re-ranking the archive. Bump the version; never edit the edges.

### 1.5 Wire protocol

There are no credentials in the bundle, because there are none to hide. The endpoint is public by
necessity; what protects it is the ticket and the caps, not secrecy.

```
POST /v1/start   { mode, scope, algoVersion?, poolVersion? } → { ticket }   45-min TTL, single-use
POST /v1/finish  { ticket, score, cleared, errors?, peeks?, suspect? } → 204
POST /v1/ops     { event: 'shard_missing', scope }            → 204
GET  /v1/stats?mode=…[&scope=…]                               → aggregates, s-maxage=300
```

The **ticket** carries `{ mode, scope, iat, nonce, vh, day }`, HMAC-signed:

- `iat` is the **server's** clock, so elapsed time is server-measured rather than self-reported.
  A script cannot submit a thousand implausibly good runs in a second — it must wait out the time
  it wants to claim, once per ticket.
- `nonce` is burned on finish. One ticket, one run.
- `vh` rides inside, so finish needs no second IP derivation and a run cannot be attributed to a
  different visitor than the one who started it.
- `day` is the start day, so a run across UTC midnight books to one row.

It is not an identity, not a session, and not authentication. The score is deliberately *not*
signed: a signature over a self-reported number proves nothing.

`GET /v1/stats` has two shapes, and the difference matters:
`?mode=daily&scope=d:2026-09-13` is "everyone who played this puzzle", across ingestion days;
`?mode=daily` is "is anyone here right now", today in UTC across every scope. Conflating them
would double-count around midnight, because the puzzle date is a *local* calendar and the
ingestion day is UTC — the same trap as the `dateForDayIndex` bug fixed in `d79fb7a`.

### 1.6 What the server does and does not check

Implemented:

| Rule | Why |
|---|---|
| Score must be in a per-mode plausible range | keeps one absurd value out of an average |
| Daily: claimed time ≤ elapsed since `iat` + 5 s | a run cannot claim more time than the ticket has existed |
| **Peeked runs are excluded from the average and histogram** | see below |
| Suspect runs likewise excluded, still counted as plays | reuses the existing `DailyAttempt.suspect` |
| ≤ 5 scored runs per visitor per day per scope | flooding costs uniques, not the mean |
| ≤ 200 starts per visitor per day | a human does not start 200 runs |
| Nonce single-use | no replay |
| Scope shape + allowlist collapse | no cardinality attack |

The clamp is **one-sided by design**: a *fast* run is never rejected. A genuinely quick player is
indistinguishable from a lucky one, and refusing them would be a worse bug than counting a cheat.
Speed feeds `suspect`, never a rejection — matching the existing daily design.

**The peek exclusion is the correction that mattered.** `PEEK_PENALTY_MS` is 300 000 ms, daily
scores live in the tens of seconds, and `src/services/devtools.ts` documents its own detector as a
heuristic that sees docked panels only. A handful of false positives would add five minutes each
and make the average fiction. Peeked runs therefore count as plays, are counted separately as
`peeked`, and never reach `score_sum` or a bucket. The player's own score keeps its penalty on
their end screen; they are simply not ranked against a clean distribution (§1.8).

`peeked` being tracked separately is also the only way to learn the detector's real-world false
positive rate. If 12 % of runs are flagged, the detector is miscalibrated, not the players.

Not implemented: replaying the round log against a canonical solution. That is the verifying tier,
it belongs with anti-cheat §2, and the client deliberately does not even send a round log yet —
data collected for no live purpose is data to explain.

### 1.7 Client integration

`src/services/analytics.ts` writes; `src/services/stats.ts` reads. Separate files on purpose, so
nobody adds an `await` to the write path "while we're here".

Call sites, all pre-existing functions in `src/store/index.ts`:

| Hook | Call |
|---|---|
| `startGame` | `beginRun(mode, playlistScope(...))` — fired next to the deal, **never awaited** |
| `startDaily` | `beginRun('daily', dailyScope(date))` — *after* the finished-attempt check, so reviewing an archived day does not inflate today's plays |
| `finishGame` | `reportRun({ score, cleared })` |
| `finishDaily` | `reportRun({ score, cleared, errors, peeks, suspect })` |
| `NotPublishedYet` | `reportShardMissing(date)` (§1.9) |
| `goHome` / `changeMode` / `openArchive` | `abandonRun()` — an abandoned ticket is dropped, not spent by the next run to end |

Three rules the write path keeps:

1. **Never blocks the game.** 3 s timeout via `AbortController`, every path wrapped, a null ticket
   just means the run goes uncounted. A test asserts `beginRun` resolves against a hung connection.
2. **Never touches storage.** No retry queue. A dropped run is an acceptable loss; a consent
   banner is not.
3. **Sends no free text.** Playlist ids, never names — a name is authored by whoever owns the
   playlist and has no business leaving the browser.

Submission uses `fetch(..., { keepalive: true })` and fires when the end screen renders, not on
`pagehide`: the request starts while the page is unambiguously alive. A few percent will still be
lost. That is the right trade.

### 1.8 What the player sees

`src/components/GlobalStats.tsx`, in three places:

- **Daily end screen** — below the existing personal grid, behind an `Everyone` divider, because
  the four boxes directly above it are the player's own history and the two are easy to confuse:
  *"Faster than 38% of players · Average 2:18"*.
- **Mode select** — one grey line per card, *"341 played today"*. Counts need no sample floor;
  "3 played today" is honest at three, where an average of three runs is not.
- **Free-play end screen** — same block, scoped to the playlist.

The percentile is what replaces a best score, and it is computed **in the browser** from the
histogram (`beatShare` in `stats.ts`): count the bins the player beats, add half their own bin —
the midpoint convention — and divide. It costs no extra request, reveals no individual's run, and
one forged entry moves it by one player out of hundreds.

Display rules:

- Renders **nothing** until real data is in hand — no spinner, no dash. A placeholder on an end
  screen reads as broken; absence reads as "not deployed", which is the truth.
- Below the server's sample floor (30 clean runs) the server sends `avg: null` and `buckets: null`,
  and the UI falls back to a play count. The floor lives server-side so the client cannot be
  tempted. A consequence worth knowing before it is reported as a bug: **the numbers a player sees
  change over the day** as the sample fills.
- Clamped to 1–99 %. "Faster than 100% of players" is a claim about a population that a
  300-sample histogram cannot support.
- **A peeked run shows the average but no percentile.** Its score carries five minutes the
  distribution excludes; ranking it would be arithmetic against a different population.
- A privacy line sits under the numbers, linking the claim to the behaviour.

### 1.9 The metric nobody asked for

`POST /v1/ops { event: 'shard_missing' }`, fired when `loadChallenge` 404s.

The scheduled deploy is what publishes each new daily puzzle, and GitHub disables scheduled
workflows on a repository with no commits for 60 days — after which **the site keeps working and
serves its last built day forever**. A silent freeze. A spike in `shard_missing` is the only
external signal that it has happened. It is one line of client code and the most valuable counter
in the system.

---

## Phase 2 — Adversarial Review

### 2.1 The answer key is out of the bundle, but today's day is still plaintext
Pool and generator no longer ship (`d79fb7a`), so the far future is sealed and clock-forwarding
returns a 404. But anti-cheat §4.2–4.3 (encrypted shards, unguessable key file) are not built, so
today's eleven cards and their years are a network-tab read away, and tomorrow's file is public up
to ~26 hours early by the timezone argument in `publishWindow.ts`.
**Mitigation:** publish no extremal number (§1.3). Averages and percentiles absorb it; a maximum
would not. Revisit if the encryption steps land.

### 2.2 Ticket replay and mass submission
One valid ticket, replayed, would let an attacker own the mean.
**Mitigation:** single-use nonce in D1 (atomic, not eventually consistent); ≤ 5 scored runs per
visitor per day; server-issued `iat` so a fake run costs real wall-clock time. Residual: an
attacker can still drip. The caps absorb a drip.

### 2.3 Endpoint flooding → the denial-of-*metrics* attack
The realistic threat is not reading the data; it is burning the day's request quota at 09:00 so no
real player is counted.
**Mitigation:** a Cloudflare rate-limiting rule on `/v1/*` **in front of** the Worker, so blocked
requests are free (documented in `worker/README.md`, not implementable in Worker code); a 200
starts-per-visitor cap; an `Origin` allowlist that echoes exactly and never `*` — weak against
curl, but it filters the lazy majority; and a read path that is edge-cached with a static snapshot
fallback, so metric writes and gameplay reads fail independently.

### 2.4 Scope cardinality
An unbounded `scope` column is a cheap way to write a million rows.
**Mitigation:** shape regex, then allowlist collapse to `'other'`; length cap; daily scopes
additionally bounded to a plausible date window so a clock-forwarded client cannot create a row
for 2031. Tested.

### 2.5 The uniques number will be quoted as fact
CGNAT collapses distinct people; two devices inflate them.
**Mitigation:** the field is `visitors_est` in the schema, the API, and the TypeScript type. This
is a communication control, and the one most likely to be skipped.

### 2.6 Salt rotation
A stored salt read per request is an eventual-consistency bug around midnight.
**Mitigation:** derived per request via HKDF (§1.2). No rotation job, no window. Rotate `SALT_KEY`
quarterly, accepting that it resets cross-day linkability — which is the point.

### 2.7 Free-tier ceilings
Per completed run: 2 requests, ~4 D1 writes (visitor upsert, aggregate upsert, bucket upsert,
nonce insert), reads ≈ 0 thanks to edge caching. That puts the ceiling in the low tens of
thousands of runs per day — far above anything organic here.
**Caveat, deliberately not hand-waved:** these tier numbers change and have not been re-verified
against current pricing. Check before deploy and encode the result as a monitored budget. The
correct reading is that **capacity planning here is an abuse problem, not a traffic problem** —
§2.3 is the capacity plan.

### 2.8 A Worker outage must not be a game outage
A hard dependency in `startDaily` would make a Cloudflare incident look like a broken game.
**Mitigation:** 3 s timeout, null ticket, play proceeds; `beginRun` is never awaited. Tested
against rejection, 500, and a hung socket. `stats.ts` failures render nothing.

### 2.9 `keepalive` is not a guarantee
64 KB body cap, dropped by some browsers on tab close, historically lost on bfcache navigation in
Safari — and a share-and-close player is the most interesting one.
**Mitigation:** submit when the end screen renders, not on `pagehide`. Payload is ~100 bytes.
Accept the loss; do not "fix" it with a storage-backed queue (§1.2).

### 2.10 The peek penalty pollutes the average — **the correction this review caught**
5 minutes added to a distribution measured in seconds, from a heuristic its own source documents
as fallible.
**Mitigation:** excluded from `score_sum` and the histogram, counted as `peeked`, and not ranked
on the player's own screen. Tested end to end.

### 2.11 One hot row per day
Every daily finisher UPSERTs the same `(day, 'daily', date)` row, and SQLite serialises those.
**Mitigation:** none needed at this scale. Flagged as the first thing to shard if write latency
appears; the standard fixes are N counter shards summed at read time, or a Durable Object per key
batching writes. Do not build it speculatively.

### 2.12 `direction` inversion
Applying `MAX()` to a daily row would make the "best" the worst run ever recorded, and it would
not look wrong.
**Mitigation:** derived server-side from the mode, a `CHECK` constraint in the schema, and a test.
Cheapest possible bug to prevent.

### 2.13 Two calendars
The puzzle date is the player's **local** date; the aggregate day is **UTC**. Both are needed and
mixing them double-counts around midnight.
**Mitigation:** scopes are kind-prefixed (`d:2026-09-13`, `deezer:123`, `other`), every read
requires `mode`, and no endpoint accepts a scope-only query. The ticket carries its start day so a
run spanning midnight books to one row. Tested.

### 2.14 The no-banner posture rests on an implementation detail
One well-intentioned PR away from being false.
**Mitigation:** encoded as a test (`analytics.test.ts` asserts no storage API is touched, and that
DNT/GPC suppress everything), not as a sentence in a document. Add it to the review checklist
beside "`EPOCH` never changes".

### 2.15 Sub-processor disclosure
Cloudflare now sees every player's IP, even though nothing stores it. A privacy page claiming "we
use no analytics" would become untrue.
**Mitigation:** the `statsPrivacy` line in the UI, and a short plain-language note when the Worker
is actually deployed: what is counted, what is derived, what is never stored, who processes it, and
the DNT/GPC opt-out. Three sentences, not a policy.

### 2.16 Worker/client pool drift
The verification argument of §0.4 depends on both sides holding the same pool and `ALGO_VERSION`.
A Worker deployed from an older commit would reject every honest submission — a silent metrics
outage that looks like "nobody plays".
**Mitigation:** not yet live (no replay), but when it is: import the pool at build time, deploy
both artifacts from one commit, echo the Worker's versions from `/v1/start`, and alert on a
rejection-rate spike, which is that failure's signature.

### 2.17 `visitors_est` has no per-puzzle answer
Visitors are counted per mode per day, not per scope — one person playing two puzzles is one
visitor. A scope-qualified query therefore has no honest visitor number to return, and returning
today's count under a puzzle's label would be a lie with a plausible shape.
**Mitigation:** the field is `number | null` and is null for any scoped query, in the Worker, the
API and the client type. Tested.

### 2.18 The test double is not a database
`worker/src/fakeDb.ts` recognises the statements `index.ts` issues and throws on anything else. A
rewritten query fails loudly there rather than passing silently — but it is not SQL, so a
constraint violation D1 would catch (a CHECK, a key collision) will not surface in tests.
**Mitigation:** accepted. The alternative is miniflare plus a local D1, which brings a container to
a suite that runs in 1.5 s. Apply `schema.sql` to a real D1 before trusting the constraints.

---

## Implementation status

| Step | State |
|---|---|
| 1. `services/analytics.ts`, wired to the four store call sites, inert with no endpoint | ✅ done, 12 tests |
| 2. Worker: `/v1/start`, `/v1/finish`, `/v1/ops`, `/v1/stats`, D1 schema, caps, purge cron | ✅ done, 75 tests |
| 3. `services/stats.ts` + `GlobalStats.tsx` in three screens, EN/FR | ✅ done, 15 tests |
| 4. Deploy the Worker, set `VITE_ANALYTICS_URL` | ⏳ needs a Cloudflare account |
| 5. Cloudflare rate-limiting rule on `/v1/*` | ⏳ do this with step 4, not after |
| 6. Nightly `public/stats.json` snapshot job | ⏳ optional; the fallback path already reads it |
| 7. Plain-language privacy note | ⏳ with step 4 |
| 8. Verifying tier (round replay) + then, if wanted, a real best score | ⏳ anti-cheat §2 |

Nothing before step 4 is player-visible: with no `VITE_ANALYTICS_URL` the client sends nothing,
`GlobalStats` renders nothing, and the game is byte-for-byte what it was.
