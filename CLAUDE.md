# CLAUDE.md — project context for AI assistants

Hitster-inspired web game. Player listens to a 30s clip once, places it on a
timeline by release year. Daily Challenge mode: same 10 songs for all players
each day, scored by time + 30s per mistake.

**Stack:** React 18 + TypeScript + Vite, Tailwind v4, Zustand, Motion.
Static build → GitHub Pages. Tests: Vitest.

```
npm run dev    # dev server
npm test       # unit tests
npm run build  # type-check + prod build → dist/
npm run lint   # ESLint
npm run format # Prettier (write); `npm run format:check` to verify
```

---

## Key file map

| Path | Purpose |
|------|---------|
| `src/engine/daily.ts` | Pure daily-challenge logic (EPOCH, ALGO_VERSION, CYCLE_DAYS, draw algorithm) |
| `src/daily/pools/pool-v1.json`, `pool-v2.json` | **Immutable** frozen track snapshots (v1: 388 tracks, v2: 424). Each has a `contentHash` guard. |
| `src/daily/pools/registry.ts` | Maps pool versions to `activeFrom` dates. Append-only. |
| `src/engine/daily.test.ts` | contentHash guard + golden-fixture test + pool variety checks |
| `src/engine/daily.golden.json` | Exact track IDs for 20 known dates — must not change unless ALGO_VERSION bumps |
| `src/providers/deezer/date-overrides.json` | Manual/Discogs-corrected release dates. Script never overwrites existing entries. |
| `src/providers/deezer/api.ts` | Deezer API client (playlist ID `15689112801`) |
| `build/dailyShards.ts` | Vite plugin: generates `dist/daily/YYYY-MM-DD.json` at build time |
| `scripts/build-date-overrides.mjs` | Fetches playlist → cross-refs Discogs → writes date-overrides.json |
| `scripts/build-daily-pool.mjs` | Builds a new pool snapshot (refuses to overwrite existing version) |
| `scripts/build-daily-golden.mjs` | Regenerates golden fixture — only run when bumping ALGO_VERSION |
| `worker/` | Cloudflare Worker for optional analytics |

---

## Daily challenge pipeline

```
Deezer playlist (15689112801)
  → scripts/build-date-overrides.mjs + Discogs API
  → src/providers/deezer/date-overrides.json   (append-only, manual fixes stick)
  → scripts/build-daily-pool.mjs
  → src/daily/pools/pool-vN.json               (immutable after creation)
  → build/dailyShards.ts (Vite plugin)
  → dist/daily/YYYY-MM-DD.json                 (one per day, fetched by client)
```

**EPOCH** (`src/engine/daily.ts`): `'2026-09-13'` — day 1, never change.
**Pool v1** active from `2026-09-13`, **pool v2** from `2026-11-01` (see `src/daily/pools/registry.ts`). Each new pool also needs an import in `build/dailyShards.ts` and in `src/engine/daily.test.ts`.

Date resolution priority: `date-overrides.json` → Deezer track date → Deezer album date.

---

## Fixing a wrong song year

Wrong years typically come from Discogs finding a reissue/compilation instead
of the original release.

**Two files to edit:**

1. **`src/providers/deezer/date-overrides.json`** — change the date for the
   track ID. The script will never touch entries that already exist.

2. **`src/daily/pools/pool-vN.json`** — update `year` and `decade`
   (`decade = Math.floor(year / 10) * 10`) for the track.

3. **Recompute `contentHash`** — the pool's hash guards against accidental
   edits; update it after touching any track:

```js
node -e "
const fs = require('fs'), crypto = require('crypto');
const pool = JSON.parse(fs.readFileSync('src/daily/pools/pool-v1.json', 'utf8'));
console.log(crypto.createHash('sha256').update(JSON.stringify(pool.tracks)).digest('hex'));
"
```

Then update `"contentHash"` at the top of the pool file.

**The pool is "immutable by convention", not technically.** Intentional bug
fixes (wrong year metadata) can be applied in place, but they are NOT free:
the draw's difficulty guard (`MIN_INTERIOR`, per-decade cap) reads the years, so a
corrected year can change which songs a day gets. Fixing 7 years on 2026-10-28
changed the draw of 5 of the first 60 days, 3 of them already played
(2026-09-28, 2026-10-19, 2026-10-23). Before committing a year fix, compare the
draws of the old and corrected pool (`challengeFor` over the days already
published) and decide whether changing those past days is acceptable. The golden
fixture follows (`npx vite-node scripts/build-daily-golden.mjs`), and only the
dates whose draw actually changed should differ in its diff.

