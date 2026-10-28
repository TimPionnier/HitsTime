# HitsTime 🎵

A Hitster-inspired web game: listen to a mystery song (30 seconds, once) and place it on your
timeline by release year. Each correct placement scores a point — one mistake and the game is over.

## Status — milestones 1–3 of 5 ✅

The **complete game loop is playable in demo mode** (fake songs, real rules), and the **Spotify
integration is implemented**: PKCE login, Premium check (with a friendly fallback message),
your playlists + public playlist search, album-release years, and playback through the Web
Playback SDK (30s cap, no replay, unplayable tracks skipped without ending the run).

| Milestone | Content | Status |
| --- | --- | --- |
| 1 | Playable core on a mock provider | ✅ done |
| 2 | Spotify: PKCE auth, Premium check, playlists, track years | ✅ done |
| 3 | Spotify playback via Web Playback SDK (30s cap, no replay) | ✅ done (needs a real Premium account to live-test) |
| 4 | Deezer fallback (30s previews, no login, public playlists) | ⏳ next |
| 5 | Polish, responsive pass, deploy to GitHub Pages | ⏳ |

## Run it

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # game-engine unit tests (vitest)
npm run build      # type-check + production build in dist/
```

Click **Try the demo** on the home screen. The demo clip is accelerated (6s of wall time
representing the 30s clip) so playtesting is fast — the Spotify/Deezer providers will use the
real 30 seconds.

## Daily Challenge

The same 10 songs for every player, every day, played as the timeline mode — one card at a
time. A wrong placement does **not** end the run: the card is inserted at its *correct*
position, stays red for the rest of the game, and costs **+30 s**. Every run therefore reaches
round 10, so results are comparable. Score = thinking time + 30 s per mistake, lowest wins.

A challenge is a pure function of the date — nothing is pre-generated and nothing is stored, so
every day back to day 1 is playable from the archive. Determinism is enforced by:

- a **frozen pool snapshot** (`src/daily/pools/pool-vN.json`), not the live playlist and not
  `date-overrides.json`, which the weekly workflow rewrites;
- a date-seeded SHA-256 → sfc32 draw, never `Math.random`;
- a **golden-fixture test** asserting the exact *ordered* track ids for 20 known dates.

Dates come from `date-overrides.json` (Discogs, via `scripts/build-date-overrides.mjs`) first,
then Deezer. Run the override script before building a pool — without it, 50s/60s tracks that
only exist on compilations get the compilation's year and land in the wrong decade. Discogs
matching is heuristic, so **check the pre-1970 entries by hand** after a run; the script never
overwrites an existing entry, so manual corrections stick.

### Adding songs to the daily pool

Never edit a pool file that has shipped — every past challenge generated from it would change,
and archived results would be graded against puzzles nobody played. Build the next version:

```bash
node scripts/build-daily-pool.mjs 2      # refuses to overwrite an existing version
```

Then register it in `src/daily/pools/registry.ts` with an `activeFrom` date **a few days out**,
so every client has the new bundle before it takes effect — a player on a stale cache would
otherwise generate the day from the old pool and silently get a different puzzle:

```ts
export const POOL_REGISTRY: PoolEpoch[] = [
  { version: 1, activeFrom: '2026-09-01' },
  { version: 2, activeFrom: '2026-09-20' },   // +90 songs
];
```

`npm test` then proves the archive did not move: regenerate the golden fixture
(`npx vite-node scripts/build-daily-golden.mjs`, which draws every date from the pool the registry routes
it to) and check that only dates on or after the new `activeFrom` changed in its diff.
`leaves already-played days on their original pool` asserts every pre-v2 date still routes
to v1. Nothing else is needed — the registry is append-only and past epochs are never touched.

`EPOCH` in `src/engine/daily.ts` is day 1 of the archive — **set it before launch and never
change it**; every puzzle number is measured from there.

Design notes and the adversarial review: [docs/daily-challenge-architecture.md](docs/daily-challenge-architecture.md).

## Analytics (optional, off by default)

Per-mode play counts, a distinct-visitor estimate, and an average score, with a percentile shown
to the player instead of a high score — no cookies, no identifier stored on the device, no
consent banner. Deliberately **no global best score**: nothing verifies a submitted score yet,
so a best would belong to whoever forged it. See
[docs/analytics-architecture.md](docs/analytics-architecture.md) §1.3.

The counting runs in a small Cloudflare Worker ([worker/](worker/)); GitHub Pages is unchanged.
Everything is inert unless the site is built with an endpoint:

```bash
VITE_ANALYTICS_URL=https://hitstime-analytics.<subdomain>.workers.dev npm run build
```

Without it the client sends nothing and the stats UI renders nothing. Deploy steps:
[worker/README.md](worker/README.md).

## How to play

1. One card is dealt face-up on your timeline.
2. Press play — you hear the mystery song **once**, no replay.
3. Hover a gap in the timeline; click the **+** slot to place the card (you can still move it).
4. Click the placed card again (or the Validate button) to confirm.
5. Right gap → +1 point, next song. Wrong gap → game over. Equal years are correct on either side.
6. Empty the whole playlist to clear it. 🏆

Years come from the release date of the **album** each track appears on, as reported by the music
service — remasters and compilations can carry a later year than the original recording. The ⓘ
icon in the game explains this to the player.

## Architecture

```
src/
  engine/       pure TS game logic (state machine, placement rules, daily generation)
                — unit-tested, no React
  daily/pools/  immutable pool snapshots + the version registry
  providers/    MusicProvider interface + mock & Spotify providers (Deezer lands in M4)
  store/        Zustand app store orchestrating engine + provider + screens
  services/     localStorage leaderboard, EN/FR i18n
  screens/      Connect · PlaylistPicker · Game · End
  components/   Timeline, cards, gap slots, playback bar, leaderboard, tooltips
```

Stack: React 18 + TypeScript + Vite, Tailwind CSS v4, Zustand, Motion. Static build — deployable
to GitHub Pages as-is (`.github/workflows/deploy.yml` builds, tests and publishes `dist/` on every
push to `main`; enable **Settings → Pages → Source: GitHub Actions** in the repo).

## Spotify setup

1. Create an app on <https://developer.spotify.com/dashboard> (a free account works). ✅ done —
   the client ID is baked into `src/providers/spotify/config.ts` (it's a public identifier; PKCE
   uses no secret). Override with `VITE_SPOTIFY_CLIENT_ID` in a `.env` file if needed.
2. In the app settings, add these **redirect URIs** — the app's root URL doubles as the callback
   (no `/callback` path: a static host like GitHub Pages would 404 on it):
   - dev: `http://127.0.0.1:5173/` (Spotify no longer accepts `localhost`)
   - prod: `https://<user>.github.io/<repo>/`
3. In the dashboard, enable the **Web API** and **Web Playback SDK** for the app.
4. While the app is in development mode, only up to 25 allowlisted Spotify users can log in —
   add each tester's Spotify account email under **User Management** (yours included).

Playing with Spotify will require **Spotify Premium** (Web Playback SDK constraint); the Deezer
mode (milestone 4) is the no-subscription fallback using 30s preview MP3s.
