# hitstime-analytics

The counting half of the game. GitHub Pages stays exactly as it is; this is a
separate deploy target on its own origin.

What it does: counts plays, distinct visitors, and a score distribution per game
mode. What it deliberately does **not** do: publish a best score. Nothing here
verifies a score, so a best would be whatever the most creative player
submitted, permanently — see [../docs/analytics-architecture.md](../docs/analytics-architecture.md) §1.3.
The client renders a percentile off the histogram instead.

Nothing in the game breaks if this is never deployed. With no
`VITE_ANALYTICS_URL` at build time, `src/services/analytics.ts` is a no-op.

## Deploy

```bash
cd worker
npx wrangler d1 create hitstime-analytics       # paste the id into wrangler.toml
npx wrangler d1 execute hitstime-analytics --remote --file schema.sql
npx wrangler secret put TICKET_KEY              # long random string
npx wrangler secret put SALT_KEY                # long random string, rotate quarterly
npx wrangler deploy
```

Then set `ALLOWED_ORIGINS` in `wrangler.toml` to the real Pages origin, and
build the game with the Worker's URL:

```bash
VITE_ANALYTICS_URL=https://hitstime-analytics.<subdomain>.workers.dev npm run build
```

In GitHub Actions, add it as a repository **variable** (not a secret — it ends
up in the bundle either way, and pretending otherwise invites someone to put a
real secret there) and pass it to the build step.

## Rate limiting belongs in front of this

The Worker caps starts per visitor per day, which stops a slow drip. It cannot
stop a flood cheaply, because a request that reaches the Worker has already cost
a request from the daily allowance. Add a Cloudflare **rate-limiting rule** on
`/v1/*` — blocked requests are rejected at the edge and cost nothing.

The realistic threat here is not data theft. It is someone burning the day's
quota at 09:00 so no real player is counted. That is why the read path is
edge-cached and the game falls back to a static snapshot: metric writes and
gameplay reads fail independently.

## Secrets

| Name | Purpose | If it leaks |
|---|---|---|
| `TICKET_KEY` | signs run tickets | forged tickets; rotate, and the per-visitor caps still hold |
| `SALT_KEY` | root of the per-day visitor salt | historical visitor hashes become linkable to an IP+UA guess; rotate |

Neither is ever logged, and neither reaches the browser. The raw IP is used
inside one function to compute a hash and is never stored — that property is
what lets the game run with no cookie banner, so do not add request logging
that captures it.

## Tests

Run from the repository root with the game's suite:

```bash
npm test
```

`fakeDb.ts` is an in-memory stand-in for the D1 binding, not a SQL engine: it
recognises the statements `index.ts` actually issues and throws on anything
else. A rewritten query fails loudly there rather than passing silently.