### Watch out: smart quotes in pool-v1.json

Track `3801343472` ("What Is Love (7" Mix)" by Haddaway) contains a Unicode
right-double-quote `\u201D` (`"`) inside its title string — that is the `"`
in `7"`. The surrounding JSON delimiters are standard ASCII quotes. If an edit
tool converts the structural quotes to curly quotes the file becomes invalid
JSON. Verify with:

```js
node -e "JSON.parse(require('fs').readFileSync('src/daily/pools/pool-v1.json','utf8')); console.log('OK')"
```

---

## Adding songs (new pool version)

Never edit a shipped pool — past challenges would silently change.

```bash
# 1. Update date-overrides first (takes ~7 min, needs DISCOGS_TOKEN in .env)
node scripts/build-date-overrides.mjs

# 2. Build the new pool (refuses to overwrite an existing version)
node scripts/build-daily-pool.mjs 2

# 3. Register it with a future activeFrom (give clients a few days to update)
# In src/daily/pools/registry.ts:
#   { version: 2, activeFrom: '2026-XX-XX' }

# 4. Regenerate the golden fixture (npx vite-node scripts/build-daily-golden.mjs): it draws each
#    date from the pool the registry routes it to, so ONLY dates on or after the new activeFrom
#    may change in its diff. Then run the tests.
npm test
```

---

## Tests to know

| Test | What it catches |
|------|----------------|
| `matches its recorded contentHash` | Any edit to pool track data |
| `is sorted by id and free of duplicates` | Pool integrity |
| `has enough variety` | ≥25 distinct years, ≥8 decades, ≥154 tracks |
| `golden fixture` | PRNG output — fails if ALGO_VERSION changes or pool order changes |
| `leaves already-played days on their original pool` | Registry routing |

---

## Known data quirks

- Haddaway "What Is Love (7" Mix)" — smart quote in title, valid JSON (see above).
- Pre-1970 Discogs matches are often wrong (compilations dominate). **Manually
  verify** any entry older than 1970 after running the override script.
- `date-overrides.json` entries already corrected (as of 2026-09-18):
  `346967941` (Pointer Sisters → 1982), `10284847` (Justice → 2007),
  `100052800` (Maroon 5 → 2014), `15586213` (Springsteen → 1984),
  `82715364` (Adele → 2012), `1109737` (Eminem → 2000),
  `3801343472` (Haddaway → 1993).

---

## CI / deployment (`.github/workflows/`)

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `deploy.yml` | push to `main`, manual, cron `10:02` and `12:02` UTC | `npm ci` → `npm run lint` → `npm test` → `npm run build` → GitHub Pages |
| `update-dates.yml` | Mondays 06:00 UTC, manual | Runs `build-date-overrides.mjs` (needs `DISCOGS_TOKEN` secret) and pushes `date-overrides.json` to `main` if changed |
| `daily-playlist.yml` | cron `10:05` and `12:05` UTC, manual | Builds, then runs `scripts/export-daily-playlist.mjs` to publish the day's Spotify playlist via ListenBrainz (needs `LISTENBRAINZ_TOKEN` secret) |

- **The deploy cron is what publishes each new day.** `src/build/publishWindow.ts` only
  emits shards for dates already reachable somewhere on Earth, so without the scheduled
  run the site stays stuck on the last-deployed day. Do not remove the cron entries.
- GitHub disables scheduled workflows after 60 days without commits. If the site freezes
  on an old day, re-enable the workflow or push a commit.
- `npm run lint`, `npm test` and `tsc -b` (inside `npm run build`) gate every deploy: a lint
  error, failing test or type error blocks publication. Run them locally before pushing to `main`.
- `VITE_ANALYTICS_URL` is a repository **variable** (not a secret) baked into the bundle.
  Unset, analytics is a no-op. Never put real secrets in `VITE_*` variables.
- `update-dates.yml` pushes straight to `main`, which triggers a deploy. Pull before
  starting work to avoid conflicts on `date-overrides.json`.

---

## TypeScript Rules

- `strict: true` is non-negotiable (already set in `tsconfig.app.json`, along with
  `noUnusedLocals` and `noUnusedParameters`). All compiler flags must pass: `npm run build`.
- No `any`. Use `unknown` + type narrowing, or define a proper type.
- No `as` casting unless there is a clear, commented reason.
- No `@ts-ignore` or `@ts-expect-error` without a comment explaining why it's unavoidable.
- Prefer `type` over `interface` unless declaration merging is needed. (Some existing
  files still use `interface`; convert them only when touching them anyway.)
