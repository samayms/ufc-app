import { americanToImpliedProb } from "../lib/oddsMath.ts";
import type {
  Bout,
  Corner,
  DashboardState,
  ExpertConsensus,
  NativePrice,
  OddsQuote,
  OddsSnapshot,
  RoundStats,
  RoundUpdate,
  SherdogRoundObservation,
  SourceId,
} from "../schema.ts";
import type {
  MarketBoundaryType,
  MarketSnapshot,
  MarketSnapshotOutcome,
  MarketSource,
  MarketTick,
} from "../sources/contract.ts";
export const DEFAULT_COLLECTOR_PORT = 8600;

export type CollectorConnectionState =
  | "connected"
  | "reconnecting"
  | "unavailable";

export type CollectorHealthStatus =
  | "healthy"
  | "stale"
  | "degraded"
  | "unavailable";

export interface CollectorSourceHealth {
  source: string;
  status: CollectorHealthStatus;
  fresh: boolean;
  checkedAt: string;
  sourceUpdatedAt?: string;
  message?: string;
}

interface CollectorFighterRoundStats extends RoundStats {
  significantStrikes: number;
  totalStrikes: number;
  takedowns: number;
  takedownsAttempted: number;
  controlTimeSeconds: number;
  knockdowns: number;
}

interface CollectorRoundStats {
  boutId: string;
  round: number;
  fighterA: CollectorFighterRoundStats;
  fighterB: CollectorFighterRoundStats;
  provisional: boolean;
  revision: number;
  sourceUpdatedAt?: string;
  firstObservedAt: string;
  lastObservedAt: string;
}

export interface CollectorUnifiedRound {
  boutId: string;
  round: number;
  detectedEndedAt: string;
  endingSignal:
    | "clock_zero_provisional"
    | "period_transition"
    | "fight_completed";
  citoStats?: CollectorRoundStats;
  sherdog?: SherdogRoundObservation;
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

type CollectorLifecycleEvent =
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
  | {
      type: "FIGHT_ENDED";
      boutId: string;
      round: number;
      detectedAt: string;
    };

export interface CollectorLifecycleDelivery {
  boutId: string;
  source: "collector lifecycle";
  sourceUpdatedAt: string;
  receivedAt: string;
  provisional: boolean;
}

export interface CollectorClockSync {
  boutId: string;
  source: "espn" | "cito";
  state: "pre" | "in" | "post";
  period: number;
  completed: boolean;
  clockSeconds?: number;
  /** When the collector received the source response. */
  sourceReceivedAt: string;
  /** When this browser received the synchronization point. */
  receivedAt: string;
}

export interface CollectorValueDelivery {
  source: string;
  sourceUpdatedAt?: string;
  receivedAt: string;
  stale: boolean;
  provisional: boolean;
  revision?: number;
}

export interface CollectorSnapshot {
  connection: CollectorConnectionState;
  dashboard: DashboardState | null;
  health: Readonly<Record<string, CollectorSourceHealth>>;
  unifiedRounds: readonly CollectorUnifiedRound[];
  lifecycle: Readonly<Record<string, CollectorLifecycleDelivery>>;
  clocks: Readonly<Record<string, CollectorClockSync>>;
  /** Keyed by `${boutId}:${market}`; freshness for the latest odds shown per market. */
  marketDeliveries: Readonly<Record<string, CollectorValueDelivery>>;
  lastReceivedAt?: string;
}

export interface CollectorClient {
  getSnapshot(): CollectorSnapshot;
  start(): Promise<void>;
  subscribe(listener: (snapshot: CollectorSnapshot) => void): () => void;
  close(): void;
}

interface CollectorBootstrap {
  state: DashboardState | null;
  health: Record<string, CollectorSourceHealth>;
  lifecycleObservations: ParsedLifecycleObservation[];
  unifiedRounds: CollectorUnifiedRound[];
  latestMarkets: MarketTick[];
}

interface ParsedLifecycleObservation {
  boutId: string;
  source: "espn" | "cito";
  state: "pre" | "in" | "post";
  period: number;
  completed: boolean;
  clockSeconds?: number;
  receivedAt: string;
}

interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: EventListener): void;
  close(): void;
}

export interface CollectorClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  createEventSource?: (url: string) => EventSourceLike;
  now?: () => string;
  bootstrapTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value))
  );
}

function isDashboardState(value: unknown): value is DashboardState {
  return (
    isRecord(value) &&
    isRecord(value.event) &&
    typeof value.event.id === "string" &&
    Array.isArray(value.event.bouts) &&
    isRecord(value.boutViews)
  );
}

function isCollectorHealthStatus(
  value: unknown,
): value is CollectorHealthStatus {
  return (
    value === "healthy" ||
    value === "stale" ||
    value === "degraded" ||
    value === "unavailable"
  );
}

function parseHealth(value: unknown): CollectorSourceHealth | null {
  if (
    !isRecord(value) ||
    typeof value.source !== "string" ||
    !isCollectorHealthStatus(value.status) ||
    typeof value.fresh !== "boolean" ||
    !isTimestamp(value.checkedAt) ||
    (value.sourceUpdatedAt !== undefined &&
      !isTimestamp(value.sourceUpdatedAt)) ||
    (value.message !== undefined && typeof value.message !== "string")
  ) {
    return null;
  }

  return {
    source: value.source,
    status: value.status,
    fresh: value.fresh,
    checkedAt: value.checkedAt,
    ...(value.sourceUpdatedAt === undefined
      ? {}
      : { sourceUpdatedAt: value.sourceUpdatedAt }),
    ...(value.message === undefined ? {} : { message: value.message }),
  };
}

function parseHealthMap(
  value: unknown,
): Record<string, CollectorSourceHealth> {
  if (!isRecord(value)) return {};

  const health: Record<string, CollectorSourceHealth> = {};
  for (const entry of Object.values(value)) {
    const parsed = parseHealth(entry);
    if (parsed !== null) health[parsed.source] = parsed;
  }
  return health;
}

// ---------------------------------------------------------------------------
// Market ticks and round-boundary snapshots (Kalshi/Polymarket/sportsbooks)
// ---------------------------------------------------------------------------

