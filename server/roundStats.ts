import { createHash } from "node:crypto";
import type {
  CitoFighterRoundStats,
  CitoRoundStatsFetcher,
  CitoRoundStatsPayload,
} from "../src/sources/cito.ts";
import { CitoRoundStatsRequestError } from "../src/sources/cito.ts";
import type {
  MarketBoundaryType,
  MarketSnapshot,
  MarketSource,
} from "../src/sources/contract.ts";
import type {
  ExpertConsensus,
  SherdogRoundObservation,
} from "../src/schema.ts";
import type {
  CollectorEvent,
  CollectorEventBus,
} from "./eventBus.ts";
import {
  RollingQuotaGuard,
  type QuotaPolicy,
} from "./quota.ts";
import {
  RoundJobScheduler,
  TerminalRoundJobError,
  type RoundJob,
  type RoundJobClock,
  type RoundJobTimer,
} from "./roundJobs.ts";
import type { Storage } from "./storage.ts";
import { NOOP_METRICS, type Metrics } from "./health.ts";
import {
  EspnRoundStatsAccumulator,
  type EspnCumulativeSnapshot,
  type EspnDerivedRoundStats,
} from "./espnRoundStats.ts";

export const ROUND_STATS_STORAGE_STREAM = "round-stats";
export const UNIFIED_ROUNDS_STORAGE_STREAM = "unified-rounds";
export const CITO_ROUND_STATS_JOB_TYPE = "cito_round_stats";
export const CITO_RECONCILIATION_JOB_TYPE =
  "cito_round_stats_reconcile";

export const DEFAULT_CITO_INITIAL_DELAY_MS = 6_000;
export const DEFAULT_CITO_RETRY_DELAY_MS = 20_000;
export const DEFAULT_CITO_QUOTA_POLICY: QuotaPolicy = {
  perMinute: 9,
  perHour: 500,
  perDay: 5_000,
};

export interface FighterRoundStats {
  significantStrikes: number;
  totalStrikes: number;
  takedowns: number;
  takedownsAttempted: number;
  controlTimeSeconds: number;
  knockdowns: number;
}

