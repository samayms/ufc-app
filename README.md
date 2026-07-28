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

Configuration is supplied through server environment variables:

| Setting | Default |
| --- | --- |
| `DATA_MODE` (`fixture` or `live`) | `fixture` |
| `X_MODE` (`disabled`, `embed`, `manual`, or `api`) | `embed` |
| `COLLECTOR_PORT` | `8600` |
| `PERSISTENCE_PATH` | `./data` |
| `ODDS_API_IO_BOOKMAKERS` | `draftkings,fanduel` |
| `X_SPEND_CAP_USD` | `0` |
| `SHERDOG_PERMISSION_SCOPE` | `none` |
| `SHERDOG_REQUEST_INTERVAL_MS` | `300000` |

Staleness settings use `STALE_LIFECYCLE_MS`, `STALE_STATS_MS`,
`STALE_MARKETS_MS`, and `STALE_COMMENTARY_MS`. Polling settings use
`POLL_ESPN_MS`, `POLL_CITO_MS`, `POLL_ODDS_API_IO_MS`,
`POLL_THE_ODDS_API_MS`, `POLL_KALSHI_MS`, and `POLL_POLYMARKET_MS`.

Live credentials are server-only: `CITO_API_KEY`, `ODDS_API_IO_KEY`,
`THE_ODDS_API_KEY`, `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PATH`, and
`X_BEARER_TOKEN`. Live startup fails when required credentials are missing;
`X_BEARER_TOKEN` is required only when `X_MODE=api`. Live transports are not
enabled yet.

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