- Use discriminated unions for state machines and variant types.
- All function signatures must be fully typed — no implicit return types on exported functions.

```ts
// OK
export function formatLabel(key: string): string { ... }

// Not OK
export function formatLabel(key) { ... }
```

---

## Code Quality Principles

### Explicit over clever

Write code that a new team member can read and understand without needing to ask. Avoid
"smart" one-liners that compress logic at the cost of readability.

```ts
// OK
const isSelected = focusedIndex === itemIndex;

// Not OK
const isSelected = !(focusedIndex ^ itemIndex);
```

### No emojis

Do not use emojis in production code, comments, console logs, error messages, or scripts.
Keep all code and output professional and text-based. (User-facing game copy is the
exception only if the product owner asks for it.)

### DRY — but not prematurely abstract

Extract a shared abstraction only when the same logic appears in **3+ places** and is
**stable** (unlikely to diverge). Don't abstract speculatively.

### Separation of concerns

- **UI components** (`src/components/`, `src/screens/`) → render and layout only. No
  business logic, no direct API calls.
- **Hooks** → encapsulate stateful logic and side effects. One responsibility per hook.
- **Engine / services / utils** (`src/engine/`, `src/services/`) → pure functions where
  possible, no React imports. Game and daily-challenge rules live in `src/engine/`.
- **Types** → colocate with their feature, or in `src/engine/types.ts` /
  `src/providers/types.ts` when shared.

### No magic numbers or strings

```ts
// OK
const FOCUS_DEBOUNCE_MS = 150;

// Not OK
setTimeout(callback, 150);
```

### Early returns over nested conditionals

```tsx
// OK
if (!isReady) return null;
if (hasError) return <ErrorScreen />;
return <Content />;

// Not OK
if (isReady) {
  if (!hasError) {
    return <Content />;
  }
}
```

---

## Component Guidelines

- Target convention for new components: one component per folder, with the file always
  named `index.tsx` (`src/components/MediaCard/index.tsx`, `src/screens/ProfileScreen/index.tsx`).
  Existing components are flat files (`src/components/Timeline.tsx`); do not mass-rename them,
  migrate a component to a folder only when you are already reworking it.
- Helper components, hooks, or modules next to the main component keep their own
  PascalCase/camelCase names (e.g. `MediaDetail/DetailMetaRow.tsx`, `MediaDetail/variants.ts`).
- Utility/hook files are camelCase: `useDetailPlayer.ts`.
- Props types are colocated and named `[ComponentName]Props`.
- No prop drilling beyond 2 levels — use context, composition, or the Zustand store
  (`src/store/index.ts`).
- Avoid `useEffect` for derived state. Use `useMemo` or compute inline.

```tsx
// src/components/MediaCard/index.tsx
type MediaCardProps = {
  label: string;
  onSelect: () => void;
};

export function MediaCard({ label, onSelect }: MediaCardProps) {
  ...
}
```

---

## Icons — Lucide React

- Use `lucide-react` for all icons. Do not use Unicode symbols, emoji, or other icon libraries.
- `lucide-react` is installed. Existing Unicode/inline-SVG icons are replaced as you touch them.
- Import icons by name: `import { Play, ChevronRight } from "lucide-react"`.
- Always pass explicit `size`, `strokeWidth`, and `className` props — do not rely on defaults.
- Use `aria-hidden="true"` on decorative icons. Provide `aria-label` or a visible label for
  interactive ones.
- Do not wrap icons in an extra `<span>` unless you need a focusable hit target.

```tsx
import { Play } from "lucide-react";

<Play size={24} strokeWidth={1.5} className="text-white" aria-hidden="true" />;
```

---

## Styling — Tailwind CSS (v4)

- Tailwind v4 is configured through CSS (`src/index.css`), not `tailwind.config.js`. Add
  design tokens there (`@theme`).
- No inline `style={{}}` unless driven by dynamic runtime values (e.g. translate from JS state).
- No arbitrary Tailwind values unless there is no design token equivalent and the value is
  documented.
- Use `cn()` from `src/lib/cn.ts` (clsx + tailwind-merge) for conditional class composition,
  rather than concatenating template strings.

```tsx
<div className={cn("rounded-xl bg-surface p-4", isFocused && "ring-2 ring-primary")} />
```

---

## Animation — Motion

The project uses the `motion` package (`import { motion } from "motion/react"`), the
successor of Framer Motion. The same API and rules apply.

