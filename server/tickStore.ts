import { americanToImpliedProb, devigPair } from "../src/lib/oddsMath.ts";
import type {
  MarketBoundaryType,
  MarketSnapshot,
  MarketSnapshotLabel,
  MarketSnapshotOutcome,
  MarketSource,
  MarketTick,
  TickHistorySource,
} from "../src/sources/contract.ts";
import type {
  CollectorEvent,
  CollectorEventBus,
} from "./eventBus.ts";
import type { ProvisionalRoundSupersession } from "./lifecycle.ts";
import { NOOP_METRICS, type Metrics } from "./health.ts";
import type { Storage } from "./storage.ts";

export type {
  MarketBoundaryType,
  MarketSnapshot,
  MarketSnapshotLabel,
  MarketSnapshotOutcome,
  MarketSource,
  MarketTick,
} from "../src/sources/contract.ts";

export const MARKET_TICKS_STORAGE_STREAM = "market-ticks";
export const MARKET_SNAPSHOTS_STORAGE_STREAM = "market-snapshots";
export const MARKET_FRESHNESS_STORAGE_STREAM = "market-freshness";
export const DEFAULT_MARKET_STALE_AFTER_MS = 30_000;
/** Persist sampled state: durable writes are throttled to roughly once per key. */
export const DEFAULT_PERSIST_INTERVAL_MS = 1_000;

export interface TickStoreClock {
  now(): number;
}

export interface TickStoreTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LocalOrderBookState extends MarketSnapshotOutcome {
  source: MarketSource;
  boutId: string;
  fresh: boolean;
  depth: {
    bids: number[];
    asks: number[];
  };
  volume?: number;
}

export interface MarketTickStoreOptions {
  eventBus: CollectorEventBus;
  storage: Storage;
  staleAfterMs?: number;
  clock?: TickStoreClock;
  /**
   * Throttles durable persistence of ticks to roughly once per this many
   * milliseconds, per book key (source/boutId/bookmaker/marketType/outcome).
   * In-memory state (`latest`, `history`) is always applied immediately for
   * UI freshness; only the write to `storage` is sampled. The most recent
   * tick for a key is never dropped — a trailing write is scheduled so it
   * eventually lands even without further ticks. `0` disables sampling.
   */
  persistIntervalMs?: number;
  timer?: TickStoreTimer;
  publish?: (snapshot: MarketSnapshot) => Promise<void>;
  onSnapshot?: (snapshot: MarketSnapshot) => Promise<void>;
  onSnapshotsRemoved?: (
    boutId: string,
    round: number,
    boundaryType: MarketBoundaryType,
  ) => Promise<void>;
  metrics?: Metrics;
}

interface PersistedTick {
  version: 1;
  tick: MarketTick;
}

interface PersistedSnapshot {
  version: 1;
  snapshot: MarketSnapshot;
}

interface SourceFreshnessRecord {
  version: 1;
  source: MarketSource;
  fresh: boolean;
  changedAt: string;
}

interface BookState {
  source: MarketSource;
  boutId: string;
  bookmaker?: string;
  marketType: string;
  outcome: string;
  bid?: number;
  ask?: number;
  lastTrade?: number;
  rawOdds?: number;
  suppliedImpliedProbability?: number;
  depth?: {
    bids: number[];
    asks: number[];
  };
  volume?: number;
  tickSize?: number;
  status?: string;
  sourceUpdatedAt?: string;
  receivedAt: string;
  tickStale: boolean;
}

type RoundBoundaryEvent = Extract<
  CollectorEvent,
  { type: "PROVISIONAL_ROUND_ENDED" | "ROUND_ENDED" }
>;

const SOURCES = new Set<MarketSource>([
  "kalshi",
  "polymarket",
  "odds-api-io",
  "the-odds-api",
]);

const TICK_KEYS = new Set([
  "source",
  "boutId",
  "bookmaker",
  "marketType",
  "outcome",
  "bid",
  "ask",
  "lastTrade",
  "rawOdds",
  "impliedProbability",
  "noVigProbability",
  "depth",
  "volume",
  "tickSize",
  "status",
  "sourceUpdatedAt",
  "receivedAt",
  "stale",
]);

const DEFAULT_TICK_STORE_TIMER: TickStoreTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${field} must be a valid ISO-8601 timestamp`);
  }
  return parsed;
}

function validateFinite(
  value: number | undefined,
  field: string,
): void {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number`);
  }
}

function validateProbability(
  value: number | undefined,
  field: string,
): void {
  validateFinite(value, field);
  if (value !== undefined && (value < 0 || value > 1)) {
    throw new TypeError(`${field} must be between 0 and 1`);
  }
}

