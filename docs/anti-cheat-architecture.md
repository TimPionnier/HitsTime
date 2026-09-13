# Anti-Cheat & Data Security — Technical Architecture

Status: **Phase 1 steps 1–2 implemented** (§4.1, §4.3); steps 3–6 still proposed.
Supersedes and expands §9 of `docs/daily-challenge-architecture.md`.
Target: HitsTime (React 18 + Vite, GitHub Pages, no backend, no accounts).

The governing constraint is unchanged: **the site is 100% static**. This document says exactly
how far that can be pushed, where it stops being physics and starts being theatre, and what the
minimum serverless footprint is if the wall turns out to matter.

---

## 0. What is actually exposed today

Measured against the current `dist/`, not assumed:

| Asset | Exposure | Severity |
|---|---|---|
| `dist/assets/pool-v1-*.js` (79 KB) | 388 tracks with `title`, `artist`, **`year`**, `cover` in plain JSON. One `fetch()` returns the entire answer universe. | High |
| `daily.ts` in the main bundle | `challengeFor(dateISO, pool)` is exported and pure. In the console, `challengeFor('2031-04-01', pool)` prints that day's 11 cards **in dealt order**. | **Critical** |
| `useApp.getState().game.mystery` | The current card's `year` is in the zustand store from the moment it is dealt, before the clip even plays. React DevTools reads it without touching the network. | High |
| `localStorage['hitstime.daily.v1']` | Unsigned JSON. `adjustedMs`, `errors`, `streak` are all editable by hand. | Medium (see §0.1) |
| `index.html` | No CSP, no SRI on the Google Fonts stylesheet. | Medium |
| Deezer access via JSONP (`api.ts:68`) | Injects `<script src="api.deezer.com/...">` into the app origin. Deezer — or anyone who can MITM/poison that response — executes arbitrary JS as HitsTime. | Medium |
| `DISCOGS_TOKEN` | **Not** exposed. It is read only by `scripts/build-date-overrides.mjs` under Actions; `grep` confirms it is absent from `dist/`. Vite would only inline a `VITE_`-prefixed var. | None |

The critical row is not "today's answers leak". It is that **the whole archive leaks, forever,
in both directions**. Shipping the generator plus the frozen pool is mathematically equivalent
to publishing every future puzzle on launch day.

### 0.1 Calibrating the stakes

There is no server leaderboard and no account system. Today, a cheater defrauds only themselves —
plus the share text, which is the one artefact that travels to other people. So the honest value
of this work is, in order:

1. **Preserve the experience.** A player who idly opens devtools and is handed the answer has had
   the game spoiled, not won. This is the dominant real-world case and it is cheap to fix.
2. **Seal the future archive.** The one leak with permanent, irreversible consequences.
3. **Pre-build the integrity story** so a leaderboard can ship later without a rewrite.

Everything beyond that is speculative defence against an adversary who, today, gains nothing.
The design below is sized accordingly.

---

## 1. Option A — what static hosting can actually do

### 1.1 The measures, and what each one is worth

**A1 — Stop shipping the universe.** The client needs 11 cards for one date, not 388 tracks for
all dates. Move generation to build time and publish a **per-day shard**. This alone deletes the
79 KB chunk and removes `challengeFor` from the attacker's reach.

**A2 — Publish on the day.** A shard for date *D* is only committed to the repo on *D*. Not
encrypted-and-shipped — **absent**. This is the single most effective static measure available,
because the strongest possible client-side protection is data the client was never sent. It also
kills clock-forwarding as an attack: set your system date to 2031 and the fetch 404s.

**A3 — Late binding within the day.** Inside a shard, ship each round's `{title, artist, year}`
as a separately-encrypted blob; ship only `{id, cover, previewUrl}` in the clear. Decrypt round
*i* at reveal. A player who inspects the store mid-run sees ciphertext for rounds they have not
reached.

**A4 — Encrypt the in-flight day.** AES-GCM over the round blobs, key derived from a daily key
file. This buys defence-in-depth for the publication window (§4.3), CDN-cache races, and anyone
scraping the repo tree rather than playing. It does **not** hide the current round's answer from
someone who is running the code — see §1.2.

**A5 — Tamper-evident records.** HMAC the finished attempt with a key derived from the day key.
Detects hand-edited `localStorage` and forged share text. Evidence, not prevention: the key is on
the client, so a determined forger recomputes the tag.

**A6 — Plausibility signals.** Already present (`isSuspect`, per-round `thinkMs`). Keep, extend
to sub-perceptual placements and impossible clip-to-placement latency. Flag, never discard.

