# UFC Live Dashboard

A React dashboard for following a UFC event in one place. It combines bout
status, round-by-round scoring, recent fighter form, sportsbook and prediction
market odds, and media scorecards.

The app currently runs entirely from local fixture data, so no API keys or
external services are required.

## Run the app

Requirements:

- Node.js 24 or newer
- npm

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) to view the dashboard.
Vite automatically reloads the page when source files change. Stop the server
with `Ctrl-C`.

### Run the collector

Start the local collector in its default deterministic fixture mode:

```bash
npm run collector
```

It listens on `http://127.0.0.1:8600` and exposes:

- `GET /api/bootstrap` — the last normalized dashboard snapshot and health
- `GET /api/health` — source health and freshness
- `GET /api/events` — the SSE stream

Fixture mode reads only repository fixtures and makes no external network
calls. Collector state and the SSE replay log are written under `./data`,
which is intentionally ignored by Git.

To work on the live-fight UI with deterministic fake data, open the app with
`?demo=live` (for example `http://localhost:5173/?demo=live`). It promotes the
fixture's main bout to an in-round state while leaving the rest of the card
upcoming, so selecting another bout exercises the same Tale/Odds-only preview
used before that bout starts.

Configuration is supplied through server environment variables:

| Setting | Default |
| --- | --- |
| `DATA_MODE` (`fixture` or `live`) | `fixture` |
| `X_MODE` (`disabled`, `embed`, `manual`, or `api`) | `embed` |
| `COLLECTOR_PORT` | `8600` |
| `PERSISTENCE_PATH` | `./data` |
| `PRE_EVENT_POLL_ENABLED` | `true` in live mode, `false` in fixture mode |
| `PRE_EVENT_POLL_NON_EVENT_DAY_MS` | `43200000` (12 hours) |
| `PRE_EVENT_POLL_EVENT_DAY_MS` | `3600000` (1 hour) |
| `PRE_EVENT_POLL_RETRY_MS` | `900000` (15 minutes) |
| `ODDS_API_IO_BOOKMAKERS` | `Bet365,DraftKings` |
| `X_SPEND_CAP_USD` | `0` |
| `SHERDOG_PERMISSION_SCOPE` | `none` |
| `SHERDOG_REQUEST_INTERVAL_MS` | `300000` |
| `SHERDOG_BASE_URL` | `https://www.sherdog.com` |

Staleness settings use `STALE_LIFECYCLE_MS`, `STALE_STATS_MS`,
`STALE_MARKETS_MS`, and `STALE_COMMENTARY_MS`. Polling settings use
`POLL_ESPN_MS`, `POLL_CITO_MS`, `POLL_ODDS_API_IO_MS`,
`POLL_THE_ODDS_API_MS`, `POLL_KALSHI_MS`, and `POLL_POLYMARKET_MS`.

The resident collector owns the pre-event market schedule for Kalshi,
Polymarket, Odds-API.io, and The Odds API: twice daily on non-event days and
hourly on an event's scheduled calendar day. It persists successful poll times
to deduplicate restarts, suspends while a bout is active, and uses the retry
delay above for transient failures. Set `PRE_EVENT_POLL_ENABLED=false` when a
separate one-shot scheduler is the intended owner.

Live credentials are server-only: `CITO_API_KEY`, `ODDS_API_IO_KEY`,
`THE_ODDS_API_KEY`, `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PATH`, and
`X_BEARER_TOKEN`. Live startup fails when required credentials are missing;
`X_BEARER_TOKEN` is required only when `X_MODE=api`.

Sherdog live reads require both a permitting `SHERDOG_PERMISSION_SCOPE`
(`live-blog-read`, `sherdog-read`, or `all`) and actual permission from
Sherdog. The transport remains fail-closed without both.

Every source behavior that only a real card can confirm is tracked in
[`LIVE_CARD_VALIDATION.md`](LIVE_CARD_VALIDATION.md). A green test suite proves
the collector handles the payload shapes we believe the sources emit; it proves
nothing about whether they emit them.

#### Lifecycle driver

`server/lifecycleDriver.ts` is the poll loop that feeds per-bout
observations into the fight lifecycle state machine (`server/lifecycle.ts`),
which in turn drives every downstream round job (round stats, Sherdog, X,
The Odds API, Odds-API.io). It is constructed on every collector startup and
stopped on `close()`, but it is **not started automatically in fixture
mode** — set `LIFECYCLE_DRIVER_ENABLED=true` to turn it on for a manual
fixture-mode demo run. It defaults to on automatically once `DATA_MODE=live`.

This default exists because the bundled fixture event already has a bout
"between rounds" (`bout-main`, round 2, clock `0:00`); a poll loop that's on
by default would, on its second poll, detect that static clock-zero state as
a fresh round boundary and fire `PROVISIONAL_ROUND_ENDED` — which collides
with `server/replay.ts`'s own hand-choreographed lifecycle walkthrough (used
by its tests and by `npm run replay`) and with tests that emit lifecycle
events directly on the event bus. Gating the driver keeps both paths
deterministic: `npm run replay` remains the fixture demonstration of the
full round-by-round pipeline, while `LIFECYCLE_DRIVER_ENABLED=true npm run
collector` demonstrates the poll-driven path against the same static
fixture.

Other lifecycle driver settings:

| Setting | Default |
| --- | --- |
| `LIFECYCLE_DRIVER_ENABLED` | `true` in live mode, `false` in fixture mode |
| `LIFECYCLE_ESPN_FAILURE_THRESHOLD` | `3` |
| `CITO_API_BASE_URL` | unset (required to construct the live Cito fallback provider) |

After `LIFECYCLE_ESPN_FAILURE_THRESHOLD` consecutive ESPN polling failures,
the driver falls back to polling Cito (at `POLL_CITO_MS`) until ESPN
succeeds again. ESPN and Cito live fetchers (`src/sources/espn.ts`,
`src/sources/cito.ts`) are only constructed under `DATA_MODE=live`, are
never invoked by tests, and fail closed without `CITO_API_KEY` /
`CITO_API_BASE_URL`. Their URLs are the vendor-documented ones and the ESPN
scoreboard path is verified; what remains unverified is the shape of the
per-round and per-bout response bodies. See
[`LIVE_CARD_VALIDATION.md`](LIVE_CARD_VALIDATION.md) for exactly which
assumptions a real card still needs to confirm.

## Keep it running with tmux

Create a named session and start the app:

```bash
tmux new -s ufcbuild
npm run dev
```

Detach without stopping the server by pressing `Ctrl-b`, then `d`. Reconnect
later with:

```bash
tmux attach -t ufcbuild
```

List existing sessions with `tmux ls`.

## Useful commands

```bash
npm run dev        # Start the local development server
npm run collector  # Start the local data collector
npm test           # Run the test suite once
npm run test:collector # Run collector/server tests
npm run typecheck  # Check TypeScript types
npm run build      # Create a production build
npm run preview    # Preview the production build locally
```

## Tech stack

- React 19
- TypeScript
- Vite
- Vitest