function validateTick(value: MarketTick): void {
  if (!isRecord(value)) {
    throw new TypeError("tick must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!TICK_KEYS.has(key)) {
      throw new TypeError(`tick contains unsupported field "${key}"`);
    }
  }
  if (!SOURCES.has(value.source)) {
    throw new TypeError("tick source is unsupported");
  }
  for (const [field, text] of [
    ["boutId", value.boutId],
    ["marketType", value.marketType],
    ["outcome", value.outcome],
  ] as const) {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new TypeError(`${field} must not be empty`);
    }
  }
  if (
    value.bookmaker !== undefined &&
    (typeof value.bookmaker !== "string" ||
      value.bookmaker.trim().length === 0)
  ) {
    throw new TypeError("bookmaker must not be empty");
  }
  for (const [field, price] of [
    ["bid", value.bid],
    ["ask", value.ask],
    ["lastTrade", value.lastTrade],
    ["rawOdds", value.rawOdds],
  ] as const) {
    validateFinite(price, field);
  }
  if (
    value.bid !== undefined &&
    value.ask !== undefined &&
    (value.source === "kalshi" || value.source === "polymarket") &&
    value.ask < value.bid
  ) {
    throw new TypeError("ask must not be below bid");
  }
  const exchangeLimit = value.source === "kalshi" ? 100 : 1;
  if (value.source === "kalshi" || value.source === "polymarket") {
    for (const [field, price] of [
      ["bid", value.bid],
      ["ask", value.ask],
      ["lastTrade", value.lastTrade],
    ] as const) {
      if (price !== undefined && (price < 0 || price > exchangeLimit)) {
        throw new TypeError(
          `${field} must be between 0 and ${exchangeLimit}`,
        );
      }
    }
  }
  if (
    (value.source === "odds-api-io" ||
      value.source === "the-odds-api") &&
    value.rawOdds === 0
  ) {
    throw new TypeError("rawOdds cannot be zero for American odds");
  }
  validateProbability(value.impliedProbability, "impliedProbability");
  validateProbability(value.noVigProbability, "noVigProbability");
  if (value.depth !== undefined) {
    if (
      !isRecord(value.depth) ||
      !Array.isArray(value.depth.bids) ||
      !Array.isArray(value.depth.asks)
    ) {
      throw new TypeError("depth must contain bid and ask arrays");
    }
    for (const [field, levels] of [
      ["depth.bids", value.depth.bids],
      ["depth.asks", value.depth.asks],
    ] as const) {
      for (const level of levels) {
        validateFinite(level, field);
        if (level < 0 || level > exchangeLimit) {
          throw new TypeError(
            `${field} values must be between 0 and ${exchangeLimit}`,
          );
        }
      }
    }
  }
  validateFinite(value.volume, "volume");
  if (value.volume !== undefined && value.volume < 0) {
    throw new TypeError("volume must not be negative");
  }
  validateFinite(value.tickSize, "tickSize");
  if (value.tickSize !== undefined && value.tickSize <= 0) {
    throw new TypeError("tickSize must be positive");
  }
  if (
    value.status !== undefined &&
    (typeof value.status !== "string" ||
      value.status.trim().length === 0)
  ) {
    throw new TypeError("status must not be empty");
  }
  if (typeof value.stale !== "boolean") {
    throw new TypeError("stale must be a boolean");
  }
  timestamp(value.receivedAt, "receivedAt");
  if (value.sourceUpdatedAt !== undefined) {
    timestamp(value.sourceUpdatedAt, "sourceUpdatedAt");
  }
  if (
    value.bid === undefined &&
    value.ask === undefined &&
    value.lastTrade === undefined &&
    value.rawOdds === undefined &&
    value.impliedProbability === undefined &&
    value.status === undefined
  ) {
    throw new TypeError("tick must contain a price or lifecycle status");
  }
}

function isMarketTick(value: unknown): value is MarketTick {
  try {
    validateTick(value as MarketTick);
    return true;
  } catch {
    return false;
  }
}

function isPersistedTick(value: unknown): value is PersistedTick {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isMarketTick(value.tick)
  );
}

function isSnapshotOutcome(value: unknown): value is MarketSnapshotOutcome {
  return (
    isRecord(value) &&
    typeof value.marketType === "string" &&
    typeof value.outcome === "string" &&
    typeof value.receivedAt === "string" &&
    typeof value.stale === "boolean"
  );
}

function isMarketSnapshot(value: unknown): value is MarketSnapshot {
  const isPreFight = value !== null &&
    typeof value === "object" &&
    (value as { boundaryType?: unknown }).boundaryType === "pre-fight";
  return (
    isRecord(value) &&
    SOURCES.has(value.source as MarketSource) &&
    typeof value.boutId === "string" &&
    Number.isSafeInteger(value.round) &&
    (isPreFight ? value.round === 0 : (value.round as number) >= 1) &&
    (isPreFight
      ? value.round === 0 &&
        (value.label === undefined || value.label === "pre-fight-open")
      : (value.round as number) >= 1 &&
        (value.boundaryType === "provisional" ||
          value.boundaryType === "confirmed") &&
        (value.label === undefined ||
          value.label === "broad-post-round-comparison")) &&
    typeof value.takenAt === "string" &&
    typeof value.fresh === "boolean" &&
    Array.isArray(value.outcomes) &&
    value.outcomes.every(isSnapshotOutcome)
  );
}

function isPersistedSnapshot(value: unknown): value is PersistedSnapshot {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isMarketSnapshot(value.snapshot)
  );
}

function isFreshnessRecord(
  value: unknown,
): value is SourceFreshnessRecord {
  return (
    isRecord(value) &&
    value.version === 1 &&
    SOURCES.has(value.source as MarketSource) &&
    typeof value.fresh === "boolean" &&
    typeof value.changedAt === "string" &&
    Number.isFinite(Date.parse(value.changedAt))
  );
}

function copyTick(tick: MarketTick): MarketTick {
  return {
    ...tick,
    ...(tick.depth === undefined
      ? {}
      : {
          depth: {
            bids: [...tick.depth.bids],
            asks: [...tick.depth.asks],
          },
        }),
  };
}