### 1.2 What Option A cannot do, and why

Two properties make client-side answer-hiding a cost increase rather than a control:

- **The attacker is the client.** Any key the page can use to decrypt today's answers is a key the
  attacker already possesses, by definition. A breakpoint on the decrypt call, or a three-line
  monkey-patch of `crypto.subtle.decrypt`, yields plaintext regardless of how the key was derived.
- **Hashing does not hide low-entropy values.** A commitment scheme — ship `H(salt‖trackId‖year)`,
  verify the player's guess against it — sounds like it hides the year. It does not. There are
  ~130 plausible years. Brute-forcing all of them takes microseconds, and the salt is shipped too.
  **Do not build this**; it is exactly the kind of measure that reads as security and is not.

So Option A's honest security level:

| Adversary | Result |
|---|---|
| Curious player opening devtools / React DevTools | **Blocked.** Sees opaque blobs, no pool, no generator. |
| Player reading the network tab | **Blocked** for the round they haven't reached; open for the current one. |
| Anyone scraping the site or repo for future days | **Blocked**, permanently — the data does not exist yet. |
| Determined reverse engineer, today's puzzle | **Open.** ~15–30 minutes with a debugger. Unfixable statically. |
| Score / attempt forgery | **Detectable, not preventable.** |
| Automated solver bot | **Open.** |

That is a real and worthwhile improvement, provided nobody mistakes it for integrity.

---

## 2. Option B — the minimal serverless upgrade

The technical limit in one line: **you cannot verify a computation on a machine your adversary
controls.** Integrity requires that the answer and the scoring both live somewhere the player
cannot read or patch. That is the entire reason to add a server, and it is the only reason.

Minimum viable footprint — GitHub Pages stays the frontend, unchanged:

- **One Cloudflare Worker** (free tier: 100k requests/day, no cold-start cost, no egress bill),
  on `api.hitstime.<domain>`, CORS locked to the Pages origin.
- **Workers KV** for the leaderboard and per-day attempt records. Free tier is ample at this scale.
- Shared code: `src/engine/daily.ts` and the pool import into the Worker unchanged — it is already
  pure and `crypto.subtle`-based, so it runs identically on the edge. That was a good decision and
  it pays off here.

Three routes:

```
POST /daily/:date/start   -> { rounds: [{ id, cover, previewUrl }], token }   // no years
POST /daily/:date/round   -> { correct, correctIndex, year, title, artist }   // one round
POST /daily/:date/finish  -> { errors, adjustedMs, rank }                     // server-computed
```

`token` is a short-lived HMAC (or JWT) carrying `date`, a server-side `iat`, and a run id.
Rounds must arrive in order, each presenting the token; the server replays the log against its own
canonical solution and computes the score itself. **Nothing self-reported is trusted** — not the
score, not the elapsed time, not the round outcomes.

Cost: $0 at any plausible traffic level. Ops burden: one `wrangler deploy` in CI, one secret.

Alternatives considered: Vercel/Netlify functions are equivalent but add a second hosting account
and colder starts; Supabase brings a database and an auth system this game does not need.
Cloudflare Workers is the smallest thing that closes the hole.

---

## 3. Recommendation

**Ship Option A now. Build Option B when — and only when — a public leaderboard ships.**

Rationale: A2 (publish-on-the-day) closes the only *irreversible* leak, costs one scheduled
Action, and needs no infrastructure. A1+A3+A4 make casual cheating uninteresting, which is the
case that actually occurs. B is not justified while every score is private to one browser.

Two commitments that make this a plan rather than a deferral:

- **Do not ship a public leaderboard, ranked share codes, or any cross-player comparison until B
  exists.** An unvalidated leaderboard is a ranking of who edits `localStorage` most creatively,
  and it cannot be retrofitted — the fraudulent entries are already in it.
- **Keep the engine pure and server-runnable.** No DOM, no `Date.now()` inside generation, no
  browser-only crypto assumptions. It already satisfies this; a test should enforce it.

---

## 4. Phase 1 — implementation plan

### 4.1 Move generation to build time — **implemented**

`build/dailyShards.ts` is a Vite plugin, not a standalone script: the generator is TypeScript with
extensionless imports, which Node cannot execute without a loader, and Vite resolves it natively.
It calls the **existing** `challengeFor(date, pool)` — same function, same frozen pool, only the
location changed — for every date `publishableDates()` allows.

- **Build**: `generateBundle` emits each shard via `this.emitFile`, so nothing is written into the
  working tree. A stale `tomorrow.json` left behind by an earlier build therefore cannot exist,
  which would otherwise be exactly the leak this closes.
