# UFC Live Data — Implementation Specification

**Status:** normative implementation contract  
**Scope:** personal, non-commercial, single-user local application  
**Supersedes for implementation:** `ufc-live-data-architecture.md`  

Agents should read this file instead of the longer architecture research. The
long document is only for historical rationale or resolving an ambiguity.

## 1. Required outcome

Add a local Node collector between external sources and the existing React SPA.
The collector owns discovery, credentials, polling, streams, lifecycle events,
quota enforcement, persistence, reconciliation, and SSE delivery. The browser
only renders normalized collector data.

The system must work end-to-end with fixtures and no credentials. Live
transports must be isolated behind configuration and must never run during
tests or fixture mode.

## 2. Fixed decisions

- ESPN controls fight lifecycle.
- Cito supplies exact per-round statistics. Never derive a round by subtracting
  cumulative totals.
- Kalshi and Polymarket are streamed continuously while relevant.
- Odds-API.io is the primary sportsbook feed: two configurable books, initially
  DraftKings and FanDuel, polled only during an active bout.
- The Odds API supplies one broader US `h2h` snapshot after each round.
- Sherdog supplies permitted commentary and scorer cards but is nonblocking.
- X defaults to official embeds; manual links are allowed; paid API mode is
  optional, disabled by default, and spending-capped.
- Canonical entity IDs plus `externalRefs` remain the identity seam. Never add
  one hard-coded ID field per source.
- All records retain source time, local receipt time, freshness, provisional
  state, and revision information where applicable.
- Prediction-market probabilities and sportsbook probabilities remain labeled
  and separate.

## 3. Runtime topology

```text
External sources
  -> local Node collector
     -> normalized in-memory state
     -> append-only persistence
     -> SSE/REST delivery
        -> existing React SPA
```

Add:

```text
server/
  collector.ts   startup, discovery, lifecycle loop, stream ownership
  eventBus.ts    typed lifecycle events
  lifecycle.ts   ESPN/Cito state machine
  roundJobs.ts   delayed jobs, idempotency, retry policy
  quota.ts       rolling source quota guards
  tickStore.ts   market ticks, local books, boundary snapshots
  push.ts        SSE endpoint and client management
  storage.ts     local persistence
```

Use dependency-free JSON/JSONL persistence unless an existing dependency makes
another local option materially simpler. Persistence must be injectable and
replaceable by an in-memory implementation in tests.

Existing modules stay in place:

```text
src/schema.ts
src/sources/contract.ts
src/sources/espn.ts
src/sources/cito.ts
src/sources/kalshi.ts
src/sources/kalshiAuth.ts
src/sources/polymarket.ts
src/sources/oddsapi.ts
src/sources/sherdog.ts
src/lib/oddsMath.ts
src/store/useDashboard.ts
src/ui/*
```

Add:

```text
src/sources/oddsApiIo.ts
src/sources/x.ts
```

Add `"odds-api-io"` to `SourceId`. Preserve existing source IDs and
`externalRefs`.

## 4. Configuration and modes

Required modes:

```text
DATA_MODE=fixture|live
X_MODE=disabled|embed|manual|api
```

`fixture` is the default and performs no external network calls.

Live secrets are server-only:

```text
CITO_API_KEY=
ODDS_API_IO_KEY=
THE_ODDS_API_KEY=
KALSHI_API_KEY_ID=
KALSHI_PRIVATE_KEY_PATH=
X_BEARER_TOKEN=
```

Also configure:

- Selected Odds-API.io bookmakers; default `draftkings,fanduel`
- X API spending cap
- Sherdog permission scope and allowed request frequency
- Collector port, persistence path, stale thresholds, and polling intervals

Never commit credentials, Kalshi private keys, Sherdog correspondence, or
permission evidence. Commit only empty examples and permission-scope fields.

## 5. Core events and lifecycle

Typed events:

```ts
type CollectorEvent =
  | { type: "FIGHT_STARTED"; boutId: string; detectedAt: string }
  | {
      type: "PROVISIONAL_ROUND_ENDED";
      boutId: string;
      round: number;
      detectedAt: string;
    }
  | {
      type: "ROUND_ENDED";
      boutId: string;
      round: number;
      detectedAt: string;
      confirmation: "period_transition" | "fight_completed";
    }
  | { type: "FIGHT_ENDED"; boutId: string; round: number; detectedAt: string };
```