function isMarketSource(value: unknown): value is MarketSource {
  return (
    value === "kalshi" ||
    value === "polymarket" ||
    value === "odds-api-io" ||
    value === "the-odds-api"
  );
}

function isMarketBoundaryType(value: unknown): value is MarketBoundaryType {
  return value === "provisional" || value === "confirmed";
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Parses both live "market-tick" payloads and bootstrap `latestMarkets`
 * entries (a superset shape) — only the fields an OddsQuote/delivery need
 * are validated; unrecognized extra fields are ignored.
 */
function parseMarketTick(value: unknown): MarketTick | null {
  if (
    !isRecord(value) ||
    !isMarketSource(value.source) ||
    typeof value.boutId !== "string" ||
    (value.bookmaker !== undefined && typeof value.bookmaker !== "string") ||
    typeof value.marketType !== "string" ||
    typeof value.outcome !== "string" ||
    !isOptionalFiniteNumber(value.bid) ||
    !isOptionalFiniteNumber(value.ask) ||
    !isOptionalFiniteNumber(value.lastTrade) ||
    !isOptionalFiniteNumber(value.rawOdds) ||
    !isOptionalFiniteNumber(value.impliedProbability) ||
    !isOptionalFiniteNumber(value.noVigProbability) ||
    (value.sourceUpdatedAt !== undefined &&
      !isTimestamp(value.sourceUpdatedAt)) ||
    !isTimestamp(value.receivedAt) ||
    typeof value.stale !== "boolean"
  ) {
    return null;
  }

  return {
    source: value.source,
    boutId: value.boutId,
    ...(value.bookmaker === undefined ? {} : { bookmaker: value.bookmaker }),
    marketType: value.marketType,
    outcome: value.outcome,
    ...(value.bid === undefined ? {} : { bid: value.bid as number }),
    ...(value.ask === undefined ? {} : { ask: value.ask as number }),
    ...(value.lastTrade === undefined
      ? {}
      : { lastTrade: value.lastTrade as number }),
    ...(value.rawOdds === undefined ? {} : { rawOdds: value.rawOdds as number }),
    ...(value.impliedProbability === undefined
      ? {}
      : { impliedProbability: value.impliedProbability as number }),
    ...(value.noVigProbability === undefined
      ? {}
      : { noVigProbability: value.noVigProbability as number }),
    ...(value.sourceUpdatedAt === undefined
      ? {}
      : { sourceUpdatedAt: value.sourceUpdatedAt }),
    receivedAt: value.receivedAt,
    stale: value.stale,
  };
}

function parseMarketSnapshotOutcome(
  value: unknown,
): MarketSnapshotOutcome | null {
  if (
    !isRecord(value) ||
    (value.bookmaker !== undefined && typeof value.bookmaker !== "string") ||
    typeof value.marketType !== "string" ||
    typeof value.outcome !== "string" ||
    !isOptionalFiniteNumber(value.bid) ||
    !isOptionalFiniteNumber(value.ask) ||
    !isOptionalFiniteNumber(value.midpoint) ||
    !isOptionalFiniteNumber(value.spread) ||
    !isOptionalFiniteNumber(value.lastTrade) ||
    !isOptionalFiniteNumber(value.rawOdds) ||
    !isOptionalFiniteNumber(value.impliedProbability) ||
    !isOptionalFiniteNumber(value.noVigProbability) ||
    !isOptionalFiniteNumber(value.volume) ||
    !isOptionalFiniteNumber(value.tickSize) ||
    (value.status !== undefined && typeof value.status !== "string") ||
    (value.sourceUpdatedAt !== undefined &&
      !isTimestamp(value.sourceUpdatedAt)) ||
    !isTimestamp(value.receivedAt) ||
    typeof value.stale !== "boolean" ||
    (value.depth !== undefined &&
      (!isRecord(value.depth) ||
        !Array.isArray(value.depth.bids) ||
        !Array.isArray(value.depth.asks) ||
        !value.depth.bids.every((n) => typeof n === "number") ||
        !value.depth.asks.every((n) => typeof n === "number")))
  ) {
    return null;
  }

  const depth = value.depth as { bids: number[]; asks: number[] } | undefined;

  return {
    ...(value.bookmaker === undefined ? {} : { bookmaker: value.bookmaker }),
    marketType: value.marketType,
    outcome: value.outcome,
    ...(value.bid === undefined ? {} : { bid: value.bid as number }),
    ...(value.ask === undefined ? {} : { ask: value.ask as number }),
    ...(value.midpoint === undefined
      ? {}
      : { midpoint: value.midpoint as number }),
    ...(value.spread === undefined ? {} : { spread: value.spread as number }),
    ...(value.lastTrade === undefined
      ? {}
      : { lastTrade: value.lastTrade as number }),
    ...(value.rawOdds === undefined ? {} : { rawOdds: value.rawOdds as number }),
    ...(value.impliedProbability === undefined
      ? {}
      : { impliedProbability: value.impliedProbability as number }),
    ...(value.noVigProbability === undefined
      ? {}
      : { noVigProbability: value.noVigProbability as number }),
    ...(depth === undefined
      ? {}
      : { depth: { bids: [...depth.bids], asks: [...depth.asks] } }),
    ...(value.volume === undefined ? {} : { volume: value.volume as number }),
    ...(value.tickSize === undefined
      ? {}
      : { tickSize: value.tickSize as number }),
    ...(value.status === undefined ? {} : { status: value.status }),
    ...(value.sourceUpdatedAt === undefined
      ? {}
      : { sourceUpdatedAt: value.sourceUpdatedAt }),
    receivedAt: value.receivedAt,
    stale: value.stale,
  };
}

function parseMarketSnapshot(value: unknown): MarketSnapshot | null {
  if (
    !isRecord(value) ||
    !isMarketSource(value.source) ||
    typeof value.boutId !== "string" ||
    !Number.isSafeInteger(value.round) ||
    (value.round as number) < 1 ||
    !isMarketBoundaryType(value.boundaryType) ||
    (value.label !== undefined &&
      value.label !== "broad-post-round-comparison") ||
    !isTimestamp(value.takenAt) ||
    typeof value.fresh !== "boolean" ||
    !Array.isArray(value.outcomes)
  ) {
    return null;
  }

  const outcomes: MarketSnapshotOutcome[] = [];
  for (const raw of value.outcomes) {
    const outcome = parseMarketSnapshotOutcome(raw);
    if (outcome === null) return null;
    outcomes.push(outcome);
  }

  return {
    source: value.source,
    boutId: value.boutId,
    round: value.round as number,
    boundaryType: value.boundaryType,
    ...(value.label === undefined ? {} : { label: value.label }),
    takenAt: value.takenAt,
    fresh: value.fresh,
    outcomes,
  };
}

/** Which `marketAtEnd` slot a market source's round-boundary snapshot fills. */
function marketAtEndField(
  source: MarketSource,
): keyof CollectorUnifiedRound["marketAtEnd"] {
  if (source === "kalshi") return "kalshi";
  if (source === "polymarket") return "polymarket";
  if (source === "odds-api-io") return "oddsApiIo";
  return "theOddsApi";
}

const STAT_KEYS = [
  "significantStrikes",
  "totalStrikes",
  "takedowns",
  "takedownsAttempted",
  "controlTimeSeconds",
  "knockdowns",
] as const;

function parseFighterStats(
  value: unknown,
): CollectorFighterRoundStats | null {
  if (!isRecord(value)) return null;

  const stats = {} as CollectorFighterRoundStats;
  for (const key of STAT_KEYS) {
    const stat = value[key];
    if (
      typeof stat !== "number" ||
      !Number.isFinite(stat) ||
      stat < 0
    ) {
      return null;
    }
    stats[key] = stat;
  }
  return stats;
}

function parseRoundStats(value: unknown): CollectorRoundStats | null {
  if (!isRecord(value)) return null;
  const fighterA = parseFighterStats(value.fighterA);
  const fighterB = parseFighterStats(value.fighterB);

  if (
    typeof value.boutId !== "string" ||
    !Number.isSafeInteger(value.round) ||
    (value.round as number) < 1 ||
    fighterA === null ||
    fighterB === null ||
    typeof value.provisional !== "boolean" ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    (value.sourceUpdatedAt !== undefined &&
      !isTimestamp(value.sourceUpdatedAt)) ||
    !isTimestamp(value.firstObservedAt) ||
    !isTimestamp(value.lastObservedAt)
  ) {
    return null;
  }

  return {
    boutId: value.boutId,
    round: value.round as number,
    fighterA,
    fighterB,
    provisional: value.provisional,
    revision: value.revision as number,
    ...(value.sourceUpdatedAt === undefined
      ? {}
      : { sourceUpdatedAt: value.sourceUpdatedAt }),
    firstObservedAt: value.firstObservedAt,
    lastObservedAt: value.lastObservedAt,
  };
}

function parseSherdogObservation(
  value: unknown,
): SherdogRoundObservation | null {
  if (
    !isRecord(value) ||
    typeof value.boutId !== "string" ||
    !Number.isSafeInteger(value.round) ||
    (value.round as number) < 1 ||
    typeof value.commentary !== "string" ||
    /<[^>]*>/.test(value.commentary) ||
    (value.aiSummary !== undefined &&
      (typeof value.aiSummary !== "string" ||
        /<[^>]*>/.test(value.aiSummary))) ||
    !Array.isArray(value.scorerCards) ||
    typeof value.sourceUrl !== "string" ||
    (value.publishedAt !== undefined &&
      !isTimestamp(value.publishedAt)) ||
    !isTimestamp(value.fetchedAt) ||
    typeof value.parserVersion !== "string" ||
    typeof value.payloadHash !== "string"
  ) {
    return null;
  }
  const scorerCards = value.scorerCards.flatMap((card) => {
    if (
      !isRecord(card) ||
      typeof card.scorer !== "string" ||
      (card.winner !== undefined && typeof card.winner !== "string") ||
      (card.roundScore !== undefined &&
        typeof card.roundScore !== "string") ||
      (card.cumulativeScore !== undefined &&
        typeof card.cumulativeScore !== "string")
    ) {
      return [];
    }
    return [
      {
        scorer: card.scorer,
        ...(card.winner === undefined ? {} : { winner: card.winner }),
        ...(card.roundScore === undefined
          ? {}
          : { roundScore: card.roundScore }),
        ...(card.cumulativeScore === undefined
          ? {}
          : { cumulativeScore: card.cumulativeScore }),
      },
    ];
  });
  if (scorerCards.length !== value.scorerCards.length) return null;

  return {
    boutId: value.boutId,
    round: value.round as number,
    commentary: value.commentary,
    ...(value.aiSummary === undefined
      ? {}
      : { aiSummary: value.aiSummary as string }),
    scorerCards,
    sourceUrl: value.sourceUrl,
    ...(value.publishedAt === undefined
      ? {}
      : { publishedAt: value.publishedAt }),
    fetchedAt: value.fetchedAt,
    parserVersion: value.parserVersion,
    payloadHash: value.payloadHash,
  };
}

function parseExpertConsensus(value: unknown): ExpertConsensus | null {
  if (!isRecord(value)) return null;
  const result: ExpertConsensus = {};
  for (const source of ["sherdog"] as const) {
    const candidate = value[source];
    if (candidate === undefined) continue;
    if (
      !isRecord(candidate) ||
      candidate.source !== source ||
      !Number.isSafeInteger(candidate.redVotes) ||
      (candidate.redVotes as number) < 0 ||
      !Number.isSafeInteger(candidate.blueVotes) ||
      (candidate.blueVotes as number) < 0 ||
      !Number.isSafeInteger(candidate.drawVotes) ||
      (candidate.drawVotes as number) < 0 ||
      !Number.isSafeInteger(candidate.total) ||
      (candidate.total as number) < 1 ||
      (candidate.leader !== undefined &&
        candidate.leader !== "red" &&
        candidate.leader !== "blue" &&
        candidate.leader !== "draw")
    ) {
      return null;
    }
    result[source] = {
      source,
      redVotes: candidate.redVotes as number,
      blueVotes: candidate.blueVotes as number,
      drawVotes: candidate.drawVotes as number,
      total: candidate.total as number,
      ...(candidate.leader === undefined
        ? {}
        : { leader: candidate.leader }),
    };
  }
  return result;
}

function parseUnifiedRound(value: unknown): CollectorUnifiedRound | null {
  if (!isRecord(value)) return null;
  const citoStats =
    value.citoStats === undefined
      ? undefined
      : parseRoundStats(value.citoStats);
  const sherdog =
    value.sherdog === undefined
      ? undefined
      : parseSherdogObservation(value.sherdog);
  const expertConsensus =
    value.expertConsensus === undefined
      ? undefined
      : parseExpertConsensus(value.expertConsensus);

  if (
    typeof value.boutId !== "string" ||
    !Number.isSafeInteger(value.round) ||
    (value.round as number) < 1 ||
    !isTimestamp(value.detectedEndedAt) ||
    (value.endingSignal !== "clock_zero_provisional" &&
      value.endingSignal !== "period_transition" &&
      value.endingSignal !== "fight_completed") ||
    (value.citoStats !== undefined && citoStats === null) ||
    (value.sherdog !== undefined && sherdog === null) ||
    (value.expertConsensus !== undefined &&
      expertConsensus === null) ||
    !isRecord(value.marketAtEnd) ||
    typeof value.provisional !== "boolean" ||
    (value.finalizedAt !== undefined && !isTimestamp(value.finalizedAt))
  ) {
    return null;
  }

  return {
    boutId: value.boutId,
    round: value.round as number,
    detectedEndedAt: value.detectedEndedAt,
    endingSignal: value.endingSignal,
    ...(citoStats == null ? {} : { citoStats }),
    ...(sherdog == null ? {} : { sherdog }),
    marketAtEnd: value.marketAtEnd as CollectorUnifiedRound["marketAtEnd"],
    ...(expertConsensus == null ? {} : { expertConsensus }),
    provisional: value.provisional,
    ...(value.finalizedAt === undefined
      ? {}
      : { finalizedAt: value.finalizedAt }),
  };
}

function parseBootstrap(value: unknown): CollectorBootstrap | null {
  if (
    !isRecord(value) ||
    (value.state !== null && !isDashboardState(value.state)) ||
    !Array.isArray(value.unifiedRounds) ||
    (value.lifecycleObservations !== undefined &&
      !Array.isArray(value.lifecycleObservations)) ||
    (value.latestMarkets !== undefined && !Array.isArray(value.latestMarkets))
  ) {
    return null;
  }

  return {
    state: value.state,
    health: parseHealthMap(value.health),
    lifecycleObservations: Array.isArray(value.lifecycleObservations)
      ? value.lifecycleObservations
          .map(parseLifecycleObservation)
          .filter(
            (
              observation,
            ): observation is ParsedLifecycleObservation =>
              observation !== null,
          )
      : [],
    unifiedRounds: value.unifiedRounds
      .map(parseUnifiedRound)
      .filter(
        (round): round is CollectorUnifiedRound => round !== null,
      ),
    latestMarkets: Array.isArray(value.latestMarkets)
      ? value.latestMarkets
          .map(parseMarketTick)
          .filter((tick): tick is MarketTick => tick !== null)
      : [],
  };
}

function parseLifecycleObservation(
  value: unknown,
): ParsedLifecycleObservation | null {
  if (
    !isRecord(value) ||
    typeof value.boutId !== "string" ||
    (value.source !== "espn" && value.source !== "cito") ||
    (value.state !== "pre" &&
      value.state !== "in" &&
      value.state !== "post") ||
    !Number.isSafeInteger(value.period) ||
    (value.period as number) < 0 ||
    typeof value.completed !== "boolean" ||
    (value.clockSeconds !== undefined &&
      (typeof value.clockSeconds !== "number" ||
        !Number.isFinite(value.clockSeconds) ||
        value.clockSeconds < 0)) ||
    !isTimestamp(value.receivedAt)
  ) {
    return null;
  }

  return {
    boutId: value.boutId,
    source: value.source,
    state: value.state,
    period: value.period as number,
    completed: value.completed,
    ...(value.clockSeconds === undefined
      ? {}
      : { clockSeconds: value.clockSeconds }),
    receivedAt: value.receivedAt,
  };
}

/**
 * Ticks a stored sync's clock forward to `atReceivedAt`, the same math the
 * browser uses to render the live countdown between polls.
 */
export function interpolateClockSeconds(
  sync: Pick<CollectorClockSync, "clockSeconds" | "receivedAt">,
  now: number,
): number | undefined {
  if (sync.clockSeconds === undefined) return undefined;
  const receivedAt = Date.parse(sync.receivedAt);
  const elapsedSeconds = Number.isFinite(receivedAt)
    ? Math.max(0, Math.floor((now - receivedAt) / 1_000))
    : 0;
  return Math.max(0, Math.floor(sync.clockSeconds) - elapsedSeconds);
}

/**
 * ESPN (and Cito) only actually change their reported round clock every so
 * often — far less often than we poll. Replacing the stored sync on every
 * poll regardless would reset the interpolation baseline each time and make
 * the on-screen countdown visibly stutter back up to the same stale number
 * instead of smoothly ticking down between real updates.
 *
 * A new observation is adopted as the fresh sync point only when it reports
 * the round/fight as over in some capacity (state changed away from "in",
 * `completed` flipped true, or the round number advanced — always
 * authoritative) or when its clock is at or behind what our own countdown
 * would show at the moment it arrived (the source has caught up to, or
 * past, where we already are — the normal case when it's ticking in step
 * with real time). It's only rejected when the source reports a clock
 * *ahead* of where we've already counted down to: the same stale value
 * repeated across polls while our own countdown has moved past it.
 * Otherwise the existing sync is kept as-is and the local clock just keeps
 * counting down.
 */
export function shouldAdoptClockSync(
  existing: CollectorClockSync | undefined,
  candidate: CollectorClockSync,
  candidateReceivedAtMs: number,
): boolean {
  if (existing === undefined) return true;
  if (
    candidate.state !== "in" ||
    candidate.completed ||
    candidate.period !== existing.period
  ) {
    return true;
  }
  if (candidate.clockSeconds === undefined) return false;
  if (existing.clockSeconds === undefined) return true;

  const interpolatedExisting = interpolateClockSeconds(
    existing,
    candidateReceivedAtMs,
  );
  return (
    interpolatedExisting === undefined ||
    candidate.clockSeconds <= interpolatedExisting
  );
}

function clockSyncs(
  observations: readonly ParsedLifecycleObservation[],
  receivedAt: string,
  current: Readonly<Record<string, CollectorClockSync>> = {},
): Record<string, CollectorClockSync> {
  const next = { ...current };
  const receivedAtMs = Date.parse(receivedAt);
  for (const observation of observations) {
    const candidate: CollectorClockSync = {
      boutId: observation.boutId,
      source: observation.source,
      state: observation.state,
      period: observation.period,
      completed: observation.completed,
      ...(observation.clockSeconds === undefined
        ? {}
        : { clockSeconds: observation.clockSeconds }),
      sourceReceivedAt: observation.receivedAt,
      receivedAt,
    };
    if (
      shouldAdoptClockSync(next[observation.boutId], candidate, receivedAtMs)
    ) {
      next[observation.boutId] = candidate;
    }
  }
  return next;
}

function parseLifecycleEvent(
  value: unknown,
): CollectorLifecycleEvent | null {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    typeof value.boutId !== "string" ||
    !isTimestamp(value.detectedAt)
  ) {
    return null;
  }

  if (value.type === "FIGHT_STARTED") {
    return {
      type: value.type,
      boutId: value.boutId,
      detectedAt: value.detectedAt,
    };
  }

  if (
    (value.type === "PROVISIONAL_ROUND_ENDED" ||
      value.type === "FIGHT_ENDED") &&
    Number.isSafeInteger(value.round) &&
    (value.round as number) >= 1
  ) {
    return {
      type: value.type,
      boutId: value.boutId,
      round: value.round as number,
      detectedAt: value.detectedAt,
    };
  }

  if (
    value.type === "ROUND_ENDED" &&
    Number.isSafeInteger(value.round) &&
    (value.round as number) >= 1 &&
    (value.confirmation === "period_transition" ||
      value.confirmation === "fight_completed")
  ) {
    return {
      type: value.type,
      boutId: value.boutId,
      round: value.round as number,
      detectedAt: value.detectedAt,
      confirmation: value.confirmation,
    };
  }

  return null;
}

