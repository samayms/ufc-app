# Live-card validation tasks

`ufc-live-data-implementation-spec.md` §16 permits the implementation to be
complete while the items below remain unverified, and requires them to be
recorded as tasks. Nothing here was validated by a fixture test, and no fixture
test can validate any of it — each one needs a real card, watched live.

The rule this list exists to enforce: **never claim fixture tests validated
real-event behavior.** A green suite proves the collector handles the shapes we
believe the sources emit. It proves nothing about whether they emit them.

## How to run a validation session

```bash
npm run collector:live        # resident collector, live transports
npm run dev                   # SPA against the collector
```

Keep `/api/metrics` and the collector's stderr in view for the whole card.
Every item below should end with an observation written into this file
(timestamp, event, what the payload actually said) or a fixture captured into
`src/fixtures/` so the behavior becomes testable afterwards.

## Lifecycle

- [ ] **ESPN transition timing and clock granularity.** Does `clock` reach a
      literal `0:00` between rounds, or does ESPN skip from a nonzero clock
      straight to the next `period`? The whole `clock_zero_provisional` →
      `period_transition` path in §5 assumes the former, and falls back safely
      to the latter, but which one actually fires is unknown.
- [ ] **ESPN poll interval in practice.** 5–10s is specified; confirm ESPN
      neither rate-limits it nor serves a cached scoreboard that lags the
      broadcast enough to make the boundary snapshots meaningless.
- [ ] **ESPN event/fighter discovery.** The scoreboard path and its lifecycle
      parser were verified live on 2026-07-28, and live cards are built through
      `src/sources/espnSchedule.ts`. What stays unimplemented is
      `createEspnSource`'s own event/fighter discovery — confirm nothing in a
      live run depends on it.
- [ ] **Cito lifecycle fallback.** Only reachable when ESPN fails repeatedly.
      Force it (block ESPN at the network level mid-card) and confirm the
      handover produces no duplicate or missed round events.

## Round statistics

- [ ] **Cito exact-round response shape.** The exact-round response has never
      been captured and remains unverified. The current parser accepts a
      single round object, one `data` wrapper, arrays of explicitly
      round-matched rows, and the six defined stat fields in either camelCase
      or snake_case. A shape mismatch degrades to an absent or incomplete
      round; it does not announce itself. Confirm the actual fighter
      identifiers/corner fields and revise the parser from a real response.

- [ ] **Cito publication latency.** The T+5–8s initial job and single T+20–30s
      retry are guesses at when exact round data appears. Measure the real
      delay; if it is routinely longer, the retry window is wrong.
- [ ] **Cito revision behavior.** Confirm corrected rounds actually arrive as
      revisions, and that the payload-hash comparison catches them.
- [ ] **Cito `liveBouts` field names.** The base URL is verified (it returned
      HTTP 200), but the captured response had an **empty `liveBouts` array** —
      there was no live event at capture time — so every per-bout field name
      inside it is a guess. The parser skips what it cannot match rather than
      throwing, so a wrong guess degrades quietly instead of crashing, which
      also means it will not announce itself. Check this first on a live card.
- [ ] **Cito live SSE quota semantics.** Treated as unverified by §7 and not
      depended on. Confirm before any future work relies on it.
- [ ] **Cito serialization below 10/min.** Verified in tests against the quota
      guard; confirm the real endpoint agrees about what counts as a request.
- [ ] **Which of Cito's two exact-round endpoints is actually needed.** Each
      round boundary currently spends **two** requests — `stats?round=N` and
      `rounds?round=N` — and merges them, because without a captured response we
      cannot tell which one carries the per-fighter figures. Once a real card
      shows that one endpoint is sufficient, drop the other and halve the
      per-round Cito quota cost. `cito-live-round-stats-weekend-test.md` is the
      procedure for establishing this.

## Markets

- [ ] **Kalshi bout coverage and liquidity.** Which bouts on a real card have
      Kalshi markets at all, and do they have two-sided books? The
      bid/ask-midpoint preference degrades to nothing without both sides.
- [ ] **Kalshi reconnect behavior.** Force a disconnect mid-round and confirm
      reauthenticate → resubscribe → rebuild leaves no stale state marked fresh.
- [ ] **Polymarket bout coverage and token discovery.** Confirm outcome token
      IDs can be discovered for real UFC bouts, and that the 10-second text
      `PING` keeps the connection alive for a full card.
- [ ] **Polymarket book rebuild after reconnect.** Same as Kalshi: no data
      marked fresh before the book is whole.