Per-bout lifecycle state:

```ts
interface FightLifecycleState {
  boutId: string;
  state: "pre" | "in" | "post";
  period: number;
  completed: boolean;
  clockSeconds?: number;
  sourceUpdatedAt?: string;
  receivedAt: string;
}
```

Transitions:

```text
pre -> in
  emit FIGHT_STARTED

in + clock reaches 0:00 + not completed
  emit PROVISIONAL_ROUND_ENDED(current period) once

period N -> N+1
  confirm round N and emit ROUND_ENDED(N) once

completed false -> true
  confirm the current/provisional round when applicable
  emit ROUND_ENDED once if not already confirmed
  emit FIGHT_ENDED once

provisional clock-0 event + clock resumes without period/completed transition
  supersede the provisional boundary and return to active
```

A stopped clock above `0:00` does not end a round. ESPN polls every 5–10
seconds. Cito live state is the fallback when ESPN is unavailable. Event
emission and all downstream jobs must be idempotent.

## 6. Identity and required records

Bout mapping:

```ts
interface BoutMapping {
  internalBoutId: string;
  externalRefs: ExternalRef[];
  redFighter: string;
  blueFighter: string;
  weightClass: WeightClass;
  scheduledRounds: number;
  mappingConfidence: number;
  manuallyVerified: boolean;
}
```

Market tick:

```ts
interface MarketTick {
  source: "kalshi" | "polymarket" | "odds-api-io" | "the-odds-api";
  boutId: string;
  bookmaker?: string;
  marketType: string;
  outcome: string;
  bid?: number;
  ask?: number;
  lastTrade?: number;
  rawOdds?: number;
  impliedProbability?: number;
  noVigProbability?: number;
  sourceUpdatedAt?: string;
  receivedAt: string;
  stale: boolean;
}
```

Round statistics:

```ts
interface RoundStatsRecord {
  boutId: string;
  round: number;
  fighterA: FighterRoundStats;
  fighterB: FighterRoundStats;
  provisional: boolean;
  revision: number;
  payloadHash: string;
  sourceUpdatedAt?: string;
  firstObservedAt: string;
  lastObservedAt: string;
}
```

Sherdog observation:

```ts
interface SherdogRoundObservation {
  boutId: string;
  round: number;
  commentary: string;
  scorerCards: Array<{
    scorer: string;
    winner?: string;
    roundScore?: string;
    cumulativeScore?: string;
  }>;
  sourceUrl: string;
  publishedAt?: string;
  fetchedAt: string;
  parserVersion: string;
  payloadHash: string;
}
```

Unified round:

```ts
interface UnifiedRoundRecord {
  boutId: string;
  round: number;
  detectedEndedAt: string;
  endingSignal:
    | "clock_zero_provisional"
    | "period_transition"
    | "fight_completed";
  citoStats?: RoundStatsRecord;
  sherdog?: SherdogRoundObservation;
  xScores?: ParsedExpertScore[];
  marketAtEnd: {
    kalshi?: MarketSnapshot;
    polymarket?: MarketSnapshot;
    oddsApiIo?: MarketSnapshot;
    theOddsApi?: MarketSnapshot;
  };
  expertConsensus?: ExpertConsensus;
  provisional: boolean;
  finalizedAt?: string;
}
```

Extend `OddsSource` or add a focused companion contract so callers can obtain
tick history and round-boundary snapshots. Current-snapshot-only behavior is
insufficient. Provide multi-tick fixtures.

## 7. Source behavior

### ESPN

- Discover card and bouts.
- Poll scoreboard every 5–10 seconds.
- Normalize `clock`, `displayClock`, `period`, `state`, and `completed`.
- Drive the lifecycle state machine.
- Fall back to Cito lifecycle state after repeated unavailability.

### Cito

- Fetch exact round data with the equivalent of `?round=N`.
- Initial round job: T+5–8 seconds.
- One retry at T+20–30 seconds only when absent or structurally incomplete.
- Serialize requests to remain below 10/minute.
- After fight end, fetch all rounds once and reconcile revisions.
- Preserve payload hashes and revision history.
- Treat live SSE quota behavior as unverified; do not depend on it.

### Kalshi