/** Diacritic/punctuation/case-insensitive comparison key for a free-text name. */
function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]/gu, "")
    .toLocaleLowerCase("en");
}

/**
 * Matches a source's free-text outcome/winner label (a literal "red"/"blue",
 * or a fighter's full or last name) to the bout's corner. Sources disagree
 * on how they identify a fighter, so this is deliberately lenient; returns
 * null rather than guessing when nothing matches.
 */
function matchCorner(rawName: string, bout: Bout): Corner | null {
  const normalized = normalizeName(rawName);
  if (normalized === "red" || normalized === "blue") return normalized;
  return (
    (["red", "blue"] as const).find((corner) => {
      const name = bout.fighters[corner].name;
      const last = name.split(/\s+/).at(-1);
      return (
        normalized === normalizeName(name) ||
        (last !== undefined && normalized === normalizeName(last))
      );
    }) ?? null
  );
}

const MARKET_TO_ODDS_SNAPSHOT: Record<MarketSource, OddsSnapshot["market"]> = {
  kalshi: "kalshi",
  polymarket: "polymarket",
  "odds-api-io": "sportsbook",
  "the-odds-api": "sportsbook",
};

const MARKET_SOURCE_LABEL: Record<MarketSource, string> = {
  kalshi: "Kalshi",
  polymarket: "Polymarket",
  "odds-api-io": "Odds-API.io",
  "the-odds-api": "The Odds API",
};

