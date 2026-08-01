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
| `SHERDOG_REQUEST_INTERVAL_MS` | `10000` |
| `SHERDOG_BASE_URL` | `https://www.sherdog.com` |
| `SHERDOG_LIVE_BLOG_URL` | unset |
| `ROUND_SUMMARY_ENABLED` | `true` |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` |

Staleness settings use `STALE_LIFECYCLE_MS`, `STALE_STATS_MS`,
`STALE_MARKETS_MS`, and `STALE_COMMENTARY_MS`. Polling settings use
`POLL_ESPN_MS`, `POLL_ODDS_API_IO_MS`,
`POLL_THE_ODDS_API_MS`, `POLL_KALSHI_MS`, and `POLL_POLYMARKET_MS`.

The resident collector owns the pre-event market schedule for Kalshi,
Polymarket, Odds-API.io, and The Odds API: twice daily on non-event days and
hourly on an event's scheduled calendar day. It persists successful poll times
to deduplicate restarts, suspends while a bout is active, and uses the retry
delay above for transient failures. Set `PRE_EVENT_POLL_ENABLED=false` when a
separate one-shot scheduler is the intended owner.

Live credentials are server-only: `ODDS_API_IO_KEY`, `THE_ODDS_API_KEY`,
`KALSHI_API_KEY_ID`, and `KALSHI_PRIVATE_KEY_PATH`. Live startup fails when
any of those required credentials are missing. `GEMINI_API_KEY` is optional;
without it the raw Sherdog commentary remains available as the summary.

Sherdog live reads require both a permitting `SHERDOG_PERMISSION_SCOPE`
(`live-blog-read`, `sherdog-read`, or `all`) and actual permission from
Sherdog. The transport remains fail-closed without both.

A card's play-by-play lives at one page per event, of the form
`/news/news/<slug>-playbyplay-results-round-scoring-<id>`, with every bout on
it. Point `SHERDOG_LIVE_BLOG_URL` at that page for the event being watched;
the parser picks each bout's rounds out of it by fighter name, so no per-bout
mapping is needed. A bout that does carry its own `sherdog` external ref uses
that instead.

Once Sherdog publishes the article, `npm run sherdog:find` discovers it from
Sherdog's official news RSS feed by matching the nearest ESPN card's two
main-event fighters. It prints the `SHERDOG_LIVE_BLOG_URL` assignment without
modifying `.env`. Pass `--event`, `--red`, and `--blue` to bypass the ESPN
lookup and search for an explicitly named matchup.

Sherdog also publishes a fight-outlook ("Preview") article ahead of the
live blog. `npm run sherdog:outlook:find` finds it the same way and prints
`SHERDOG_FIGHT_OUTLOOK_URL`. `npm run sherdog:outlook:watch` automates the
lookup: it sleeps until 3 days before the event, then checks twice daily
until the article is found (or the event starts without one ever appearing),
caching the result in `data/sherdog-outlook-state.json` so restarts don't
re-fetch.

Each Sherdog round is condensed by Gemini into the summary the dashboard
shows. The raw play-by-play runs two to three thousand characters and the
summary box clamps at five lines, so the condensation is capped at 380
characters: roughly four to five lines at the phone width, with slack so word
wrap cannot spill into a sixth. Em dashes are forbidden in the prompt and
stripped from the response regardless.

This needs `GEMINI_API_KEY`, which is optional; live startup does not require
it. With no key, `ROUND_SUMMARY_ENABLED=false`, or in fixture mode, rounds
keep their raw commentary. Summaries never gate a Sherdog round job: every
transport failure yields no summary rather than an error, and an unchanged
page reuses the previous summary instead of paying for it again.

At fight start, the collector stores a normalized, per-round snapshot of that
bout's Sherdog block. After every round boundary or fight end, one durable job
polls at `SHERDOG_REQUEST_INTERVAL_MS` (10 seconds by default) until the target
round differs from its baseline and contains real commentary or a numeric
score. Empty pre-rendered round headings and scorer names are not treated as a
report. Completed timed rounds keep polling until Sherdog's named scorecards
arrive; finish rounds remain valid with commentary and no 10-9 cards.

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

The real collector uses ESPN exclusively for live lifecycle and fight stats;
it does not construct or poll a Cito client. ESPN's scoreboard path and core
competitor-stat paths are covered by captured-shape parser tests. See
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

## The lab

```bash
npm run lab        # http://localhost:5055
```

A synchronized fight and round-end timing instrument. Choose a fight and press
**Fight started — track ESPN** at the opening bell. ESPN is then sampled every
2.5 seconds for its period, reported clock, state, and completion flag while a
local clock counts down between samples. Choose the round and press **Round
ended — fire all sources** at the horn (spacebar also works). That one press
immediately requests CITO, ESPN, and Kalshi against the same timestamp while
the five-second ESPN monitor continues. Pending CITO stats retry every five
seconds; Kalshi captures one matching fight-market snapshot.

The page shows every source's response count, result, and horn-relative
latency. CITO stats appear in a red-corner/blue-corner table, ESPN names the
exact round-end signal it observed, and Kalshi shows both fighter prices.
**Stop polling** cancels the measurement at any time, and the combined raw
source JSON remains available for debugging. The lab shares nothing with the
app — no collector, event bus, or React — so it stays usable if the dashboard
is not. `WEEKEND_RUNBOOK.md` is the fight-night procedure.

## Useful commands

```bash
npm run app        # Real app only: compiled dashboard on 4173 + collector
npm run dev        # Start the local development server
npm run lab        # Lab only: timing instrument on 5055
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