function copyOutcome(outcome: MarketSnapshotOutcome): MarketSnapshotOutcome {
  return {
    ...outcome,
    ...(outcome.depth === undefined
      ? {}
      : {
          depth: {
            bids: [...outcome.depth.bids],
            asks: [...outcome.depth.asks],
          },
        }),
  };
}

function copySnapshot(snapshot: MarketSnapshot): MarketSnapshot {
  return {
    ...snapshot,
    outcomes: snapshot.outcomes.map(copyOutcome),
  };
}

function bookKey(tick: {
  source: MarketSource;
  boutId: string;
  bookmaker?: string;
  marketType: string;
  outcome: string;
}): string {
  return JSON.stringify([
    tick.source,
    tick.boutId,
    tick.bookmaker ?? null,
    tick.marketType,
    tick.outcome,
  ]);
}

/**
 * Drops everything a "confirmed" boundary at `boundaryTime` can prove is
 * unreachable by any future boundary for `boutId`, while preserving every
 * key's ability to still carry forward a "last known state" — a market that
 * goes quiet for a round must not lose its most recent price just because
 * that price predates this boundary. Concretely: keep every tick strictly
 * after `boundaryTime`, plus — per book key — only the single most recent
 * tick at or before it (older ticks for that key are provably superseded,
 * since `applyTick`/`shouldReplace` never prefers an older tick anyway).
 * Ticks for other bouts are untouched.
 */
function prunedHistoryAfterConfirmedBoundary(
  history: readonly MarketTick[],
  boutId: string,
  boundaryTime: number,
): MarketTick[] {
  const other: MarketTick[] = [];
  const after: MarketTick[] = [];
  const latestAtOrBeforeByKey = new Map<string, MarketTick>();
  for (const tick of history) {
    if (tick.boutId !== boutId) {
      other.push(tick);
      continue;
    }
    if (Date.parse(tick.receivedAt) > boundaryTime) {
      after.push(tick);
      continue;
    }
    const key = bookKey(tick);
    const current = latestAtOrBeforeByKey.get(key);
    if (
      current === undefined ||
      Date.parse(tick.receivedAt) > Date.parse(current.receivedAt)
    ) {
      latestAtOrBeforeByKey.set(key, tick);
    }
  }
  return [...other, ...latestAtOrBeforeByKey.values(), ...after];
}

function pairedMarketKey(state: {
  source: MarketSource;
  boutId: string;
  bookmaker?: string;
  marketType: string;
}): string {
  return JSON.stringify([
    state.source,
    state.boutId,
    state.bookmaker ?? null,
    state.marketType,
  ]);
}

function snapshotKey(snapshot: {
  boutId: string;
  round: number;
  source: MarketSource;
  boundaryType: MarketBoundaryType;
}): string {
  return JSON.stringify([
    snapshot.boutId,
    snapshot.round,
    snapshot.source,
    snapshot.boundaryType,
  ]);
}

function copyBook(state: BookState): BookState {
  return {
    ...state,
    ...(state.depth === undefined
      ? {}
      : {
          depth: {
            bids: [...state.depth.bids],
            asks: [...state.depth.asks],
          },
        }),
  };
}

function shouldReplace(previous: BookState, tick: MarketTick): boolean {
  if (
    previous.sourceUpdatedAt !== undefined &&
    tick.sourceUpdatedAt !== undefined
  ) {
    const sourceDifference =
      timestamp(tick.sourceUpdatedAt, "sourceUpdatedAt") -
      timestamp(previous.sourceUpdatedAt, "previous sourceUpdatedAt");
    return (
      sourceDifference > 0 ||
      (sourceDifference === 0 &&
        timestamp(tick.receivedAt, "receivedAt") >=
          timestamp(previous.receivedAt, "previous receivedAt"))
    );
  }
  if (
    previous.sourceUpdatedAt !== undefined &&
    tick.sourceUpdatedAt === undefined
  ) {
    return false;
  }
  return (
    timestamp(tick.receivedAt, "receivedAt") >=
    timestamp(previous.receivedAt, "previous receivedAt")
  );
}