/** MarketSource and schema.ts SourceId agree except for "the-odds-api". */
function schemaSourceFor(source: MarketSource): SourceId {
  return source === "the-odds-api" ? "odds-api" : source;
}

function midOrFallback(tick: MarketTick): number | undefined {
  if (tick.bid !== undefined && tick.ask !== undefined) {
    return (tick.bid + tick.ask) / 2;
  }
  return tick.lastTrade ?? tick.rawOdds;
}

/** Native price in the market's own units, additive alongside implied probability. */
function nativePriceFor(tick: MarketTick): NativePrice | null {
  if (tick.source === "kalshi") {
    const yes = midOrFallback(tick);
    if (yes === undefined || !Number.isFinite(yes) || yes < 0 || yes > 100) {
      return null;
    }
    return { kind: "kalshi-cents", yesCents: yes, noCents: 100 - yes };
  }
  if (tick.source === "polymarket") {
    const price = midOrFallback(tick);
    if (price === undefined || !Number.isFinite(price) || price < 0 || price > 1) {
      return null;
    }
    return { kind: "polymarket-price", price };
  }
  const moneyline = tick.rawOdds ?? tick.lastTrade;
  if (moneyline === undefined || !Number.isFinite(moneyline) || moneyline === 0) {
    return null;
  }
  return {
    kind: "american-moneyline",
    moneyline,
    book: tick.bookmaker ?? "unknown",
  };
}