export interface RoundStatsRecord {
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

export type RoundEndingSignal =
  | "clock_zero_provisional"
  | "period_transition"
  | "fight_completed";

export interface UnifiedRoundRecord {
  boutId: string;
  round: number;
  detectedEndedAt: string;
  endingSignal: RoundEndingSignal;
  citoStats?: RoundStatsRecord;
  sherdog?: SherdogRoundObservation;
  marketAtEnd: MarketAtEnd;
  expertConsensus?: ExpertConsensus;
  provisional: boolean;
  finalizedAt?: string;
}

export interface MarketAtEnd {
  kalshi?: MarketSnapshot;
  polymarket?: MarketSnapshot;
  oddsApiIo?: MarketSnapshot;
  theOddsApi?: MarketSnapshot;
}

export interface RoundStatsPipelineOptions {
  eventBus: CollectorEventBus;
  storage: Storage;
  fetcher: CitoRoundStatsFetcher;
  publish?: (record: UnifiedRoundRecord) => Promise<void>;
  clock?: RoundJobClock;
  timer?: RoundJobTimer;
  initialDelayMs?: number;
  retryDelayMs?: number;
  quotaPolicy?: QuotaPolicy;
  quota?: RollingQuotaGuard;
  scheduler?: RoundJobScheduler;
  metrics?: Metrics;
  enableCitoJobs?: boolean;
}

interface PersistedRoundStats {
  version: 1;
  record: RoundStatsRecord;
}

interface PersistedUnifiedRound {
  version: 1;
  record: UnifiedRoundRecord;
}

type RoundBoundaryEvent = Extract<
  CollectorEvent,
  { type: "PROVISIONAL_ROUND_ENDED" | "ROUND_ENDED" }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFighterStats(value: unknown): value is FighterRoundStats {
  if (!isRecord(value)) return false;

  return [
    value.significantStrikes,
    value.totalStrikes,
    value.takedowns,
    value.takedownsAttempted,
    value.controlTimeSeconds,
    value.knockdowns,
  ].every(
    (stat) =>
      typeof stat === "number" &&
      Number.isFinite(stat) &&
      stat >= 0,
  );
}

function isRoundStatsRecord(value: unknown): value is RoundStatsRecord {
  return (
    isRecord(value) &&
    typeof value.boutId === "string" &&
    typeof value.round === "number" &&
    Number.isSafeInteger(value.round) &&
    value.round >= 1 &&
    isFighterStats(value.fighterA) &&
    isFighterStats(value.fighterB) &&
    typeof value.provisional === "boolean" &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1 &&
    typeof value.payloadHash === "string" &&
    typeof value.firstObservedAt === "string" &&
    typeof value.lastObservedAt === "string"
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSherdogObservation(
  value: unknown,
): value is SherdogRoundObservation {
  return (
    isRecord(value) &&
    typeof value.boutId === "string" &&
    Number.isSafeInteger(value.round) &&
    (value.round as number) >= 1 &&
    typeof value.commentary === "string" &&
    !/<[^>]*>/.test(value.commentary) &&
    Array.isArray(value.scorerCards) &&
    value.scorerCards.every(
      (card) =>
        isRecord(card) &&
        typeof card.scorer === "string" &&
        (card.winner === undefined || typeof card.winner === "string") &&
        (card.roundScore === undefined ||
          typeof card.roundScore === "string") &&
        (card.cumulativeScore === undefined ||
          typeof card.cumulativeScore === "string"),
    ) &&
    typeof value.sourceUrl === "string" &&
    (value.publishedAt === undefined || isTimestamp(value.publishedAt)) &&
    isTimestamp(value.fetchedAt) &&
    typeof value.parserVersion === "string" &&
    typeof value.payloadHash === "string"
  );
}

function isExpertConsensus(value: unknown): value is ExpertConsensus {
  if (!isRecord(value)) return false;
  return ["sherdog"].every((source) => {
    const consensus = value[source];
    return (
      consensus === undefined ||
      (isRecord(consensus) &&
        consensus.source === source &&
        Number.isSafeInteger(consensus.redVotes) &&
        Number.isSafeInteger(consensus.blueVotes) &&
        Number.isSafeInteger(consensus.drawVotes) &&
        Number.isSafeInteger(consensus.total))
    );
  });
}

function isUnifiedRoundRecord(
  value: unknown,
): value is UnifiedRoundRecord {
  return (
    isRecord(value) &&
    typeof value.boutId === "string" &&
    typeof value.round === "number" &&
    Number.isSafeInteger(value.round) &&
    value.round >= 1 &&
    typeof value.detectedEndedAt === "string" &&
    (value.endingSignal === "clock_zero_provisional" ||
      value.endingSignal === "period_transition" ||
      value.endingSignal === "fight_completed") &&
    (value.citoStats === undefined ||
      isRoundStatsRecord(value.citoStats)) &&
    (value.sherdog === undefined ||
      isSherdogObservation(value.sherdog)) &&
    isRecord(value.marketAtEnd) &&
    (value.expertConsensus === undefined ||
      isExpertConsensus(value.expertConsensus)) &&
    typeof value.provisional === "boolean"
  );
}

function isPersistedRoundStats(
  value: unknown,
): value is PersistedRoundStats {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isRoundStatsRecord(value.record)
  );
}

function isPersistedUnifiedRound(
  value: unknown,
): value is PersistedUnifiedRound {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isUnifiedRoundRecord(value.record)
  );
}

function roundKey(boutId: string, round: number): string {
  return `${boutId}:${round}`;
}

function copyStats(stats: FighterRoundStats): FighterRoundStats {
  return { ...stats };
}

function copyRoundStats(record: RoundStatsRecord): RoundStatsRecord {
  return {
    ...record,
    fighterA: copyStats(record.fighterA),
    fighterB: copyStats(record.fighterB),
  };
}

function copySherdog(
  observation: SherdogRoundObservation,
): SherdogRoundObservation {
  return {
    ...observation,
    scorerCards: observation.scorerCards.map((card) => ({ ...card })),
  };
}

function copyExpertConsensus(
  consensus: ExpertConsensus,
): ExpertConsensus {
  return {
    ...(consensus.sherdog === undefined
      ? {}
      : { sherdog: { ...consensus.sherdog } }),
  };
}

function copyUnified(record: UnifiedRoundRecord): UnifiedRoundRecord {
  return {
    ...record,
    ...(record.citoStats === undefined
      ? {}
      : { citoStats: copyRoundStats(record.citoStats) }),
    ...(record.sherdog === undefined
      ? {}
      : { sherdog: copySherdog(record.sherdog) }),
    marketAtEnd: copyMarketAtEnd(record.marketAtEnd),
    ...(record.expertConsensus === undefined
      ? {}
      : {
          expertConsensus: copyExpertConsensus(record.expertConsensus),
        }),
  };
}

function copyMarketSnapshot(snapshot: MarketSnapshot): MarketSnapshot {
  return {
    ...snapshot,
    outcomes: snapshot.outcomes.map((outcome) => ({ ...outcome })),
  };
}

function copyMarketAtEnd(marketAtEnd: MarketAtEnd): MarketAtEnd {
  return {
    ...(marketAtEnd.kalshi === undefined
      ? {}
      : { kalshi: copyMarketSnapshot(marketAtEnd.kalshi) }),
    ...(marketAtEnd.polymarket === undefined
      ? {}
      : { polymarket: copyMarketSnapshot(marketAtEnd.polymarket) }),
    ...(marketAtEnd.oddsApiIo === undefined
      ? {}
      : { oddsApiIo: copyMarketSnapshot(marketAtEnd.oddsApiIo) }),
    ...(marketAtEnd.theOddsApi === undefined
      ? {}
      : { theOddsApi: copyMarketSnapshot(marketAtEnd.theOddsApi) }),
  };
}

function marketField(
  source: MarketSource,
): keyof MarketAtEnd {
  switch (source) {
    case "kalshi":
      return "kalshi";
    case "polymarket":
      return "polymarket";
    case "odds-api-io":
      return "oddsApiIo";
    case "the-odds-api":
      return "theOddsApi";
  }
}

function boundaryTypeForRecord(
  record: UnifiedRoundRecord,
): MarketBoundaryType {
  return record.endingSignal === "clock_zero_provisional"
    ? "provisional"
    : "confirmed";
}

function marketBoundaryKey(
  boutId: string,
  round: number,
  boundaryType: MarketBoundaryType,
  source: MarketSource,
): string {
  return `${boutId}:${round}:${boundaryType}:${source}`;
}

function completeFighterStats(
  stats: CitoFighterRoundStats | undefined,
): FighterRoundStats | undefined {
  return isFighterStats(stats) ? { ...stats } : undefined;
}

function completePayload(
  payload: CitoRoundStatsPayload,
): { fighterA: FighterRoundStats; fighterB: FighterRoundStats } | undefined {
  const fighterA = completeFighterStats(payload.fighterA);
  const fighterB = completeFighterStats(payload.fighterB);
  return fighterA === undefined || fighterB === undefined
    ? undefined
    : { fighterA, fighterB };
}

function payloadHash(payload: {
  fighterA: FighterRoundStats;
  fighterB: FighterRoundStats;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function validateDelay(delayMs: number, field: string): void {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new TypeError(`${field} must be a non-negative number`);
  }
}

function endingSignal(event: RoundBoundaryEvent): RoundEndingSignal {
  if (event.type === "PROVISIONAL_ROUND_ENDED") {
    return "clock_zero_provisional";
  }
  return event.confirmation;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function terminalCitoError(error: unknown): TerminalRoundJobError | undefined {
  if (
    !(error instanceof CitoRoundStatsRequestError) ||
    (error.kind !== "auth" &&
      error.kind !== "quota" &&
      error.kind !== "unavailable")
  ) {
    return undefined;
  }
  return new TerminalRoundJobError(`Cito round request failed: ${error.message}`);
}

export class RoundStatsPipeline {
  readonly quota: RollingQuotaGuard;

  readonly scheduler: RoundJobScheduler;

  private readonly eventBus: CollectorEventBus;

  private readonly storage: Storage;

  private readonly fetcher: CitoRoundStatsFetcher;

  private readonly publish:
    | ((record: UnifiedRoundRecord) => Promise<void>)
    | undefined;

  private readonly clock: RoundJobClock;

  private readonly initialDelayMs: number;

  private readonly retryDelayMs: number;

  private readonly metrics: Metrics;

  private readonly citoJobsEnabled: boolean;

  private readonly stats = new Map<string, RoundStatsRecord>();

  private readonly liveEspnStats = new Map<string, EspnDerivedRoundStats>();

  private readonly espnAccumulator = new EspnRoundStatsAccumulator();

  private readonly histories = new Map<string, RoundStatsRecord[]>();

  private readonly unified = new Map<string, UnifiedRoundRecord>();

  private readonly confirmedRounds = new Set<string>();

  private readonly marketSnapshots = new Map<string, MarketSnapshot>();

  private readonly unsubscribers: Array<() => void> = [];

  private eventQueue: Promise<void> = Promise.resolve();

  private stateQueue: Promise<void> = Promise.resolve();

  private requestQueue: Promise<void> = Promise.resolve();

  private restorePromise: Promise<void> | undefined;

  constructor(options: RoundStatsPipelineOptions) {
    const initialDelayMs =
      options.initialDelayMs ?? DEFAULT_CITO_INITIAL_DELAY_MS;
    const retryDelayMs =
      options.retryDelayMs ?? DEFAULT_CITO_RETRY_DELAY_MS;
    validateDelay(initialDelayMs, "initialDelayMs");
    validateDelay(retryDelayMs, "retryDelayMs");

    this.eventBus = options.eventBus;
    this.storage = options.storage;
    this.fetcher = options.fetcher;
    this.publish = options.publish;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.initialDelayMs = initialDelayMs;
    this.retryDelayMs = retryDelayMs;
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.citoJobsEnabled = options.enableCitoJobs ?? true;
    this.quota =
      options.quota ??
      new RollingQuotaGuard({
        storage: options.storage,
        policies: {
          cito: options.quotaPolicy ?? DEFAULT_CITO_QUOTA_POLICY,
        },
        clock: this.clock,
        metrics: this.metrics,
      });
    this.scheduler =
      options.scheduler ??
      new RoundJobScheduler({
        storage: options.storage,
        clock: this.clock,
        ...(options.timer === undefined ? {} : { timer: options.timer }),
        metrics: this.metrics,
      });
    if (this.citoJobsEnabled) {
      this.scheduler.registerHandler(CITO_ROUND_STATS_JOB_TYPE, (job) =>
        this.runRoundFetch(job));
      this.scheduler.registerHandler(CITO_RECONCILIATION_JOB_TYPE, (job) =>
        this.runReconciliation(job));
    }

    this.unsubscribers.push(
      this.eventBus.subscribe(
        "PROVISIONAL_ROUND_ENDED",
        (event) => this.enqueueEvent(() => this.onRoundBoundary(event)),
      ),
      this.eventBus.subscribe(
        "ROUND_ENDED",
        (event) => this.enqueueEvent(() => this.onRoundBoundary(event)),
      ),
      this.eventBus.subscribe(
        "FIGHT_ENDED",
        (event) => this.enqueueEvent(() => this.onFightEnded(event)),
      ),
    );
  }

  static async create(
    options: RoundStatsPipelineOptions,
  ): Promise<RoundStatsPipeline> {
    const pipeline = new RoundStatsPipeline(options);
    await pipeline.restore();
    return pipeline;
  }

  async restore(): Promise<void> {
    this.restorePromise ??= this.restoreFromStorage();
    await this.restorePromise;
  }

  getRoundStats(
    boutId: string,
    round: number,
  ): RoundStatsRecord | undefined {
    const record = this.stats.get(roundKey(boutId, round));
    return record === undefined ? undefined : copyRoundStats(record);
  }

  getRevisionHistory(
    boutId: string,
    round: number,
  ): readonly RoundStatsRecord[] {
    return (this.histories.get(roundKey(boutId, round)) ?? []).map(
      copyRoundStats,
    );
  }

  /** Latest ESPN-derived live round totals; these are never fetched from Cito. */
  getLiveEspnRoundStats(
    boutId: string,
    round: number,
  ): EspnDerivedRoundStats | undefined {
    const record = this.liveEspnStats.get(roundKey(boutId, round));
    return record === undefined
      ? undefined
      : { ...record, fighterA: { ...record.fighterA }, fighterB: { ...record.fighterB } };
  }

  observeEspnCumulative(
    snapshot: EspnCumulativeSnapshot,
  ): EspnDerivedRoundStats {
    const derived = this.espnAccumulator.observe(snapshot);
    this.liveEspnStats.set(roundKey(derived.boutId, derived.round), derived);
    this.metrics.recordPayload("espn", snapshot.observedAt, snapshot.observedAt);
    return this.getLiveEspnRoundStats(derived.boutId, derived.round)!;
  }

  getUnifiedRound(
    boutId: string,
    round: number,
  ): UnifiedRoundRecord | undefined {
    const record = this.unified.get(roundKey(boutId, round));
    return record === undefined ? undefined : copyUnified(record);
  }

  getUnifiedRounds(): readonly UnifiedRoundRecord[] {
    return [...this.unified.values()]
      .map(copyUnified)
      .sort(
        (left, right) =>
          left.boutId.localeCompare(right.boutId) ||
          left.round - right.round,
      );
  }

  setSherdogObservation(
    observation: SherdogRoundObservation,
    expertConsensus?: ExpertConsensus,
  ): Promise<boolean> {
    return this.enqueueState(async () => {
      if (!isSherdogObservation(observation)) {
        throw new TypeError("Sherdog observation is not normalized");
      }
      const key = roundKey(observation.boutId, observation.round);
      const previous = this.unified.get(key);
      if (previous === undefined) return false;
      if (
        previous.sherdog?.payloadHash === observation.payloadHash &&
        previous.sherdog.fetchedAt === observation.fetchedAt &&
        JSON.stringify(previous.expertConsensus) ===
          JSON.stringify(expertConsensus)
      ) {
        return false;
      }
      const next: UnifiedRoundRecord = {
        ...copyUnified(previous),
        sherdog: copySherdog(observation),
        ...(expertConsensus === undefined
          ? {}
          : {
              expertConsensus: copyExpertConsensus(expertConsensus),
            }),
      };
      await this.persistUnified(next);
      return true;
    });
  }

  setMarketSnapshot(snapshot: MarketSnapshot): Promise<void> {
    return this.enqueueState(async () => {
      const stored = copyMarketSnapshot(snapshot);
      this.marketSnapshots.set(
        marketBoundaryKey(
          stored.boutId,
          stored.round,
          stored.boundaryType,
          stored.source,
        ),
        stored,
      );
      const key = roundKey(stored.boutId, stored.round);
      const previous = this.unified.get(key);
      if (
        previous === undefined ||
        boundaryTypeForRecord(previous) !== stored.boundaryType
      ) {
        return;
      }
      const field = marketField(stored.source);
      if (
        JSON.stringify(previous.marketAtEnd[field]) ===
        JSON.stringify(stored)
      ) {
        return;
      }
      const next = copyUnified(previous);
      next.marketAtEnd[field] = stored;
      await this.persistUnified(next);
    });
  }

  removeMarketSnapshots(
    boutId: string,
    round: number,
    boundaryType: MarketBoundaryType,
  ): Promise<void> {
    return this.enqueueState(async () => {
      for (const source of [
        "kalshi",
        "polymarket",
        "odds-api-io",
        "the-odds-api",
      ] as const) {
        this.marketSnapshots.delete(
          marketBoundaryKey(boutId, round, boundaryType, source),
        );
      }
      const previous = this.unified.get(roundKey(boutId, round));
      if (
        previous === undefined ||
        boundaryTypeForRecord(previous) !== boundaryType ||
        Object.keys(previous.marketAtEnd).length === 0
      ) {
        return;
      }
      const next = copyUnified(previous);
      next.marketAtEnd = {};
      await this.persistUnified(next);
    });
  }

  async idle(): Promise<void> {
    while (true) {
      const eventQueue = this.eventQueue;
      await eventQueue;
      await this.scheduler.idle();
      await this.stateQueue;
      await this.requestQueue;
      if (eventQueue === this.eventQueue) return;
    }
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    await this.eventQueue;
    await this.scheduler.close();
    await this.stateQueue;
    await this.requestQueue;
  }

  private enqueueEvent(operation: () => Promise<void>): void {
    this.eventQueue = this.eventQueue
      .then(operation)
      .catch(() => undefined);
  }

  private enqueueState<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const result = this.stateQueue.then(operation);
    this.stateQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async restoreFromStorage(): Promise<void> {
    const [statsRecords, unifiedRecords] = await Promise.all([
      this.storage.read<unknown>(ROUND_STATS_STORAGE_STREAM),
      this.storage.read<unknown>(UNIFIED_ROUNDS_STORAGE_STREAM),
    ]);

    this.stats.clear();
    this.histories.clear();
    for (const persisted of statsRecords) {
      if (!isPersistedRoundStats(persisted)) continue;
      const record = copyRoundStats(persisted.record);
      const key = roundKey(record.boutId, record.round);
      this.stats.set(key, record);
      const history = this.histories.get(key) ?? [];
      if (
        !history.some(
          (entry) =>
            entry.revision === record.revision &&
            entry.payloadHash === record.payloadHash,
        )
      ) {
        history.push(record);
        history.sort((left, right) => left.revision - right.revision);
        this.histories.set(key, history);
      }
    }

    this.unified.clear();
    this.confirmedRounds.clear();
    this.marketSnapshots.clear();
    for (const persisted of unifiedRecords) {
      if (!isPersistedUnifiedRound(persisted)) continue;
      const record = copyUnified(persisted.record);
      const key = roundKey(record.boutId, record.round);
      this.unified.set(key, record);
      if (record.endingSignal !== "clock_zero_provisional") {
        this.confirmedRounds.add(key);
      }
    }

    for (const record of this.unified.values()) {
      const boundaryType = boundaryTypeForRecord(record);
      for (const snapshot of Object.values(record.marketAtEnd)) {
        this.marketSnapshots.set(
          marketBoundaryKey(
            snapshot.boutId,
            snapshot.round,
            boundaryType,
            snapshot.source,
          ),
          copyMarketSnapshot(snapshot),
        );
      }
    }

    await this.quota.restore();
    await this.scheduler.restore();
  }

  private async onRoundBoundary(
    event: RoundBoundaryEvent,
  ): Promise<void> {
    await this.restore();
    const key = roundKey(event.boutId, event.round);

    this.espnAccumulator.markRoundEnded(
      event.boutId,
      event.round,
      event.detectedAt,
    );

    if (event.type === "ROUND_ENDED") {
      this.confirmedRounds.add(key);
      await this.confirmExistingStats(event.boutId, event.round);
    }

    await this.updateUnifiedBoundary(event);
    if (!this.citoJobsEnabled) return;
    await this.scheduler.schedule({
      boutId: event.boutId,
      round: event.round,
      jobType: CITO_ROUND_STATS_JOB_TYPE,
      dueAt: this.clock.now() + this.initialDelayMs,
      retryPolicy: {
        delayMs: this.retryDelayMs,
        maxAttempts: 2,
      },
    });
  }

  private async onFightEnded(
    event: Extract<CollectorEvent, { type: "FIGHT_ENDED" }>,
  ): Promise<void> {
    await this.restore();
    for (let round = 1; round <= event.round; round += 1) {
      this.confirmedRounds.add(roundKey(event.boutId, round));
    }

    if (!this.citoJobsEnabled) return;
    await this.scheduler.schedule({
      boutId: event.boutId,
      round: event.round,
      jobType: CITO_RECONCILIATION_JOB_TYPE,
      dueAt: this.clock.now(),
      retryPolicy: { delayMs: 0, maxAttempts: 1 },
    });
  }

  private async runRoundFetch(job: RoundJob): Promise<void> {
    let payload: CitoRoundStatsPayload | null;
    try {
      payload = await this.citoRequest(() =>
        this.fetcher.fetchRound(job.boutId, job.round),
      );
    } catch (error) {
      if (error instanceof TerminalRoundJobError) throw error;
      const terminal = terminalCitoError(error);
      if (terminal !== undefined) throw terminal;
      if (error instanceof CitoRoundStatsRequestError) throw error;
      throw new TerminalRoundJobError(
        `Cito round request failed: ${errorText(error)}`,
      );
    }

    if (payload === null) {
      throw new Error(
        `Cito round ${job.round} is absent for ${job.boutId}`,
      );
    }
    if (
      payload.boutId !== job.boutId ||
      payload.round !== job.round ||
      completePayload(payload) === undefined
    ) {
      throw new Error(
        `Cito round ${job.round} is structurally incomplete for ${job.boutId}`,
      );
    }

    await this.observePayload(payload);
  }

  private async runReconciliation(job: RoundJob): Promise<void> {
    let payloads: CitoRoundStatsPayload[];
    try {
      payloads = await this.citoRequest(() =>
        this.fetcher.fetchAllRounds(job.boutId),
      );
    } catch (error) {
      if (error instanceof TerminalRoundJobError) throw error;
      const terminal = terminalCitoError(error);
      if (terminal !== undefined) throw terminal;
      if (error instanceof CitoRoundStatsRequestError) throw error;
      throw new TerminalRoundJobError(
        `Cito reconciliation failed: ${errorText(error)}`,
      );
    }

    for (const payload of payloads) {
      if (
        payload.boutId === job.boutId &&
        payload.round >= 1 &&
        payload.round <= job.round &&
        completePayload(payload) !== undefined
      ) {
        await this.observePayload(payload);
      }
    }
  }

  private citoRequest<Result>(
    request: () => Promise<Result>,
  ): Promise<Result> {
    let result: Result | undefined;
    const operation = this.requestQueue.then(async () => {
      if (!(await this.quota.tryAcquire("cito"))) {
        throw new TerminalRoundJobError(
          "Cito quota exhausted; request was not attempted",
        );
      }
      result = await request();
    });
    this.requestQueue = operation.then(
      () => undefined,
      () => undefined,
    );

    return operation.then(() => result as Result);
  }

  private async observePayload(
    payload: CitoRoundStatsPayload,
  ): Promise<void> {
    const complete = completePayload(payload);
    if (complete === undefined || payload.boutId === undefined) return;
    const boutId = payload.boutId;

    await this.enqueueState(async () => {
      const key = roundKey(boutId, payload.round);
      const previous = this.stats.get(key);
      const observedAt = new Date(this.clock.now()).toISOString();
      const hash = payloadHash(complete);
      const provisional = !this.confirmedRounds.has(key);
      const next: RoundStatsRecord = {
        boutId,
        round: payload.round,
        fighterA: complete.fighterA,
        fighterB: complete.fighterB,
        provisional,
        revision:
          previous === undefined
            ? 1
            : previous.payloadHash === hash
              ? previous.revision
              : previous.revision + 1,
        payloadHash: hash,
        ...(payload.sourceUpdatedAt === undefined
          ? previous?.sourceUpdatedAt === undefined
            ? {}
            : { sourceUpdatedAt: previous.sourceUpdatedAt }
          : { sourceUpdatedAt: payload.sourceUpdatedAt }),
        firstObservedAt:
          previous?.firstObservedAt ?? observedAt,
        lastObservedAt: observedAt,
      };

      this.metrics.recordPayload(
        "cito",
        next.sourceUpdatedAt,
        observedAt,
      );
      const boundary = this.unified.get(key);
      if (boundary !== undefined) {
        this.metrics.set(
          "round_stats_availability_delay_ms",
          "cito",
          Math.max(
            0,
            Date.parse(observedAt) -
              Date.parse(boundary.detectedEndedAt),
          ),
          {
            ...(next.sourceUpdatedAt === undefined
              ? {}
              : { sourceTimestamp: next.sourceUpdatedAt }),
            localTimestamp: observedAt,
          },
        );
      }
      if (
        previous !== undefined &&
        previous.payloadHash !== next.payloadHash
      ) {
        this.metrics.increment("revisions_total", "cito", 1, {
          ...(next.sourceUpdatedAt === undefined
            ? {}
            : { sourceTimestamp: next.sourceUpdatedAt }),
          localTimestamp: observedAt,
        });
      }
      await this.persistStats(next);
      await this.updateUnifiedStats(next);
    });
  }

  private async confirmExistingStats(
    boutId: string,
    round: number,
  ): Promise<void> {
    await this.enqueueState(async () => {
      const key = roundKey(boutId, round);
      const previous = this.stats.get(key);
      if (previous === undefined || !previous.provisional) return;

      const confirmed: RoundStatsRecord = {
        ...copyRoundStats(previous),
        provisional: false,
      };
      await this.persistStats(confirmed);
    });
  }

  private async persistStats(record: RoundStatsRecord): Promise<void> {
    const stored = copyRoundStats(record);
    await this.storage.append(ROUND_STATS_STORAGE_STREAM, {
      version: 1,
      record: stored,
    } satisfies PersistedRoundStats);
    const key = roundKey(stored.boutId, stored.round);
    const previous = this.stats.get(key);
    this.stats.set(key, stored);

    if (
      previous === undefined ||
      previous.payloadHash !== stored.payloadHash
    ) {
      const history = this.histories.get(key) ?? [];
      history.push(stored);
      this.histories.set(key, history);
    }
  }

  private async updateUnifiedBoundary(
    event: RoundBoundaryEvent,
  ): Promise<void> {
    await this.enqueueState(async () => {
      const key = roundKey(event.boutId, event.round);
      const previous = this.unified.get(key);
      const signal = endingSignal(event);
      if (
        previous !== undefined &&
        ((previous.endingSignal === signal &&
          previous.detectedEndedAt === event.detectedAt) ||
          (event.type === "PROVISIONAL_ROUND_ENDED" &&
            previous.endingSignal !== "clock_zero_provisional"))
      ) {
        return;
      }

      const stats = this.stats.get(key);
      const provisional =
        event.type === "PROVISIONAL_ROUND_ENDED" ||
        stats === undefined ||
        stats.provisional;
      const next: UnifiedRoundRecord = {
        boutId: event.boutId,
        round: event.round,
        detectedEndedAt: event.detectedAt,
        endingSignal: signal,
        ...(stats === undefined
          ? {}
          : { citoStats: copyRoundStats(stats) }),
        ...(previous?.sherdog === undefined
          ? {}
          : { sherdog: copySherdog(previous.sherdog) }),
        marketAtEnd: this.marketAtEndFor(
          event.boutId,
          event.round,
          event.type === "PROVISIONAL_ROUND_ENDED"
            ? "provisional"
            : "confirmed",
        ),
        ...(previous?.expertConsensus === undefined
          ? {}
          : {
              expertConsensus: copyExpertConsensus(
                previous.expertConsensus,
              ),
            }),
        provisional,
        ...(!provisional
          ? {
              finalizedAt:
                previous?.finalizedAt ??
                new Date(this.clock.now()).toISOString(),
            }
          : {}),
      };
      if (
        next.provisional &&
        (previous === undefined || !previous.provisional)
      ) {
        this.metrics.increment(
          "provisional_records_total",
          "collector",
          1,
          { localTimestamp: event.detectedAt },
        );
      }
      await this.persistUnified(next);
    });
  }

  private async updateUnifiedStats(
    stats: RoundStatsRecord,
  ): Promise<void> {
    const key = roundKey(stats.boutId, stats.round);
    const previous = this.unified.get(key);
    if (previous === undefined) return;

    const provisional =
      !this.confirmedRounds.has(key) || stats.provisional;
    const next: UnifiedRoundRecord = {
      ...copyUnified(previous),
      citoStats: copyRoundStats(stats),
      provisional,
      ...(!provisional
        ? {
            finalizedAt:
              previous.finalizedAt ??
              new Date(this.clock.now()).toISOString(),
          }
        : {}),
    };
    await this.persistUnified(next);
  }

  private async persistUnified(
    record: UnifiedRoundRecord,
  ): Promise<void> {
    const stored = copyUnified(record);
    await this.storage.append(UNIFIED_ROUNDS_STORAGE_STREAM, {
      version: 1,
      record: stored,
    } satisfies PersistedUnifiedRound);
    this.unified.set(roundKey(stored.boutId, stored.round), stored);
    if (this.publish !== undefined) {
      await this.publish(copyUnified(stored)).catch(() => undefined);
    }
  }

  private marketAtEndFor(
    boutId: string,
    round: number,
    boundaryType: MarketBoundaryType,
  ): MarketAtEnd {
    const result: MarketAtEnd = {};
    for (const source of [
      "kalshi",
      "polymarket",
      "odds-api-io",
      "the-odds-api",
    ] as const) {
      const snapshot = this.marketSnapshots.get(
        marketBoundaryKey(boutId, round, boundaryType, source),
      );
      if (snapshot !== undefined) {
        result[marketField(source)] = copyMarketSnapshot(snapshot);
      }
    }
    return result;
  }
}