- [ ] **Odds-API.io UFC freshness and bookmaker availability.** Are DraftKings
      and FanDuel actually present for UFC, and do prices move during a round
      or only between fights? A feed that only updates between fights makes the
      30s active-bout cadence pointless. The captured payload
      (`src/fixtures/oddsApiIoOddsLive.json`) contains **only Bet365**, so the
      configured `draftkings,fanduel` default is unproven against a real
      response — multi-book filtering is tested against an augmented copy of
      that payload, which proves the filter works but not that those two books
      exist for UFC. Note the configured default is actually
      `Bet365,DraftKings`, not the `DraftKings,FanDuel` the spec names as the
      initial pair — the casing matters to the vendor, and Bet365 is the only
      book the captured response contains. Confirm which books UFC really
      offers, then decide whether to move to the spec's pair.
- [ ] **Odds-API.io event grouping.** The vendor's events endpoint returns one
      event per fight, with no card-level id, so live discovery groups bouts
      under an id derived from the league name. Confirm against a real card that
      this groups the way the mapper expects.
- [ ] **Odds-API.io quota reality.** The 90/hour and 450/day soft caps and the
      30/45/60s degradation ladder are configured defaults, not measured
      limits. Confirm against the vendor's real headers.
- [ ] **The Odds API post-round usefulness.** One `h2h` snapshot at T+20–30s
      after each round: confirm the prices have actually moved off the
      pre-fight line by then, or the snapshot is decoration. The captured
      payload (`src/fixtures/theOddsApiLive.json`) holds a single event, so
      multi-event responses and the region/market parameters are exercised only
      against that one shape.

## Commentary and scores

- [x] **Sherdog live transport permission.** Permission was granted 2026-07-29
      and `SHERDOG_PERMISSION_SCOPE=sherdog-read` is set locally. The URL
      pattern is confirmed: one page per card, at
      `/news/news/<slug>-playbyplay-results-round-scoring-<id>`. Point
      `SHERDOG_LIVE_BLOG_URL` at the page for the event being watched.
- [x] **Sherdog access from this runtime.** Verified 2026-07-29 against
      `UFC-Oklahoma-City-Du-Plessis-vs-Usman-...-201960`: HTTP 200, 144,776
      bytes, no block. `robots.txt` allows all agents. On HTTP 403 the
      collector still stops by design — it must not be "fixed" by rotating
      proxies, identities, or user agents.
- [x] **Sherdog parser stability.** Confirmed against a real page, which
      differed from the hand-written fixture in three ways (whole card on one
      page, commentary as bare text rather than `<p>`, named writers scoring
      with a colon). The page is captured as `src/fixtures/sherdogLivePage.html`
      and pinned by `src/sources/sherdogLivePage.test.ts`.
- [ ] **Sherdog behavior during a live card.** The verified page was a
      completed event, so it was read in its final form. What is still
      unconfirmed is the page *mid-event*: whether a round's section appears
      only once complete, whether scorer lines land with the prose or after it,
      and whether earlier rounds are ever revised. Watch one live card before
      trusting round-completion timing.
- [ ] **Sherdog publication delay.** The three attempts at T+15s/T+30s/T+60s
      are a guess at when a round's commentary and scorer cards appear.
      Measure the real delay and adjust the ladder if all three land too early.
      Note the interval floor interacts with this: `SHERDOG_REQUEST_INTERVAL_MS`
      is now `15000` locally so all three attempts can be sent, since the
      300000 default silently dropped the second and third.
- [ ] **X post discovery in embed mode.** Confirm known scorer post IDs render,
      and that a missing post degrades quietly. X never participates in
      lifecycle or round completion.

## Pre-event scheduling

- [ ] **Event-day detection against a real card.** `sourceCalendarDay()` derives
      the event day from the UTC offset embedded in the event's own timestamp.
      ESPN emits `Z`, so today this is effectively a UTC day — which is *not*
      the local calendar day of a US evening card. Confirm what ESPN actually
      sends for a real event, and decide whether the hourly cadence should key
      off the venue's local day instead.
- [ ] **Restart deduplication in the wild.** Restart the live collector inside a
      poll interval and confirm from `data/pre-event-polls.jsonl` that it waited
      out the remainder rather than re-polling four rate-limited APIs.
- [ ] **Active-bout suspension.** Confirm the pre-event poll genuinely stays
      quiet from the first `FIGHT_STARTED` to the last `FIGHT_ENDED`, and that
      the schedule resumes afterwards without firing a backlog.

## Vendor risk

- [ ] **Quota or pricing changes.** Every cap in `server/config.ts` is a
      configured default reflecting what the vendors documented at build time.
      Re-check before each card; a silently tightened quota looks exactly like
      a bug.