function impliedProbabilityFor(
  tick: MarketTick,
  native: NativePrice,
): number | null {
  if (
    tick.impliedProbability !== undefined &&
    Number.isFinite(tick.impliedProbability)
  ) {
    return tick.impliedProbability;
  }
  if (native.kind === "kalshi-cents") return native.yesCents / 100;
  if (native.kind === "polymarket-price") return native.price;
  return americanToImpliedProb(native.moneyline);
}

/** Same quote "slot": same corner, and same book for multi-book sportsbook quotes. */
function quoteKey(quote: OddsQuote): string {
  return quote.native.kind === "american-moneyline"
    ? `${quote.corner}:${quote.native.book}`
    : quote.corner;
}

const MAX_ODDS_HISTORY = 50;

/**
 * Folds one market tick (or a bootstrap `latestMarkets` entry, same shape)
 * into a bout's latestOdds/oddsHistory. "seed" mode (bootstrap) replaces
 * history with the freshly merged snapshot so a batch of seed entries ends
 * on one real point, not a stack of partial-merge artifacts; "append" mode
 * (live ticks) grows the timeline, bounded.
 */
function applyMarketUpdateResult(
  dashboard: DashboardState,
  tick: MarketTick,
  historyMode: "seed" | "append",
): { dashboard: DashboardState; market: OddsSnapshot["market"] } | null {
  const market = MARKET_TO_ODDS_SNAPSHOT[tick.source];
  const view = dashboard.boutViews[tick.boutId];
  if (view === undefined) return null;
  const corner = matchCorner(tick.outcome, view.bout);
  if (corner === null) return null;
  const native = nativePriceFor(tick);
  if (native === null) return null;
  const impliedProbability = impliedProbabilityFor(tick, native);
  if (impliedProbability === null || !Number.isFinite(impliedProbability)) {
    return null;
  }

  const quote: OddsQuote = { corner, native, impliedProbability };
  const key = quoteKey(quote);
  const existingSnapshot = view.latestOdds[market];
  const nextQuotes = [
    ...(existingSnapshot?.quotes.filter((q) => quoteKey(q) !== key) ?? []),
    quote,
  ];
  const nextSnapshot: OddsSnapshot = {
    boutId: tick.boutId,
    market,
    quotes: nextQuotes,
    ...(tick.sourceUpdatedAt === undefined
      ? {}
      : { marketUpdatedAt: tick.sourceUpdatedAt }),
    ...(tick.volume === undefined ? {} : { volume: tick.volume }),
    provenance: {
      source: schemaSourceFor(tick.source),
      fetchedAt: tick.receivedAt,
      synthetic: false,
    },
  };
  const nextHistory =
    historyMode === "append"
      ? [...(view.oddsHistory[market] ?? []), nextSnapshot].slice(
          -MAX_ODDS_HISTORY,
        )
      : [nextSnapshot];

  return {
    market,
    dashboard: {
      ...dashboard,
      boutViews: {
        ...dashboard.boutViews,
        [tick.boutId]: {
          ...view,
          latestOdds: { ...view.latestOdds, [market]: nextSnapshot },
          oddsHistory: { ...view.oddsHistory, [market]: nextHistory },
        },
      },
    },
  };
}