function applyTick(
  states: Map<string, BookState>,
  tick: MarketTick,
): BookState {
  const key = bookKey(tick);
  const previous = states.get(key);
  if (previous !== undefined && !shouldReplace(previous, tick)) {
    return previous;
  }
  // Older persisted Kalshi ticker records may contain the post-close 0/100
  // sentinel. It means there is no tradable quote; treating its midpoint as
  // 50% corrupts the terminal market state. The transport now strips this
  // pair, and this restore-time guard repairs data written before that fix.
  const kalshiQuoteIsClosed =
    tick.source === "kalshi" && tick.bid === 0 && tick.ask === 100;
  const incomingBid = kalshiQuoteIsClosed ? undefined : tick.bid;
  const incomingAsk = kalshiQuoteIsClosed ? undefined : tick.ask;
  const incomingImpliedProbability = kalshiQuoteIsClosed
    ? undefined
    : tick.impliedProbability;
  const next: BookState = {
    ...(previous === undefined ? {} : copyBook(previous)),
    source: tick.source,
    boutId: tick.boutId,
    ...(tick.bookmaker === undefined
      ? previous?.bookmaker === undefined
        ? {}
        : { bookmaker: previous.bookmaker }
      : { bookmaker: tick.bookmaker }),
    marketType: tick.marketType,
    outcome: tick.outcome,
    ...(incomingBid === undefined
      ? previous?.bid === undefined
        ? {}
        : { bid: previous.bid }
      : { bid: incomingBid }),
    ...(incomingAsk === undefined
      ? previous?.ask === undefined
        ? {}
        : { ask: previous.ask }
      : { ask: incomingAsk }),
    ...(tick.lastTrade === undefined
      ? previous?.lastTrade === undefined
        ? {}
        : { lastTrade: previous.lastTrade }
      : { lastTrade: tick.lastTrade }),
    ...(tick.rawOdds === undefined
      ? previous?.rawOdds === undefined
        ? {}
        : { rawOdds: previous.rawOdds }
      : { rawOdds: tick.rawOdds }),
    ...(incomingImpliedProbability === undefined
      ? previous?.suppliedImpliedProbability === undefined
        ? {}
        : {
            suppliedImpliedProbability:
              previous.suppliedImpliedProbability,
          }
      : { suppliedImpliedProbability: incomingImpliedProbability }),
    ...(tick.depth === undefined
      ? previous?.depth === undefined
        ? {}
        : {
            depth: {
              bids: [...previous.depth.bids],
              asks: [...previous.depth.asks],
            },
          }
      : {
          depth: {
            bids: [...tick.depth.bids],
            asks: [...tick.depth.asks],
          },
        }),
    ...(tick.volume === undefined
      ? previous?.volume === undefined
        ? {}
        : { volume: previous.volume }
      : { volume: tick.volume }),
    ...(tick.tickSize === undefined
      ? previous?.tickSize === undefined
        ? {}
        : { tickSize: previous.tickSize }
      : { tickSize: tick.tickSize }),
    ...(tick.status === undefined
      ? previous?.status === undefined
        ? {}
        : { status: previous.status }
      : { status: tick.status }),
    ...(tick.sourceUpdatedAt === undefined
      ? previous?.sourceUpdatedAt === undefined
        ? {}
        : { sourceUpdatedAt: previous.sourceUpdatedAt }
      : { sourceUpdatedAt: tick.sourceUpdatedAt }),
    receivedAt: tick.receivedAt,
    tickStale: tick.stale,
  };
  states.set(key, next);
  return next;
}

function nativeProbability(source: MarketSource, price: number): number | undefined {
  if (source === "kalshi") {
    const probability = price / 100;
    return probability >= 0 && probability <= 1
      ? probability
      : undefined;
  }
  if (source === "polymarket") {
    return price >= 0 && price <= 1 ? price : undefined;
  }
  if (price === 0) return undefined;
  const probability = americanToImpliedProb(price);
  return probability >= 0 && probability <= 1
    ? probability
    : undefined;
}

function sourceFreshAt(
  records: readonly SourceFreshnessRecord[],
  source: MarketSource,
  at: number,
): boolean {
  let fresh = true;
  let latest = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    const changedAt = Date.parse(record.changedAt);
    if (
      record.source === source &&
      changedAt <= at &&
      changedAt >= latest
    ) {
      fresh = record.fresh;
      latest = changedAt;
    }
  }
  return fresh;
}

function stateStale(
  state: BookState,
  at: number,
  staleAfterMs: number,
  sourceIsFresh: boolean,
): boolean {
  const age = Math.max(0, at - Date.parse(state.receivedAt));
  return state.tickStale || !sourceIsFresh || age > staleAfterMs;
}

function outcomeFromState(
  state: BookState,
  stale: boolean,
): MarketSnapshotOutcome {
  const hasBook = state.bid !== undefined && state.ask !== undefined;
  const midpoint = hasBook
    ? ((state.bid as number) + (state.ask as number)) / 2
    : undefined;
  const spread = hasBook
    ? (state.ask as number) - (state.bid as number)
    : undefined;
  const impliedProbability =
    midpoint !== undefined
      ? nativeProbability(state.source, midpoint)
      : state.rawOdds !== undefined
        ? nativeProbability(state.source, state.rawOdds)
        : state.suppliedImpliedProbability !== undefined
          ? state.suppliedImpliedProbability
          : !stale && state.lastTrade !== undefined
            ? nativeProbability(state.source, state.lastTrade)
            : undefined;

  return {
    ...(state.bookmaker === undefined
      ? {}
      : { bookmaker: state.bookmaker }),
    marketType: state.marketType,
    outcome: state.outcome,
    ...(state.bid === undefined ? {} : { bid: state.bid }),
    ...(state.ask === undefined ? {} : { ask: state.ask }),
    ...(midpoint === undefined ? {} : { midpoint }),
    ...(spread === undefined ? {} : { spread }),
    ...(state.lastTrade === undefined
      ? {}
      : { lastTrade: state.lastTrade }),
    ...(state.rawOdds === undefined ? {} : { rawOdds: state.rawOdds }),
    ...(impliedProbability === undefined
      ? {}
      : { impliedProbability }),
    ...(state.depth === undefined
      ? {}
      : {
          depth: {
            bids: [...state.depth.bids],
            asks: [...state.depth.asks],
          },
        }),
    ...(state.volume === undefined ? {} : { volume: state.volume }),
    ...(state.tickSize === undefined
      ? {}
      : { tickSize: state.tickSize }),
    ...(state.status === undefined ? {} : { status: state.status }),
    ...(state.sourceUpdatedAt === undefined
      ? {}
      : { sourceUpdatedAt: state.sourceUpdatedAt }),
    receivedAt: state.receivedAt,
    stale,
  };
}