- **Dev**: `configureServer` serves `/daily/<date>.json` from memory, re-evaluating the window per
  request, so a machine left running past midnight picks up the new day without a restart.

The client-side generation path is gone: `loadPool` / `loadPoolForDate` were deleted, and no module
reachable from `main.tsx` imports a pool. Verified against the built bundle — the 79 KB
`pool-v1-*.js` chunk is absent, no track title or year appears anywhere in `dist/assets/`, and
rollup tree-shook `selectCycle` / `cycleSeed` out too.

The pool files stay in the repo as the build-time source of truth. A *replay* test was considered
and rejected as tautological — it would compare `challengeFor` against itself. The invariant worth
protecting is that the generator's output never changes for a given date, and
`src/engine/daily.golden.json` already pins that.

**Prerequisite bug fixed along the way.** `dateForDayIndex` read its result back with
`localDateISO`, i.e. the *local* date of a UTC-midnight instant — the day before, everywhere west
of Greenwich. Day 1 came back as the day before `EPOCH`, which `dayIndexFor` then scored as 0:
outside the archive. The whole calendar was off by one for half the planet, and the existing
round-trip test passed only because CI runs at a positive UTC offset. Now formatted in UTC, with a
timezone-independent regression test (`TZ=America/New_York npm test` failed 6 tests before, passes
now).

### 4.2 Shard format — *steps 3–6, not yet implemented*

```jsonc
{
  "v": 1,
  "date": "2026-09-13",
  "dayIndex": 1,
  "poolVersion": 1,
  "algoVersion": 1,
  "seedHex": "…",                       // unchanged integrity tag
  "anchor": { "id": "…", "title": "…", "artist": "…", "year": 1986, "cover": "…" },
  "rounds": [
    { "id": "…", "cover": "…", "iv": "base64", "ct": "base64" },  // ct = {title,artist,year}
    …
  ]
}
```

The anchor stays in the clear — it is dealt face-up. Each round blob is encrypted **individually**
with its own IV so that decrypting round 3 reveals nothing about round 7. Round key:

```
dayKey  = HKDF-SHA256(keyMaterial, salt = date, info = "hitstime/daily/v1")
roundKey_i = HKDF-SHA256(dayKey,   salt = date, info = "round/" + i)
```

`keyMaterial` comes from the daily key file (§4.3). All of this is `crypto.subtle` — no new
dependency.

### 4.3 The daily drop, and its honest limit — **implemented (without the key file)**

No commits and no key file yet: `deploy.yml` gained a `schedule`, and each run rebuilds and
redeploys. Because the whole archive is regenerated every build, a missed run can never leave a
hole — the next build of any kind fills it — and no bot commits land in the repo.

The window opens at **10:00 UTC**, the moment UTC+14 enters its next day. Crons run at 10:02 and
again at 12:02 as catch-up. A UTC+14 player opening the app inside those first couple of minutes
sees "not open yet", which is the correct side to err on.

Two operational caveats: GitHub disables scheduled workflows after 60 days without commits (the
site would silently freeze on its last-built day), and a failing `npm test` blocks the daily
publish — deliberately, since stale beats wrong.

Steps 3–6 below (encryption, the key file, the rolling buffer) remain proposals; without them the
published day is plaintext, which is the accepted position of §1.2: today's answers are always
obtainable.

#### The original plan, for when steps 3–6 land

**The timezone problem, stated plainly.** `localDateISO()` gives every player their *local* date.
The earliest local midnight on Earth (UTC+14) arrives 14 hours before UTC midnight, and the latest
(UTC−12) arrives 12 hours after. Any static file that must be readable by the first player is
readable by everyone at that moment. Therefore:

> **A day's shard is necessarily public for up to ~26 hours before the last player's day begins.**
> Publish-on-the-day seals the *far* future absolutely. It cannot seal *tomorrow*.

This is a property of static hosting plus local-date boundaries, not a bug to be engineered away.
Options, in preference order:

- **Accept it** (recommended). Knowing tomorrow's puzzle a few hours early is low-value and
  requires deliberate effort. Publish at 09:30 UTC for the next local day.
- Switch the daily boundary to a fixed UTC cutover. Narrows the window to zero, but changes the
  product — see `daily-challenge-architecture.md` §3 for why local dates were chosen.
- Option B, where the server refuses to deal a date before the requester's day has begun.