function applyMarketUpdates(
  dashboard: DashboardState | null,
  ticks: readonly MarketTick[],
  historyMode: "seed" | "append",
): {
  dashboard: DashboardState | null;
  deliveries: Record<string, CollectorValueDelivery>;
} {
  let current = dashboard;
  const deliveries: Record<string, CollectorValueDelivery> = {};
  for (const tick of ticks) {
    if (current === null) break;
    const result = applyMarketUpdateResult(current, tick, historyMode);
    if (result === null) continue;
    current = result.dashboard;
    deliveries[`${tick.boutId}:${result.market}`] = {
      source: MARKET_SOURCE_LABEL[tick.source],
      ...(tick.sourceUpdatedAt === undefined
        ? {}
        : { sourceUpdatedAt: tick.sourceUpdatedAt }),
      receivedAt: tick.receivedAt,
      stale: tick.stale,
      provisional: false,
    };
  }
  return { dashboard: current, deliveries };
}

function replaceBout(
  dashboard: DashboardState,
  boutId: string,
  update: (bout: Bout) => Bout,
): DashboardState {
  const currentView = dashboard.boutViews[boutId];
  if (currentView === undefined) return dashboard;
  const nextBout = update(currentView.bout);

  return {
    ...dashboard,
    event: {
      ...dashboard.event,
      bouts: dashboard.event.bouts.map((bout) =>
        bout.id === boutId ? nextBout : bout,
      ),
    },
    boutViews: {
      ...dashboard.boutViews,
      [boutId]: {
        ...currentView,
        bout: nextBout,
      },
    },
  };
}

export function applyCollectorLifecycle(
  dashboard: DashboardState,
  event: CollectorLifecycleEvent,
): DashboardState {
  return replaceBout(dashboard, event.boutId, (bout) => {
    switch (event.type) {
      case "FIGHT_STARTED":
        return {
          ...bout,
          status: "in-round",
          currentRound: bout.currentRound ?? 1,
        };
      case "PROVISIONAL_ROUND_ENDED":
      case "ROUND_ENDED":
        return {
          ...bout,
          status: "between-rounds",
          currentRound: event.round,
        };
      case "FIGHT_ENDED":
        return {
          ...bout,
          status: "final",
          currentRound: event.round,
        };
    }
  });
}

function applyCollectorObservations(
  dashboard: DashboardState,
  observations: readonly ParsedLifecycleObservation[],
): DashboardState {
  return observations.reduce((current, observation) => {
    return replaceBout(current, observation.boutId, (bout) => {
      if (observation.state === "pre") {
        return { ...bout, status: "upcoming" };
      }
      if (observation.state === "post" || observation.completed) {
        return {
          ...bout,
          status: "final",
          ...(observation.period > 0
            ? { currentRound: observation.period }
            : {}),
        };
      }
      return {
        ...bout,
        status:
          observation.clockSeconds === 0
            ? "between-rounds"
            : "in-round",
        ...(observation.period > 0
          ? { currentRound: observation.period }
          : {}),
      };
    });
  }, dashboard);
}