- Wrap animated sequences in named `variants` objects — not inline objects passed to `animate`.
- Keep animation durations under `300ms` for UI feedback, under `600ms` for scene transitions.
- Always define `initial`, `animate`, and `exit` for mounted/unmounted elements.
- Respect `prefers-reduced-motion`:

```ts
const shouldAnimate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
```

---

## Formatting & Linting

All code must pass without warnings: `npm run lint` and `npm run format:check`.

- ESLint config: `eslint.config.js` (typescript-eslint, react-hooks, `no-explicit-any` as
  error, unused vars allowed with a `_` prefix). CI runs it.
- The existing codebase was written with single quotes, so `format:check` currently reports
  many files and is **not** run in CI. Format only the files you touch
  (`npx prettier --write <files>`); do not reformat the whole repo in an unrelated change.
- Known leftovers: three `react-hooks/set-state-in-effect` warnings (timer/flash effects in
  `Daily.tsx` and similar) and one `exhaustive-deps` warning in `DailyEnd.tsx`. Fix them when
  touching those files.
- `src/daily/pools/` and `date-overrides.json` are in `.prettierignore`: never reformat them.

### Prettier (`.prettierrc`)

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "arrowParens": "always"
}
```

---

## Testing

Vitest (`npm test` runs once, `npm run test:watch` for watch mode). CI runs the full suite
before every deploy.

### Philosophy

- Test **behavior**, not implementation.
- Unit test pure functions and hooks in isolation.
- Integration test component trees that include user interaction.
- Do not test Tailwind classes or animation variants.

### Structure

Tests are colocated with the code they cover (as in `src/engine/game.test.ts`):

```
src/
  engine/
    game.ts
    game.test.ts
  components/
    MediaCard/
      index.tsx
      index.test.tsx
  hooks/
    useDetailPlayer.ts
    useDetailPlayer.test.ts
```

### Coverage expectations

- All pure utility functions (`src/engine/`, `src/services/`): 100% coverage.
- All hooks with side effects: test the key paths.
- Components: test user-facing behavior (event handling, conditional rendering).
- Do not chase 100% coverage on presentational components.
- Never update `daily.golden.json` or the pool `contentHash` just to make a test pass —
  see the daily challenge sections above.

---

## Performance

- Memoize expensive computations with `useMemo`. Memoize stable callbacks passed to children
  with `useCallback`.
- Use `React.memo` on leaf components that receive stable props and re-render frequently.
- Avoid `useEffect` chains. If multiple effects react to the same state, reconsider the data flow.
- Lazy-load screens with `React.lazy` + `Suspense`.
- Profile before optimizing. Do not add `memo` or `useCallback` speculatively.

---

## Engineering Calibration

> Not under-engineered (fragile, hacky). Not over-engineered (premature abstraction,
> unnecessary complexity).

When in doubt, ask:

1. **Is this solving a real problem I have today?** If no -> don't build it.
2. **Will the next developer understand this in 5 minutes?** If no -> simplify.
3. **Am I introducing abstraction because it's needed, or because it feels "clean"?** If the
   latter -> stop.

Claude should not assume priorities on timeline or scale. When a tradeoff exists between
delivery speed and code quality, **surface the tradeoff explicitly** rather than silently
picking one.

---

## What Claude Should Always Do

- Read this file before generating any code.
- Ask clarifying questions before implementing something ambiguous.
- Write tests alongside implementation, not as an afterthought.
- Run `npm run lint`, `npm test` and `npm run build` (type-check) before declaring work done.
- Comment _why_, not _what_ — and keep it to one or two lines. Comment _only when
  necessary_. Do not paraphrase code. If the reasoning needs a paragraph, that's a sign the
  code itself (or a linked reference) should carry more of the weight.
- **Straightforward code gets no comment at all.** If a reader can tell what a line does by
  reading it, do not restate it above. This applies to declarations, props, and type members
  just as much as to statements: a comment that only re-words the identifier's name
  (`// The in-flight resolve` above `resolveAbort`, `// Cancels the resolve` above `onCancel`)
  is noise and must be deleted. Comment only what the code cannot say — a non-obvious
  constraint, a race, an upstream quirk, a rejected alternative.
- Surface tradeoffs — don't silently make architectural decisions.

---

## Daily playlist (Spotify, via ListenBrainz)

Every day a new public Spotify playlist, "HitsTime Daily Challenge #N", holds the 11 songs of
the latest shard (anchor first, then the 10 rounds). `scripts/export-daily-playlist.mjs`
runs from `daily-playlist.yml`.

