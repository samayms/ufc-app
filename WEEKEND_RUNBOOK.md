# Weekend runbook — UFC Fight Night: Medić vs. Rodriguez

Saturday 2026-08-01, Belgrade Arena. Prelims from **14:00 UTC** (10:00 ET),
main card from **17:00 UTC** (13:00 ET). Fourteen bouts.

Every identifier and every latency below was measured against the live APIs on
2026-07-30, not inferred. Where something is still unknown, it says so.

## The card, as each vendor names it

| Vendor | Identifier |
| --- | --- |
| ESPN event | `600059339` |
| ESPN main-event bout | `401870843` (Medić vs. Rodriguez) |
| Cito event slug | `ufc-fight-night-august-01-2026` |
| Cito event id | `ae9a4067-05b9-4ae1-a7f7-28db3498c1aa` |
| Cito bout ids | `12879` `12966` `12881` `12882` `12883` `12994` (main card), `12904` `12916` `12995` `12906` `12956` `12927` `12996` `12997` (prelims) |
| Kalshi event tickers | `KXUFCFIGHT-26AUG01…` (14 open events) |
| Sherdog live blog | **not published yet** — find it on the day, then set `SHERDOG_LIVE_BLOG_URL` |

ESPN dates the *event* 14:00Z while Cito dates it 17:00Z. Both are right: ESPN
is stamping the prelims, Cito the main card. Do not "fix" either.

## Start-up order

```bash
npm run lab          # port 5055 — always start this first, it needs nothing else
npm run collector:live   # port 8600
npm run dev              # port 5173, the dashboard
```

The lab is deliberately independent: no collector, no event bus, no React. If
the dashboard or the collector is broken, the lab still answers "is ESPN live
yet, and what did it actually say?".

`?collector=off` on the dashboard URL ignores a running collector and shows the
fixture card instead — useful when the collector is mid-restart.

## Pre-flight, about an hour before the prelims

Run these in the lab, in this order. Each one has a known-good answer.

1. **`cito.live.health`** — the single most informative call on the page. On
   2026-07-30 it read `workerAlive: false` with a **32-hour stale heartbeat**,
   tracking only a long-finished event. If it still reads DEAD on Saturday,
   Cito's live pipeline is not running and no live clock or round data will
   arrive from Cito at all. ESPN drives the lifecycle regardless, so the card
   is still watchable — but stop waiting for Cito's live feed and stop
   attributing its silence to our code.
2. **`espn.scoreboard`** — expect 14 bouts, `0 in progress` beforehand.
3. **`cito.event.bouts`** — expect 14 bouts with both corners named. This is
   where the Cito bout ids above came from; re-read them, ids can change.
4. **`collector.bootstrap`** — check the `refs per source` line. Every bout
   needs a **`cito`** ref, not only `espn`; without one, that bout's round
   stats can never be fetched.
5. **`kalshi.signed`** — must say "signature accepted". If it does not, no
   authenticated Kalshi call will work.
6. **`kalshi.events`** — read the per-event `two-sided` and `liquidity`
   figures. Two-sided books are what the midpoint pricing needs.
7. **`theoddsapi.h2h`** — note `x-requests-remaining` (487 on 2026-07-30 out of
   500). This allowance is the tightest constraint of the night.
8. **`cito.round.stats`** with bout `9009ec7b91f2be14`, round 1 — a completed
   bout whose stats *are* populated. It must show two rows and a parsed red and
   blue. This proves the parser before the card starts, so a silent round later
   is unambiguously Cito being late rather than us mis-parsing.

## Measuring the timing — what the lab is for

The question is: *how long after a round ends does CITO publish its stats?*

1. Choose the fight from the lab's **Fight** list. The CITO bout id is attached
   to the choice; do not enter or copy an id.
2. Choose the round number.
3. When the horn sounds, press **Round ended — start polling**. Spacebar works
   when no form control has focus. This press is the latency reference.
4. The lab checks CITO every five seconds. It shows elapsed time, completed
   checks, and the countdown to the next check. Press **Stop polling** at any
   point to cancel.
5. When CITO publishes the round, the red-corner/blue-corner stat table appears
   with the measured latency. Use **View raw CITO JSON** only when the table
   looks surprising.
6. Record the displayed latency in `LIVE_CARD_VALIDATION.md`. The underlying
   observation is also appended to `data/lab-timeline.jsonl`.

The watcher stops requesting the round as soon as it receives non-empty stats,
so quota is only spent on unanswered questions.

## The open questions this card can settle

- **Does Cito publish round stats live at all?** Every bout on the card reads
  `dataAvailability.roundStats: "ufcstats_enrichment_when_available"`, and
  `hasStats: false` on all 50 recent bouts checked. A bout from 2026-07-25
  *does* have complete per-round stats, so enrichment happens eventually — what
  is unknown is whether it happens between rounds or only after the fight. If
  it is only afterwards, the per-round stats panel will stay empty live no
  matter what we do, and that is a vendor property, not a bug.
- **Which ESPN transition actually fires between rounds** — the clock reaching
  a literal `0:00`, or the period incrementing from a nonzero clock. Both paths
  are implemented; only one is real.
- **Cito publication latency**, if it publishes at all. The retry ladder is
  currently a guess.
- **Sherdog mid-event behaviour** — whether a round's section appears only once
  complete, and whether scorer lines land with the prose or after it. The page
  has only ever been read in its finished form.
- **Kalshi and Polymarket coverage** on a real card, and whether books stay
  two-sided during a round.

`LIVE_CARD_VALIDATION.md` holds the full list.

## When something looks broken

| Symptom | First thing to check |
| --- | --- |
| Dashboard shows nothing | `collector.health` and `collector.bootstrap` in the lab. If they answer, the data is fine and the UI is at fault. |
| A round has no stats | `cito.round.stats` for that bout and round. `availability: pending_stat_enrichment` with zero rows means Cito has not published it — HTTP 200 and empty is Cito's way of saying "not yet". |
| Round stats never arrive for any bout | `collector.bootstrap` → does each bout carry a `cito` ref? Without one nothing can be requested. |
| Odds frozen | `theoddsapi.h2h` and `oddsapiio.events`. Check the quota headers before assuming a bug. |
| Sherdog empty | `sherdog.page` with the day's URL and both fighter names. One page carries the whole card, so the names are what scope it. |
| Sherdog HTTP 403 | **Stop.** The collector stops by design. Do not rotate proxies, identities, or user agents. |
| Everything red at once | Check the network, then `npm run lab` itself — `/lab/health`. |

## Quota, measured 2026-07-30

| Source | Reading | Notes |
| --- | --- | --- |
| The Odds API | `x-requests-remaining: 487` of 500 | Tightest budget of the night. One h2h snapshot per round per bout adds up fast. |
| Odds-API.io | `x-ratelimit-limit: 100`, resets hourly | 98 remaining after two probes. |
| Cito | `x-ratelimit-remaining: 200` | Dropped ~1 per request across the session. The round-stats path now spends one request per round rather than two. |
| ESPN, Polymarket, Kalshi public, Sherdog | unmetered | Sherdog is a courtesy read of someone else's page — the lab will not poll it faster than every 15s. |
| Gemini | metered in money | The lab's summary probe is labelled `paid` and is never included in a bulk run. |