function addNoVigProbabilities(
  states: readonly BookState[],
  outcomes: MarketSnapshotOutcome[],
): void {
  const groups = new Map<string, number[]>();
  states.forEach((state, index) => {
    const key = pairedMarketKey(state);
    const indexes = groups.get(key) ?? [];
    indexes.push(index);
    groups.set(key, indexes);
  });

  for (const indexes of groups.values()) {
    if (indexes.length !== 2) continue;
    const firstIndex = indexes[0];
    const secondIndex = indexes[1];
    if (firstIndex === undefined || secondIndex === undefined) continue;
    const first = outcomes[firstIndex];
    const second = outcomes[secondIndex];
    if (
      first === undefined ||
      second === undefined ||
      first.stale ||
      second.stale ||
      first.impliedProbability === undefined ||
      second.impliedProbability === undefined ||
      first.impliedProbability + second.impliedProbability <= 0
    ) {
      continue;
    }
    const noVig = devigPair(
      first.impliedProbability,
      second.impliedProbability,
    );
    first.noVigProbability = noVig.red;
    second.noVigProbability = noVig.blue;
  }
}

function sortOutcomes(
  left: MarketSnapshotOutcome,
  right: MarketSnapshotOutcome,
): number {
  return (
    (left.bookmaker ?? "").localeCompare(right.bookmaker ?? "") ||
    left.marketType.localeCompare(right.marketType) ||
    left.outcome.localeCompare(right.outcome)
  );
}

export class MarketTickStore implements TickHistorySource {
  private readonly eventBus: CollectorEventBus;

  private readonly storage: Storage;

  private readonly staleAfterMs: number;

  private readonly clock: TickStoreClock;

  private readonly persistIntervalMs: number;

  private readonly timer: TickStoreTimer;

  private readonly lastPersistedAt = new Map<string, number>();

  private readonly pendingPersist = new Map<string, MarketTick>();

  private readonly persistTimers = new Map<string, unknown>();

  private readonly metrics: Metrics;

  private readonly publish:
    | ((snapshot: MarketSnapshot) => Promise<void>)
    | undefined;

  private readonly onSnapshot:
    | ((snapshot: MarketSnapshot) => Promise<void>)
    | undefined;

  private readonly onSnapshotsRemoved:
    | ((
        boutId: string,
        round: number,
        boundaryType: MarketBoundaryType,
      ) => Promise<void>)
    | undefined;

  private history: MarketTick[] = [];

  private readonly latest = new Map<string, BookState>();

  private readonly snapshots = new Map<string, MarketSnapshot>();

  private readonly freshnessHistory: SourceFreshnessRecord[] = [];

  private readonly unsubscribers: Array<() => void> = [];