Key file naming: `public/daily/keys/<HMAC-SHA256(DAILY_SECRET, date)>.json`, the same digest
supplying `dateKey` in §4.2. An unpublished day's filename is unguessable without the secret, so
even a leaked *ciphertext* shard has no reachable key. `DAILY_SECRET` lives in GitHub Actions
secrets, never in the repo, never in `.env` — and critically, is **never** referenced from a
workflow with a `pull_request` or `pull_request_target` trigger, where a fork could exfiltrate it.

If `DAILY_SECRET` ever leaks, every future shard becomes decryptable-on-publication. Rotation: bump
a version prefix in the HMAC input and re-encrypt only unpublished shards; past days are already
public and need nothing.

### 4.4 Keep the plaintext out of the heap

Today `game.mystery` carries `year` from the deal. Change the daily path so the store holds the
ciphertext blob, and the reveal reducer decrypts round *i* at the moment the player confirms a
placement. Correctness is then evaluated against a value that did not exist in memory a frame
earlier. The free-play modes (live Deezer data) are unaffected.

### 4.5 Tamper-evident attempts

Extend `DailyAttempt` with `tag: HMAC(dayKey, canonicalJSON(attempt))`, written by `saveAttempt`
and verified on read. A failed tag marks the attempt `suspect: true` rather than deleting it — a
local record is the player's own property. Share text embeds the day index and the tag prefix, so a
forged share is at least checkable by anyone with the day key.

### 4.6 Hardening unrelated to answers

- **CSP** in `index.html` (`default-src 'self'; script-src 'self' https://api.deezer.com; style-src
  'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' https://cdn-images.dzcdn.net
  data:; connect-src 'self'; media-src https://cdn-preview-*.dzcdn.net; frame-ancestors 'none'`).
  Verify against the real request set before enforcing.
- **SRI** on the Google Fonts stylesheet link, or self-host the font and drop the third party.
- **JSONP**: the CSP above still permits Deezer to run arbitrary JS in the app origin, because
  JSONP requires exactly that. There is no static fix — Deezer's public API sends no CORS headers,
  which is why JSONP is there. Proxying it through the Option B Worker removes the last
  arbitrary-script-execution vector *and* centralises the rate limit. Note it as a second, independent
  argument for B.
- `.env` is gitignored; confirm `DISCOGS_TOKEN` was rotated after commit `773e6fd` moved it out of
  the source, since the old value is still in git history.

### 4.7 Order of work

1. `build-daily-shard.mjs` + CI replay test (no behaviour change yet).
2. Client reads shards; delete the client generation path and the pool chunk.
3. Per-round encryption + late decrypt (§4.2, §4.4).
4. Scheduled publish Action + key drop (§4.3).
5. Attempt HMAC (§4.5).
6. CSP / SRI (§4.6).

Steps 1–2 alone remove the critical row from §0.

---

## 5. Phase 2 — adversarial review

Wearing the attacker's hat against the Option A design as specified above.

### 5.1 Breakpoint on the decrypt call — **works, unfixable**

Pause in `revealRound`, read the decrypted object. Or in the console:
`const d = crypto.subtle.decrypt; crypto.subtle.decrypt = async (...a) => { const r = await d.apply(crypto.subtle, a); console.log(new TextDecoder().decode(r)); return r; }`.

*Mitigation:* none that survives contact. Minification and control-flow obfuscation raise the cost
to perhaps 30 minutes for the first person, and to zero for everyone after they publish a
bookmarklet. **Do not spend effort here.** §4.4's late decryption at least means this only yields
the *current* round, not the run.
*Residual:* accepted. Closed only by Option B.

### 5.2 Pre-decrypting the whole day at deal time — **works today**

The attacker holds `dayKey`, so per-round key separation (§4.2) buys nothing against someone who
derives all ten round keys and decrypts the shard in one go.

*Mitigation:* honest answer — round separation defends against *passive* inspection (store dumps,
network tab, a hooked decrypt at T0), not against active key derivation. Making it real requires a
ratchet whose next step is only obtainable from the server; that is Option B.
*Residual:* accepted for the current day.

### 5.3 Fetching future shards — **blocked**

`GET /daily/2031-04-01.json` → 404. The file does not exist. Repo history contains nothing either,
since the Action commits day by day.

*New risk introduced:* if the publish Action fails (quota, expired token, broken build), players
get a hard 404 on the day's puzzle. *Mitigation:* the Action publishes a rolling window of the next
**N=7** days' shards — but keeps their key files unpublished until each day. A missed run then
degrades to "key missing for one day", and a manual `workflow_dispatch` fixes it. This is precisely
what §4.4's encryption is for; without it the buffer would publish the answers.
*Residual:* low, with the buffer.

### 5.4 Guessing key-file names — **blocked**