function applyCollectorRound(
  dashboard: DashboardState,
  record: CollectorUnifiedRound,
): DashboardState {
  const withLifecycle = replaceBout(
    dashboard,
    record.boutId,
    (bout) => {
      if (
        bout.status === "final" ||
        bout.status === "canceled" ||
        bout.status === "postponed"
      ) {
        return bout;
      }
      return {
        ...bout,
        status:
          record.endingSignal === "fight_completed"
            ? "final"
            : "between-rounds",
        currentRound: record.round,
      };
    },
  );
  const view = withLifecycle.boutViews[record.boutId];
  if (view === undefined) return withLifecycle;

  const nextRounds = { ...view.rounds };
  if (record.citoStats !== undefined) {
    const stats = record.citoStats;
    const existing = view.rounds.cito ?? [];
    const previous = existing.find(
      (round) => round.round === record.round,
    );
    const update: RoundUpdate = {
      ...(previous ?? {
        boutId: record.boutId,
        round: record.round,
      }),
      stats: {
        red: { ...stats.fighterA },
        blue: { ...stats.fighterB },
      },
      provenance: {
        source: "cito",
        fetchedAt: stats.lastObservedAt,
        synthetic: withLifecycle.event.provenance.synthetic,
      },
    };
    nextRounds.cito = [
      ...existing.filter((round) => round.round !== record.round),
      update,
    ].sort((left, right) => left.round - right.round);
  }

  if (record.sherdog !== undefined) {
    const observation = record.sherdog;
    const existing = view.rounds.sherdog ?? [];
    const scoreCard = observation.scorerCards.find(
      (card) => card.roundScore !== undefined && card.winner !== undefined,
    );
    const scoreMatch = /^(\d+)\s*-\s*(\d+)$/.exec(
      scoreCard?.roundScore ?? "",
    );
    const winner =
      scoreCard?.winner === undefined
        ? undefined
        : (matchCorner(scoreCard.winner, view.bout) ?? undefined);
    const high = Number(scoreMatch?.[1]);
    const low = Number(scoreMatch?.[2]);
    const summaryText =
      observation.aiSummary?.trim() ?? observation.commentary;
    const update: RoundUpdate = {
      boutId: record.boutId,
      round: record.round,
      // The condensed summary is what the five-line box is sized for; the raw
      // commentary is the fallback when summarizing is off or failed.
      ...(summaryText.length === 0 ? {} : { summary: summaryText }),
      ...(winner === undefined ||
      !Number.isFinite(high) ||
      !Number.isFinite(low)
        ? {}
        : {
            score:
              winner === "red"
                ? { red: high, blue: low }
                : { red: low, blue: high },
          }),
      provenance: {
        source: "sherdog",
        fetchedAt: observation.fetchedAt,
        synthetic: withLifecycle.event.provenance.synthetic,
      },
    };
    nextRounds.sherdog = [
      ...existing.filter((round) => round.round !== record.round),
      update,
    ].sort((left, right) => left.round - right.round);
  }

  return {
    ...withLifecycle,
    boutViews: {
      ...withLifecycle.boutViews,
      [record.boutId]: {
        ...view,
        rounds: nextRounds,
      },
    },
  };
}

function applyCollectorRounds(
  dashboard: DashboardState | null,
  records: readonly CollectorUnifiedRound[],
): DashboardState | null {
  return records.reduce<DashboardState | null>(
    (state, record) =>
      state === null ? null : applyCollectorRound(state, record),
    dashboard,
  );
}

function upsertRound(
  rounds: readonly CollectorUnifiedRound[],
  record: CollectorUnifiedRound,
): CollectorUnifiedRound[] {
  return [
    ...rounds.filter(
      (round) =>
        round.boutId !== record.boutId || round.round !== record.round,
    ),
    record,
  ].sort(
    (left, right) =>
      left.boutId.localeCompare(right.boutId) ||
      left.round - right.round,
  );
}

export function collectorBaseUrl(explicit?: string): string {
  const configured =
    explicit ??
    import.meta.env.VITE_COLLECTOR_URL ??
    `http://localhost:${DEFAULT_COLLECTOR_PORT}`;
  return configured.replace(/\/+$/, "");
}

function eventData(event: Event): unknown {
  if (!("data" in event) || typeof event.data !== "string") return null;
  try {
    return JSON.parse(event.data) as unknown;
  } catch {
    return null;
  }
}

export function getCollectorRoundDelivery(
  snapshot: CollectorSnapshot | undefined,
  boutId: string,
  round: number,
): CollectorValueDelivery | undefined {
  const record = snapshot?.unifiedRounds.find(
    (candidate) =>
      candidate.boutId === boutId && candidate.round === round,
  );
  if (record === undefined) return undefined;
  const stats = record.citoStats;
  const citoHealth = snapshot?.health.cito;

  return {
    source: stats === undefined ? "collector lifecycle" : "Cito",
    ...(stats?.sourceUpdatedAt === undefined
      ? { sourceUpdatedAt: record.detectedEndedAt }
      : { sourceUpdatedAt: stats.sourceUpdatedAt }),
    receivedAt: stats?.lastObservedAt ?? snapshot?.lastReceivedAt ??
      record.detectedEndedAt,
    stale:
      snapshot?.connection !== "connected" ||
      citoHealth?.fresh === false,
    provisional: record.provisional || stats?.provisional === true,
    ...(stats === undefined ? {} : { revision: stats.revision }),
  };
}

/** Delivery/freshness for the latest odds shown in a given market bucket. */
export function getCollectorMarketDelivery(
  snapshot: CollectorSnapshot | undefined,
  boutId: string,
  market: OddsSnapshot["market"],
): CollectorValueDelivery | undefined {
  return snapshot?.marketDeliveries[`${boutId}:${market}`];
}