  private restorePromise: Promise<void> | undefined;

  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: MarketTickStoreOptions) {
    const staleAfterMs =
      options.staleAfterMs ?? DEFAULT_MARKET_STALE_AFTER_MS;
    if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
      throw new TypeError("staleAfterMs must be a non-negative number");
    }
    const persistIntervalMs =
      options.persistIntervalMs ?? DEFAULT_PERSIST_INTERVAL_MS;
    if (!Number.isFinite(persistIntervalMs) || persistIntervalMs < 0) {
      throw new TypeError("persistIntervalMs must be a non-negative number");
    }
    this.eventBus = options.eventBus;
    this.storage = options.storage;
    this.staleAfterMs = staleAfterMs;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.persistIntervalMs = persistIntervalMs;
    this.timer = options.timer ?? DEFAULT_TICK_STORE_TIMER;
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.publish = options.publish;
    this.onSnapshot = options.onSnapshot;
    this.onSnapshotsRemoved = options.onSnapshotsRemoved;

    this.unsubscribers.push(
      this.eventBus.subscribe("PROVISIONAL_ROUND_ENDED", (event) => {
        this.enqueue(() => this.onBoundary(event));
      }),
      this.eventBus.subscribe("ROUND_ENDED", (event) => {
        this.enqueue(() => this.onBoundary(event));
      }),
    );
  }

  static async create(
    options: MarketTickStoreOptions,
  ): Promise<MarketTickStore> {
    const store = new MarketTickStore(options);
    await store.restore();
    return store;
  }

  async restore(): Promise<void> {
    this.restorePromise ??= this.restoreFromStorage();
    await this.restorePromise;
  }

  appendTick(tick: MarketTick): Promise<LocalOrderBookState> {
    let result: LocalOrderBookState | undefined;
    const operation = this.enqueue(async () => {
      await this.restore();
      validateTick(tick);
      const accepted = copyTick(tick);
      this.metrics.recordPayload(
        accepted.source,
        accepted.sourceUpdatedAt,
        accepted.receivedAt,
      );
      // In-memory state is always applied immediately, for UI freshness and
      // for accurate round-boundary reconstruction; only the durable write
      // below is sampled.
      this.history.push(accepted);
      const state = applyTick(this.latest, accepted);
      result = this.toLocalState(state, this.clock.now());
      await this.persistSampled(accepted);
    });
    return operation.then(() => result as LocalOrderBookState);
  }

  ingest(tick: MarketTick): Promise<LocalOrderBookState> {
    return this.appendTick(tick);
  }

  markStale(source: MarketSource, changedAt?: string): Promise<void> {
    return this.recordFreshness(source, false, changedAt);
  }

  markFresh(source: MarketSource, changedAt?: string): Promise<void> {
    return this.recordFreshness(source, true, changedAt);
  }

  getLatest(
    boutId?: string,
    source?: MarketSource,
  ): readonly LocalOrderBookState[] {
    const now = this.clock.now();
    const states = [...this.latest.values()].filter(
      (state) =>
        (boutId === undefined || state.boutId === boutId) &&
        (source === undefined || state.source === source),
    );
    const outcomes = states.map((state) =>
      this.toLocalState(state, now),
    );
    this.applyLatestNoVig(states, outcomes);
    return outcomes.sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.boutId.localeCompare(right.boutId) ||
        sortOutcomes(left, right),
    );
  }

  async getTickHistory(
    boutId: string,
    source?: MarketSource,
  ): Promise<MarketTick[]> {
    await this.restore();
    return this.history
      .filter(
        (tick) =>
          tick.boutId === boutId &&
          (source === undefined || tick.source === source),
      )
      .map(copyTick);
  }

  getSnapshots(
    boutId?: string,
    round?: number,
  ): readonly MarketSnapshot[] {
    return [...this.snapshots.values()]
      .filter(
        (snapshot) =>
          (boutId === undefined || snapshot.boutId === boutId) &&
          (round === undefined || snapshot.round === round),
      )
      .map(copySnapshot)
      .sort(
        (left, right) =>
          left.boutId.localeCompare(right.boutId) ||
          left.round - right.round ||
          left.source.localeCompare(right.source) ||
          left.boundaryType.localeCompare(right.boundaryType),
      );
  }

  async getRoundBoundarySnapshots(
    boutId: string,
    round?: number,
  ): Promise<MarketSnapshot[]> {
    await this.restore();
    return [...this.getSnapshots(boutId, round)];
  }

  recomputeBoundary(
    boutId: string,
    round: number,
    boundaryType: MarketBoundaryType,
    takenAt: string,
  ): Promise<readonly MarketSnapshot[]> {
    let result: readonly MarketSnapshot[] = [];
    const operation = this.enqueue(async () => {
      await this.restore();
      result = await this.snapshotBoundary(
        boutId,
        round,
        boundaryType,
        takenAt,
      );
    });
    return operation.then(() => result);
  }

  snapshotSource(
    boutId: string,
    round: number,
    source: MarketSource,
    boundaryType: MarketBoundaryType,
    takenAt: string,
    label?: MarketSnapshotLabel,
  ): Promise<MarketSnapshot | undefined> {
    let result: MarketSnapshot | undefined;
    const operation = this.enqueue(async () => {
      await this.restore();
      const snapshots = await this.snapshotBoundary(
        boutId,
        round,
        boundaryType,
        takenAt,
        source,
        label,
      );
      result = snapshots[0];
    });
    return operation.then(() => result);
  }

  /**
   * Pins the last available market for a bout before its opening bell.  This
   * is intentionally a separate entry point from round boundaries: pre-fight
   * snapshots use the reserved round zero and must never be confused with an
   * in-progress or completed round.
   */
  snapshotPreFight(
    boutId: string,
    takenAt: string,
    sources?: readonly MarketSource[],
  ): Promise<readonly MarketSnapshot[]> {
    let result: readonly MarketSnapshot[] = [];
    const operation = this.enqueue(async () => {
      await this.restore();
      result = await this.snapshotBoundary(
        boutId,
        0,
        "pre-fight",
        takenAt,
        undefined,
        "pre-fight-open",
        sources,
      );
    });
    return operation.then(() => result);
  }

  handleProvisionalSupersession(
    supersession: ProvisionalRoundSupersession,
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.restore();
      const keys = [...this.snapshots.entries()]
        .filter(
          ([, snapshot]) =>
            snapshot.boutId === supersession.boutId &&
            snapshot.round === supersession.round &&
            snapshot.boundaryType === "provisional" &&
            snapshot.takenAt === supersession.provisionalDetectedAt,
        )
        .map(([key]) => key);
      if (keys.length === 0) return;
      for (const key of keys) this.snapshots.delete(key);
      await this.persistSnapshots();
      await this.onSnapshotsRemoved?.(
        supersession.boutId,
        supersession.round,
        "provisional",
      ).catch(() => undefined);
    });
  }

  async idle(): Promise<void> {
    while (true) {
      const queue = this.operationQueue;
      await queue;
      if (queue === this.operationQueue) return;
    }
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    await this.operationQueue;
    for (const handle of this.persistTimers.values()) {
      this.timer.clearTimeout(handle);
    }
    this.persistTimers.clear();
    await this.enqueue(() => this.flushAllPending());
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async restoreFromStorage(): Promise<void> {
    const [ticks, snapshots, freshness] = await Promise.all([
      this.storage.read<unknown>(MARKET_TICKS_STORAGE_STREAM),
      this.storage.read<unknown>(MARKET_SNAPSHOTS_STORAGE_STREAM),
      this.storage.read<unknown>(MARKET_FRESHNESS_STORAGE_STREAM),
    ]);

    this.history.splice(0);
    this.latest.clear();
    for (const persisted of ticks) {
      if (!isPersistedTick(persisted)) continue;
      // No copyTick() here, unlike appendTick(): `persisted.tick` came
      // straight out of JSON.parse in storage.read() and isn't aliased by
      // any caller that could later mutate it, so history can hold it
      // directly.
      //
      // market-ticks.jsonl used to retain every accepted tick for the whole
      // life of an event and routinely ran into the hundreds of thousands
      // of records — replaying that (even without the extra clone this
      // comment used to warn against) OOM-crashed the deployed machine on
      // boot (2026-08-04/05, then again 2026-08-07 once the file crossed
      // ~1M lines). `snapshotBoundary` now prunes and compacts this stream
      // down to the active round's ticks the moment a "confirmed" boundary
      // makes everything before it permanently unreachable, so this file —
      // and this restore — should never again scale with an event's total
      // runtime, only with one round's worth of ticks.
      this.history.push(persisted.tick);
      applyTick(this.latest, persisted.tick);
    }

    this.snapshots.clear();
    for (const persisted of snapshots) {
      if (!isPersistedSnapshot(persisted)) continue;
      const snapshot = copySnapshot(persisted.snapshot);
      this.snapshots.set(snapshotKey(snapshot), snapshot);
    }

    this.freshnessHistory.splice(0);
    for (const record of freshness) {
      if (isFreshnessRecord(record)) {
        this.freshnessHistory.push({ ...record });
      }
    }
  }

  private recordFreshness(
    source: MarketSource,
    fresh: boolean,
    changedAt?: string,
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.restore();
      if (!SOURCES.has(source)) {
        throw new TypeError("source is unsupported");
      }
      const timestampValue =
        changedAt ?? new Date(this.clock.now()).toISOString();
      timestamp(timestampValue, "changedAt");
      const record: SourceFreshnessRecord = {
        version: 1,
        source,
        fresh,
        changedAt: timestampValue,
      };
      await this.storage.append(
        MARKET_FRESHNESS_STORAGE_STREAM,
        record,
      );
      this.freshnessHistory.push(record);
    });
  }

  private toLocalState(
    state: BookState,
    at: number,
  ): LocalOrderBookState {
    const sourceIsFresh = sourceFreshAt(
      this.freshnessHistory,
      state.source,
      at,
    );
    const stale = stateStale(
      state,
      at,
      this.staleAfterMs,
      sourceIsFresh,
    );
    const outcome = outcomeFromState(state, stale);
    return {
      source: state.source,
      boutId: state.boutId,
      ...outcome,
      fresh: !stale,
      depth: {
        bids:
          state.depth === undefined
            ? state.bid === undefined
              ? []
              : [state.bid]
            : [...state.depth.bids],
        asks:
          state.depth === undefined
            ? state.ask === undefined
              ? []
              : [state.ask]
            : [...state.depth.asks],
      },
    };
  }

  private applyLatestNoVig(
    states: readonly BookState[],
    outcomes: LocalOrderBookState[],
  ): void {
    addNoVigProbabilities(states, outcomes);
  }

  private async onBoundary(event: RoundBoundaryEvent): Promise<void> {
    await this.restore();
    if (event.type === "PROVISIONAL_ROUND_ENDED") {
      await this.snapshotBoundary(
        event.boutId,
        event.round,
        "provisional",
        event.detectedAt,
      );
      return;
    }

    const hasChangedProvisional = [...this.snapshots.values()].some(
      (snapshot) =>
        snapshot.boutId === event.boutId &&
        snapshot.round === event.round &&
        snapshot.boundaryType === "provisional" &&
        snapshot.takenAt !== event.detectedAt,
    );
    if (hasChangedProvisional) {
      await this.snapshotBoundary(
        event.boutId,
        event.round,
        "provisional",
        event.detectedAt,
      );
    }
    await this.snapshotBoundary(
      event.boutId,
      event.round,
      "confirmed",
      event.detectedAt,
    );
  }

  private async snapshotBoundary(
    boutId: string,
    round: number,
    boundaryType: MarketBoundaryType,
    takenAt: string,
    sourceFilter?: MarketSource,
    label?: MarketSnapshotLabel,
    sourceAllowlist?: readonly MarketSource[],
  ): Promise<readonly MarketSnapshot[]> {
    const isPreFight = boundaryType === "pre-fight";
    if (
      !Number.isSafeInteger(round) ||
      (isPreFight ? round !== 0 : round < 1)
    ) {
      throw new TypeError(
        isPreFight
          ? "pre-fight snapshots must use round zero"
          : "round snapshots must use a positive integer",
      );
    }
    const boundaryTime = timestamp(takenAt, "takenAt");
    const states = new Map<string, BookState>();
    for (const tick of this.history) {
      if (
        tick.boutId === boutId &&
        Date.parse(tick.receivedAt) <= boundaryTime
      ) {
        applyTick(states, tick);
      }
    }

    const bySource = new Map<MarketSource, BookState[]>();
    for (const state of states.values()) {
      const sourceStates = bySource.get(state.source) ?? [];
      sourceStates.push(state);
      bySource.set(state.source, sourceStates);
    }

    const produced: MarketSnapshot[] = [];
    const changed: MarketSnapshot[] = [];
    for (const [source, sourceStates] of bySource) {
      if (sourceFilter !== undefined && source !== sourceFilter) continue;
      if (sourceAllowlist !== undefined && !sourceAllowlist.includes(source)) {
        continue;
      }
      const freshAtBoundary = sourceFreshAt(
        this.freshnessHistory,
        source,
        boundaryTime,
      );
      const outcomes = sourceStates.map((state) =>
        outcomeFromState(
          state,
          stateStale(
            state,
            boundaryTime,
            this.staleAfterMs,
            freshAtBoundary,
          ),
        ),
      );
      addNoVigProbabilities(sourceStates, outcomes);
      outcomes.sort(sortOutcomes);
      const snapshot: MarketSnapshot = {
        source,
        boutId,
        round,
        boundaryType,
        ...(label === undefined ? {} : { label }),
        takenAt,
        fresh:
          outcomes.length > 0 &&
          outcomes.every((outcome) => !outcome.stale),
        outcomes,
      };
      const previous = this.snapshots.get(snapshotKey(snapshot));
      this.snapshots.set(snapshotKey(snapshot), snapshot);
      produced.push(copySnapshot(snapshot));
      if (JSON.stringify(previous) !== JSON.stringify(snapshot)) {
        changed.push(copySnapshot(snapshot));
      }
    }

    const producedSources = new Set(produced.map(({ source }) => source));
    let removed = false;
    for (const [key, snapshot] of this.snapshots) {
      if (
        snapshot.boutId === boutId &&
        snapshot.round === round &&
        snapshot.boundaryType === boundaryType &&
        (sourceFilter === undefined || snapshot.source === sourceFilter) &&
        !producedSources.has(snapshot.source)
      ) {
        this.snapshots.delete(key);
        removed = true;
      }
    }

    await this.persistSnapshots();
    if (removed) {
      await this.onSnapshotsRemoved?.(
        boutId,
        round,
        boundaryType,
      ).catch(() => undefined);
    }
    for (const snapshot of removed ? produced : changed) {
      await this.onSnapshot?.(copySnapshot(snapshot)).catch(() => undefined);
      await this.publish?.(copySnapshot(snapshot)).catch(() => undefined);
    }
    // A "confirmed" boundary is permanent — unlike "provisional", it is
    // never recomputed or superseded (see handleProvisionalSupersession,
    // which only ever touches provisional snapshots). Every future boundary
    // for this bout can only occur at or after this one, so a tick at or
    // before it can only ever matter as a carry-forward "last known state"
    // for a market that goes quiet — never as raw history to replay again.
    // Pruning here (and nowhere else — "provisional" and "pre-fight" are
    // left untouched, since a provisional round-end can still be superseded
    // and needs its ticks intact) is what keeps `history` and
    // market-ticks.jsonl bounded to roughly one round's worth of ticks
    // instead of growing for the life of the whole event. See
    // docs/superpowers/specs for the incident this fixes: unbounded tick
    // retention OOM-crashed the deployed machine on boot once the file
    // passed ~1M lines.
    if (boundaryType === "confirmed") {
      const before = this.history.length;
      this.history = prunedHistoryAfterConfirmedBoundary(
        this.history,
        boutId,
        boundaryTime,
      );
      if (this.history.length !== before) {
        await this.persistHistory();
      }
    }
    return produced;
  }

  /**
   * Throttles durable writes to roughly once per `persistIntervalMs` per
   * book key. A tick within the window is held in `pendingPersist`; a
   * trailing flush is scheduled so the latest sample still lands even if no
   * further tick arrives, rather than being dropped on the floor.
   */
  private async persistSampled(accepted: MarketTick): Promise<void> {
    const key = bookKey(accepted);
    if (this.persistIntervalMs === 0) {
      await this.writeTick(key, accepted);
      return;
    }
    const now = this.clock.now();
    const lastPersisted = this.lastPersistedAt.get(key);
    if (
      lastPersisted === undefined ||
      now - lastPersisted >= this.persistIntervalMs
    ) {
      await this.writeTick(key, accepted);
      return;
    }
    this.pendingPersist.set(key, accepted);
    this.scheduleTrailingFlush(key, this.persistIntervalMs - (now - lastPersisted));
  }

  private async writeTick(key: string, tick: MarketTick): Promise<void> {
    await this.storage.append(MARKET_TICKS_STORAGE_STREAM, {
      version: 1,
      tick,
    } satisfies PersistedTick);
    this.lastPersistedAt.set(key, this.clock.now());
    this.pendingPersist.delete(key);
    const handle = this.persistTimers.get(key);
    if (handle !== undefined) {
      this.timer.clearTimeout(handle);
      this.persistTimers.delete(key);
    }
  }

  private scheduleTrailingFlush(key: string, delayMs: number): void {
    if (this.persistTimers.has(key)) return;
    const handle = this.timer.setTimeout(() => {
      this.persistTimers.delete(key);
      this.enqueue(() => this.flushPending(key));
    }, delayMs);
    this.persistTimers.set(key, handle);
  }

  private async flushPending(key: string): Promise<void> {
    const pending = this.pendingPersist.get(key);
    if (pending === undefined) return;
    await this.writeTick(key, pending);
  }

  private async flushAllPending(): Promise<void> {
    for (const key of [...this.pendingPersist.keys()]) {
      await this.flushPending(key);
    }
  }

  private async persistSnapshots(): Promise<void> {
    const records = [...this.snapshots.values()]
      .map(copySnapshot)
      .sort(
        (left, right) =>
          left.boutId.localeCompare(right.boutId) ||
          left.round - right.round ||
          left.source.localeCompare(right.source) ||
          left.boundaryType.localeCompare(right.boundaryType),
      )
      .map(
        (snapshot) =>
          ({
            version: 1,
            snapshot,
          }) satisfies PersistedSnapshot,
      );
    await this.storage.replace(MARKET_SNAPSHOTS_STORAGE_STREAM, records);
  }

  /**
   * Rewrites market-ticks.jsonl from the current (already-pruned)
   * `history`, physically shrinking the durable file to match — an append
   * can only grow a stream, so this is the only way a prune (see the
   * "confirmed" branch in snapshotBoundary) ever takes effect on disk
   * rather than just in memory.
   */
  private async persistHistory(): Promise<void> {
    const records = this.history.map(
      (tick) => ({ version: 1, tick }) satisfies PersistedTick,
    );
    await this.storage.replace(MARKET_TICKS_STORAGE_STREAM, records);
  }
}