- **Why ListenBrainz:** Spotify gives no API key and Deezer no longer issues API apps.
  ListenBrainz holds the OAuth link to the Spotify account and exposes an export endpoint
  (`/1/playlist/<mbid>/export/spotify`) that needs only a user token. Each export creates a
  NEW Spotify playlist, which is why there is one per day.
- **Secret:** `LISTENBRAINZ_TOKEN` (token of the dedicated ListenBrainz account, from
  listenbrainz.org/settings). That account must have the dedicated Spotify account linked in
  its settings, with playlist permissions.
- **Track matching:** Deezer id -> ISRC (Deezer public API) -> candidate recording MBIDs
  (MusicBrainz, about 1 request per second, hence ~30 s per run) -> the first candidate that
  ListenBrainz's Spotify lookup (`labs.api.listenbrainz.org/spotify-id-from-mbid`) knows.
  Spotify only receives tracks with such a mapping. When the ISRC route finds none, a
  MusicBrainz name search (100 results) is tried, accepting only a same-title, same-artist
  recording whose length is within 45 s of Deezer's and that is not marked live, remix, mix,
  cover and so on. If that fails too, up to 300 results are scanned for ANY version of the same
  song and artist (live, other length), studio-like ones first: the owner prefers a complete
  playlist with a few approximate versions over a short one. Check the "Matched (other
  version)" log lines to see which days got an approximation. Songs with no linked recording
  at all are skipped with a warning; the job only fails if none matches.
  The Spotify lookup is only trustworthy for ONE recording per request: batched, its answer
  omits, repeats or mislabels rows, and a false "linked" makes the exporter silently drop
  the track (seen on challenge #47: 11 sent, 10 on Spotify). The script therefore checks
  candidates one at a time (at most 40 per song). `node scripts/export-daily-playlist.mjs
  --dry-run [date]` shows the coverage without creating anything.
- **Which Spotify track:** the exporter uses the FIRST Spotify track ListenBrainz lists for a
  recording, and that is often a compilation or re-recording (seen on challenge #48: "House of
  the Rising Sun" released 2013, "Hot Stuff" 91 s too long). Only Spotify knows the release, so
  for each linked candidate the script reads that first track's year and length from its public
  embed page (`open.spotify.com/embed/track/<id>`, an unofficial page: if its layout changes
  the read returns null and the order ListenBrainz gives is used again). A candidate is
  "faithful" when the Spotify year is within 1 of the game's year and the length within 15 s
  of Deezer's; the first faithful one wins, otherwise the closest one seen, and the log says
  "APPROXIMATE Spotify track". Some songs have no good candidate at all.
- **Order:** tracks are sorted oldest first by the `year` of the daily shard (the validated
  year used by the game, from the frozen pool), never by MusicBrainz or Deezer dates. Ties
  keep play order. This makes the playlist the answer key of the day's puzzle.
- **Link on the end screen:** the playlist address only exists after the site is deployed,
  so it cannot be baked into the build. The workflow writes `playlists.json`
  (`{ "<challenge number>": { date, url } }`) on the `data` branch (not `main`: no redeploy);
  `src/services/playlistLink.ts` fetches it from raw.githubusercontent.com and
  `DailyEnd` shows a "Playlist sur Spotify" button when the day has an entry. Only
  `https://open.spotify.com/playlist/` addresses are accepted. `VITE_PLAYLISTS_URL`
  points a local run at another file. If a day's link is missing, the playlist was created
  but its entry was not written: add it to `playlists.json` by hand.
- **Idempotency:** the script first creates a ListenBrainz playlist titled "#N" and exports
  that copy; if one already exists the day is skipped, so the 12:05 catch-up run never
  duplicates. A failed export deletes the copy so the next run retries.
- **Fragile bits:** ListenBrainz's exporter reads `track["extension"]` unconditionally, so
  every JSPF track carries an empty extension; `/playlist/create` takes
  `{"playlist": {...}}` while `/playlist/export-jspf/*` takes the bare playlist. Both are
  undocumented. If the job breaks, read `listenbrainz/webserver/views/playlist_api.py` in
  metabrainz/listenbrainz-server.
- **Timing, decided by the owner:** the playlist goes out together with the challenge (about
  10:05 UTC, a few minutes after deploy.yml opens the new day). Because it is sorted by year,
  it is the answer key of the puzzle from that moment; this spoiler is accepted. Do not move
  publication later or shuffle the order without asking.
- Spotify playlists are never deleted by the job; prune the dedicated account by hand if the
  list gets unwieldy.