export function createCollectorClient(
  options: CollectorClientOptions = {},
): CollectorClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const createEventSource =
    options.createEventSource ??
    ((url: string) => new EventSource(url));
  const now = options.now ?? (() => new Date().toISOString());
  const timeoutMs = options.bootstrapTimeoutMs ?? 1_500;
  const baseUrl = collectorBaseUrl(options.baseUrl);
  const listeners = new Set<(snapshot: CollectorSnapshot) => void>();
  let eventSource: EventSourceLike | undefined;
  let abortController: AbortController | undefined;
  let closed = false;
  let snapshot: CollectorSnapshot = {
    connection: "unavailable",
    dashboard: null,
    health: {},
    unifiedRounds: [],
    lifecycle: {},
    clocks: {},
    marketDeliveries: {},
  };

  const publish = (next: CollectorSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };

  const receiveBootstrap = (
    bootstrap: CollectorBootstrap,
    receivedAt: string,
  ): void => {
    const dashboardWithRounds = applyCollectorRounds(
      bootstrap.state,
      bootstrap.unifiedRounds,
    );
    const dashboardWithLifecycle =
      dashboardWithRounds === null
        ? null
        : applyCollectorObservations(
            dashboardWithRounds,
            bootstrap.lifecycleObservations,
          );
    const { dashboard, deliveries } = applyMarketUpdates(
      dashboardWithLifecycle,
      bootstrap.latestMarkets,
      "seed",
    );
    publish({
      ...snapshot,
      connection: "connected",
      dashboard,
      health: bootstrap.health,
      clocks: clockSyncs(bootstrap.lifecycleObservations, receivedAt),
      unifiedRounds: bootstrap.unifiedRounds,
      marketDeliveries: deliveries,
      lastReceivedAt: receivedAt,
    });
  };

  const receiveHealth = (
    health: CollectorSourceHealth,
    receivedAt: string,
  ): void => {
    publish({
      ...snapshot,
      connection: "connected",
      health: {
        ...snapshot.health,
        [health.source]: health,
      },
      lastReceivedAt: receivedAt,
    });
  };

  const receiveUpdate = (value: unknown, receivedAt: string): void => {
    if (!isRecord(value)) return;

    if (value.kind === "lifecycle") {
      const event = parseLifecycleEvent(value.event);
      if (event === null) return;
      publish({
        ...snapshot,
        connection: "connected",
        dashboard:
          snapshot.dashboard === null
            ? null
            : applyCollectorLifecycle(snapshot.dashboard, event),
        lifecycle: {
          ...snapshot.lifecycle,
          [event.boutId]: {
            boutId: event.boutId,
            source: "collector lifecycle",
            sourceUpdatedAt: event.detectedAt,
            receivedAt,
            provisional:
              event.type === "FIGHT_STARTED" ||
              event.type === "PROVISIONAL_ROUND_ENDED",
          },
        },
        lastReceivedAt: receivedAt,
      });
      return;
    }

    if (
      value.kind === "lifecycle-observations" &&
      Array.isArray(value.observations)
    ) {
      const observations = value.observations
        .map(parseLifecycleObservation)
        .filter(
          (
            observation,
          ): observation is ParsedLifecycleObservation =>
            observation !== null,
        );
      if (observations.length === 0) return;
      publish({
        ...snapshot,
        connection: "connected",
        dashboard:
          snapshot.dashboard === null
            ? null
            : applyCollectorObservations(
                snapshot.dashboard,
                observations,
              ),
        clocks: clockSyncs(
          observations,
          receivedAt,
          snapshot.clocks,
        ),
        lastReceivedAt: receivedAt,
      });
      return;
    }

    if (value.kind === "round") {
      const record = parseUnifiedRound(value.record);
      if (record === null) return;
      const unifiedRounds = upsertRound(snapshot.unifiedRounds, record);
      publish({
        ...snapshot,
        connection: "connected",
        dashboard:
          snapshot.dashboard === null
            ? null
            : applyCollectorRound(snapshot.dashboard, record),
        unifiedRounds,
        lastReceivedAt: receivedAt,
      });
      return;
    }

    if (value.kind === "market-tick") {
      const tick = parseMarketTick(value.tick);
      if (tick === null) return;
      const { dashboard, deliveries } = applyMarketUpdates(
        snapshot.dashboard,
        [tick],
        "append",
      );
      publish({
        ...snapshot,
        connection: "connected",
        dashboard,
        marketDeliveries: { ...snapshot.marketDeliveries, ...deliveries },
        lastReceivedAt: receivedAt,
      });
      return;
    }

    if (value.kind === "market-snapshot") {
      const record = parseMarketSnapshot(value.snapshot);
      if (record === null) return;
      const field = marketAtEndField(record.source);
      const unifiedRounds = snapshot.unifiedRounds.map((round) =>
        round.boutId === record.boutId && round.round === record.round
          ? {
              ...round,
              marketAtEnd: { ...round.marketAtEnd, [field]: record },
            }
          : round,
      );
      publish({
        ...snapshot,
        connection: "connected",
        unifiedRounds,
        lastReceivedAt: receivedAt,
      });
    }
  };

  const listen = (
    type: "bootstrap" | "health" | "update",
    handler: (value: unknown, receivedAt: string) => void,
  ): void => {
    eventSource?.addEventListener(type, ((event: Event) => {
      const value = eventData(event);
      if (value !== null) handler(value, now());
    }) as EventListener);
  };

  return {
    getSnapshot() {
      return snapshot;
    },
    async start() {
      if (closed) return;
      publish({ ...snapshot, connection: "reconnecting" });
      abortController = new AbortController();
      const timeout = setTimeout(
        () => abortController?.abort(),
        timeoutMs,
      );

      try {
        const response = await fetchImpl(`${baseUrl}/api/bootstrap`, {
          headers: { Accept: "application/json" },
          signal: abortController.signal,
        });
        if (!response.ok) {
          throw new Error(`Collector bootstrap failed (${response.status})`);
        }
        const bootstrap = parseBootstrap(await response.json());
        if (bootstrap === null) {
          throw new Error("Collector bootstrap was not normalized");
        }
        if (closed) return;
        receiveBootstrap(bootstrap, now());
      } catch {
        if (!closed) {
          publish({ ...snapshot, connection: "unavailable" });
        }
        return;
      } finally {
        clearTimeout(timeout);
        abortController = undefined;
      }

      try {
        eventSource = createEventSource(`${baseUrl}/api/events`);
        eventSource.onopen = () => {
          if (!closed) publish({ ...snapshot, connection: "connected" });
        };
        eventSource.onerror = () => {
          if (!closed) {
            publish({
              ...snapshot,
              connection:
                snapshot.dashboard === null
                  ? "unavailable"
                  : "reconnecting",
            });
          }
        };
        listen("bootstrap", (value, receivedAt) => {
          const bootstrap = parseBootstrap(value);
          if (bootstrap !== null) receiveBootstrap(bootstrap, receivedAt);
        });
        listen("health", (value, receivedAt) => {
          const health = parseHealth(value);
          if (health !== null) receiveHealth(health, receivedAt);
        });
        listen("update", receiveUpdate);
      } catch {
        publish({ ...snapshot, connection: "unavailable" });
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      abortController?.abort();
      eventSource?.close();
      listeners.clear();
    },
  };
}