- Terminate the authenticated WebSocket in the collector.
- Use the existing RSA-PSS signer; private keys remain server-side.
- Handle ticker, trade, order-book delta, and lifecycle messages.
- Reconnect with jittered backoff, authenticate, resubscribe, and rebuild
  state.
- Store bid, ask, midpoint, spread, depth, last trade, volume, source time,
  and receipt time.
- Prefer bid/ask midpoint when both sides exist; never substitute a stale last
  trade as current probability.

### Polymarket

- Connect from the collector to the public market stream.
- Discover and subscribe by outcome token IDs.
- Send the required text `PING` every 10 seconds.
- Handle book snapshots, deltas, best bid/ask, trades, tick-size changes, and
  lifecycle events.
- Rebuild the book after reconnect before marking data fresh.

### Odds-API.io

- Discover the mapped event.
- Query only the active bout and configured bookmakers.
- Poll during rounds and breaks; do not poll before the fight or between
  fights.
- Take a final snapshot, then stop when the fight completes.
- Defaults: 30-second interval, 90/hour soft cap, 450/day soft cap.
- Adaptive policy:

```text
more than 30 hourly requests remain: 30 seconds
15–30 remain:                         45 seconds
fewer than 15 remain:                60 seconds
fewer than 30 daily remain:          boundary/final requests only
```

### The Odds API

- Use sport `mma_mixed_martial_arts`, region `us`, market `h2h`.
- Fetch once at T+20–30 seconds after each confirmed round.
- Do not aggressively retry.
- Label as a broad post-round comparison, not a horn-time price.

### Sherdog

- Fetch at T+10–15 seconds after a round.
- Retry once at T+30–45 seconds if the round is absent.
- Fetch final result/scoring state after fight end.
- Version the parser and retain payload hashes.
- Apply configured permission constraints.
- On HTTP 403, stop. Do not rotate proxies, identities, or user agents.
- Parser or access failure never blocks other round jobs.

### X

```text
disabled: no integration
embed:    official embeds for known post IDs; default
manual:   configured scorer links
api:      official API only, with an enforced spending cap
```

X never participates in critical lifecycle or round completion.

## 8. Market state and round boundaries

- Keep exchange streams connected through round breaks.
- Maintain the latest normalized state in memory.
- Append every accepted update to tick history.
- At provisional and confirmed boundaries, snapshot local cached state rather
  than making a new exchange request.
- If a provisional ending is superseded or its timestamp changes on
  confirmation, recompute the boundary snapshot from stored ticks.
- Preserve native prices alongside normalized implied probability.
- Compute sportsbook no-vig probability only from a valid paired market.

## 9. Post-round jobs and idempotency

Job key:

```text
{boutId}:{round}:{jobType}
```

Required uniqueness:

```text
round_stats:      (bout_id, round, fighter_id)
round_jobs:       (bout_id, round, job_type)
expert_scores:    (source, source_post_id)
market_snapshots: (bout_id, round, source, boundary_type)
```

Retries update provisional records; they do not append duplicate finals.
Independent Cito, Sherdog, X, and sportsbook jobs run concurrently after a
round event. Failure of one source never blocks another.

## 10. Retry and failure policy

| Source | Retry | Terminal behavior |
|---|---|---|
| ESPN | Jittered exponential reconnect | Use Cito lifecycle fallback |
| Cito | One delayed retry if missing/incomplete | Mark stats pending |
| Kalshi | Backoff, reauthenticate, resubscribe | Preserve last state as stale |
| Polymarket | Backoff, resubscribe, rebuild book | Preserve last state as stale |
| Odds-API.io | Transient failures only and only within quota | Preserve last state |
| The Odds API | No aggressive retry | Omit snapshot |
| Sherdog | One delayed retry | Omit temporarily |
| X | One late check in API mode only | Omit |

Never retry authentication failure or quota exhaustion automatically. Apply
timeouts and maximum response sizes to every external request.

## 11. Persistence, delivery, and UI

Persist:

- Cross-source mappings and manual overrides
- Raw validated payloads with hashes
- Market ticks and boundary snapshots
- Round jobs and unified round records
- Commentary and scorer cards
- Parser errors and ambiguous mappings
- Source health and quota state

Expose collector state to the SPA through SSE plus minimal REST/bootstrap
endpoints. SSE must:

- Send normalized records only.
- Support reconnect and a last-known-state bootstrap.
- Use event IDs or another duplicate-safe resume mechanism.
- Emit health/freshness changes.
- Never expose secrets or raw authentication details.