Filenames are `HMAC-SHA256(DAILY_SECRET, date)`. Without the secret this is a 2^256 search. GitHub
Pages does not serve directory listings for the deployed artifact.

*Watch:* do not add a manifest that enumerates key files "for convenience". That would hand back
everything this buys.

### 5.5 Clock manipulation — **blocked, and improved over today**

Setting the system clock forward currently hands the player any future day via `challengeFor`.
After §4.1 it produces a 404. Setting it backward replays an archived day, which is already
public and permitted.

*Residual:* none worth acting on.

### 5.6 Timer farming and the elapsed-time score

Pause the tab, patch `performance.now()`, or return a constant from `dailyElapsedMs`.

*Mitigation:* existing timer design (pause on hidden, cap idle gaps, persist across reload) handles
accidents and casual abuse. Deliberate patching is trivially available.
*Residual:* open. Note that time is the *score*, so this is the highest-value target the moment a
leaderboard exists — a direct argument for gating the leaderboard behind Option B.

### 5.7 Forged attempts and share text

Edit `localStorage`, or recompute the §4.5 tag with the day key.

*Mitigation:* the tag catches hand-edits and non-deterministic tools. It cannot stop a forger with
the key. Server-side the equivalent is trivial and total.
*Residual:* detectable, not preventable.

### 5.8 Automated solver

A script reads each round's `cover` URL (unencrypted by design — it is rendered), queries the
Deezer API for the track, and places perfectly with plausible-looking 2–4 s delays.

*Mitigations, ranked:* (a) serve covers from a per-day opaque path so the URL does not identify the
track — cheap, and it removes the free oracle; (b) strip the track `id` from the pre-reveal
payload for the same reason; (c) `isSuspect` on timing distribution — a bot's inter-round variance
is unnaturally low. All are speed bumps. Real bot defence needs server-side rate and behavioural
analysis.
*Residual:* open. **(a) and (b) are worth doing in Phase 1** — they are near-free and close an
oracle that otherwise makes every other measure pointless.

### 5.9 Store manipulation

`useApp.setState({ game: { ...game, score: 9999 } })`.

*Mitigation:* none client-side. Note only that this bypasses every measure above, which is the
clearest possible demonstration that client-side scoring is advisory.

### 5.10 Replay for a better time

Clear `localStorage`, replay a known day with the answers memorised.

*Mitigation:* none without identity. Server-side: one attempt per run token per date per device
fingerprint, with the honest acknowledgment that fingerprints are defeatable too.

### 5.11 Supply chain — the most under-rated item here

JSONP means api.deezer.com can execute arbitrary JS in the HitsTime origin. A compromise there
reads `localStorage`, rewrites scores, or exfiltrates anything the page holds. Separately, the
Google Fonts stylesheet loads without SRI.

*Mitigation:* SRI or self-host the font now; route Deezer through the Option B Worker later and
tighten `script-src` to `'self'`. This is a genuine security issue independent of cheating, and
the one item in this document that would matter even if nobody ever cheated.

### 5.12 CI secret exposure

`update-dates.yml` passes `DISCOGS_TOKEN` on a `schedule`/`workflow_dispatch` trigger only — correct
as written. The new publish workflow must follow the same rule for `DAILY_SECRET`.

*Mitigation:* never add `pull_request_target` to a workflow that touches these secrets; keep
`permissions:` minimal per job.

---

## 6. Residual risk after Phase 1

Steps 1–2 are done; the rest of the table is the target once steps 3–6 land.

| Threat | Before | After steps 1–2 |
|---|---|---|
| Future archive readable | Entire archive, forever | **Sealed beyond ~D+1** ✅ |
| Whole pool in the bundle | 388 tracks, 79 KB chunk | **Gone** ✅ |
| Clock-forwarding for a future day | Hands over that day | **404** ✅ |
| Casual devtools spoil | Trivial | Blocked |
| Network-tab spoil | Trivial | Current round only |
| Determined RE, today's puzzle | Trivial | ~30 min, then public bookmarklet |
| Cover/id oracle for a bot | Open | Closed (§5.8 a/b) |
| Score / time forgery | Open | Detectable only |
| Replay | Open | Open |
| Third-party script execution | Open | Font fixed; Deezer open until B |

**Trigger for Option B:** the first feature that makes one player's result visible to another —
a public leaderboard, friend comparison, or any ranked share. At that point self-reported numbers
become other people's problem, and §5.6, §5.7, §5.9 and §5.10 all go from "harms only the cheater"
to "harms everyone else". Build the Worker before that feature, not after.