The SPA must retain fixture mode and degrade gracefully when the collector is
unavailable. Visible live values show source, source update time when present,
receipt time, stale state, provisional/final state, and revision when relevant.

## 12. Security and validation

- Validate all external JSON and HTML before persistence.
- Escape external commentary before rendering.
- Never log credentials, auth headers, signatures, or private key material.
- Keep keys and permission evidence outside source control.
- Live mode must fail closed when required credentials are absent.
- Fixture mode must be deterministic and network-free.
- Do not scrape sportsbook sites.
- Do not bypass Sherdog access controls.
- Do not place bets or execute trades.

## 13. Observability

Track:

```text
source_requests_total
source_errors_total
source_rate_limit_remaining
source_response_latency_ms
source_payload_age_seconds
websocket_reconnects_total
round_event_detection_delay_ms
round_stats_availability_delay_ms
sherdog_publication_delay_ms
mapping_confidence
parser_failures_total
provisional_records_total
revisions_total
```

Log source timestamps separately from local timestamps.

## 14. Implementation order

### Phase 1 — collector, lifecycle, and stats

1. Collector startup, storage, event bus, and SSE.
2. Route fixture data through collector to SPA.
3. Mapping through canonical IDs and `externalRefs`.
4. ESPN/Cito lifecycle state machine.
5. Cito queue, round jobs, provisional records, and reconciliation.
6. Tests for normal rounds, clock-zero supersession, early stoppages, final
   decision rounds, duplicate inputs, restart recovery, and SSE resume.

### Phase 2 — prediction markets

1. Kalshi and Polymarket transport interfaces and fixture replays.
2. Credential-gated live transports.
3. Local book reconstruction and reconnect behavior.
4. Tick persistence and provisional/confirmed boundary snapshots.

### Phase 3 — sportsbooks

1. Odds-API.io source, discovery, configurable books, quota guard, and polling.
2. The Odds API delayed round snapshots.
3. Native prices, implied probability, no-vig normalization, and freshness.

### Phase 4 — commentary and scores

1. Permission configuration and Sherdog parser fixtures.
2. Parser versioning, retries, and final reconciliation.
3. X embed/manual modes.
4. Optional credential-gated, spending-capped X API mode.
5. Separate Sherdog and X consensus.

### Phase 5 — resilience

1. Dead-letter records and source health.
2. Manual mapping/correction seams.
3. Quota and freshness alerts.
4. Complete fixture replay through collector, persistence, SSE, and SPA.

## 15. Automated acceptance

The implementation is not complete until all applicable checks pass:

- Existing tests remain green.
- Typecheck and production build pass.
- Fixture mode makes zero external requests.
- Collector restart restores persisted mappings, jobs, ticks, and round state.
- Replayed duplicate source events do not duplicate jobs or final records.
- Lifecycle tests cover every transition in Section 5.
- Quota tests cover every Odds-API.io degradation threshold.
- Market tests cover snapshot + deltas, out-of-order data, disconnect,
  resubscribe, rebuilt freshness, and boundary recomputation.
- Cito tests cover absent, incomplete, corrected, and reconciled rounds.
- SSE tests cover bootstrap, updates, reconnect, resume, and duplicate safety.
- Failure tests prove one source cannot block other round jobs.
- Secret-scanning assertions prove server credentials never enter client
  output.
- One end-to-end fixture replay reaches the SPA with lifecycle, stats, markets,
  commentary, health, and freshness intact.

Required commands:

```bash
npm test
npm run typecheck
npm run build
```

Add any collector-specific test command to `package.json` and document it.

## 16. Deferred live-card validation

Implementation may be complete while these remain explicitly unverified:

- ESPN transition timing and clock granularity
- Cito publication/revision latency and SSE quota semantics
- Odds-API.io UFC freshness and bookmaker availability
- The Odds API post-round usefulness
- Sherdog access from the actual runtime and parser stability
- Kalshi/Polymarket bout coverage, liquidity, and reconnect behavior
- Vendor quota or pricing changes

Record these as live-card validation tasks. Never claim fixture tests validated
real-event behavior.

## 17. Completion report

Report:

- Implemented phases and commits
- Tests, typecheck, and build results
- Fixture replay result
- Deferred or blocked items
- Live-card validation tasks
- Final `git status --short --ignored`

