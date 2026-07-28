import type { Bout } from "../src/schema.ts";
import {
  THE_ODDS_API_H2H_REQUEST,
  type TheOddsApiSource,
} from "../src/sources/oddsapi.ts";
import { sportsbookSnapshotToMarketTicks } from "../src/sources/oddsApiIo.ts";
import type { MarketTick } from "../src/sources/contract.ts";
import type {
  CollectorEvent,
  CollectorEventBus,
} from "./eventBus.ts";
import {
  RoundJobScheduler,
  TerminalRoundJobError,
  type RoundJob,
  type RoundJobClock,
} from "./roundJobs.ts";
import type { MarketTickStore } from "./tickStore.ts";
import { NOOP_METRICS, type Metrics } from "./health.ts";

export const THE_ODDS_API_ROUND_JOB_TYPE =
  "the_odds_api_round_snapshot";
export const THE_ODDS_API_MIN_DELAY_MS = 20_000;
export const THE_ODDS_API_MAX_DELAY_MS = 30_000;

export interface TheOddsApiRoundJobOptions {
  eventBus: CollectorEventBus;
  scheduler: RoundJobScheduler;
  source: Pick<TheOddsApiSource, "getH2hSnapshot">;
  tickStore: Pick<MarketTickStore, "ingest" | "snapshotSource">;
  getBout(boutId: string): Bout | undefined;
  clock?: RoundJobClock;
  random?: () => number;
  publishTick?: (tick: MarketTick) => Promise<void>;
  metrics?: Metrics;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function theOddsApiDelayMs(random: number): number {
  if (!Number.isFinite(random) || random < 0 || random > 1) {
    throw new TypeError("The Odds API delay sample must be between 0 and 1");
  }
  return (
    THE_ODDS_API_MIN_DELAY_MS +
    Math.round(
      random *
        (THE_ODDS_API_MAX_DELAY_MS - THE_ODDS_API_MIN_DELAY_MS),
    )
  );
}

export class TheOddsApiRoundJob {
  private readonly eventBus: CollectorEventBus;

  private readonly scheduler: RoundJobScheduler;

  private readonly source: TheOddsApiRoundJobOptions["source"];

  private readonly tickStore: TheOddsApiRoundJobOptions["tickStore"];

  private readonly getBout: TheOddsApiRoundJobOptions["getBout"];

  private readonly clock: RoundJobClock;

  private readonly random: () => number;

  private readonly publishTick:
    | ((tick: MarketTick) => Promise<void>)
    | undefined;

  private readonly metrics: Metrics;

  private readonly unsubscribe: () => void;

  private eventQueue: Promise<void> = Promise.resolve();

  constructor(options: TheOddsApiRoundJobOptions) {
    this.eventBus = options.eventBus;
    this.scheduler = options.scheduler;
    this.source = options.source;
    this.tickStore = options.tickStore;
    this.getBout = options.getBout;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.random = options.random ?? Math.random;
    this.publishTick = options.publishTick;
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.scheduler.registerHandler(
      THE_ODDS_API_ROUND_JOB_TYPE,
      (job) => this.run(job),
    );
    this.unsubscribe = this.eventBus.subscribe(
      "ROUND_ENDED",
      (event) => {
        this.eventQueue = this.eventQueue
          .then(() => this.schedule(event))
          .catch(() => undefined);
      },
    );
  }

  async idle(): Promise<void> {
    await this.eventQueue;
    await this.scheduler.idle();
  }

  async close(): Promise<void> {
    this.unsubscribe();
    await this.eventQueue;
  }

  private async schedule(
    event: Extract<CollectorEvent, { type: "ROUND_ENDED" }>,
  ): Promise<void> {
    await this.scheduler.schedule({
      boutId: event.boutId,
      round: event.round,
      jobType: THE_ODDS_API_ROUND_JOB_TYPE,
      dueAt:
        this.clock.now() + theOddsApiDelayMs(this.random()),
      retryPolicy: { delayMs: 0, maxAttempts: 1 },
    });
  }

  private async run(job: RoundJob): Promise<void> {
    const bout = this.getBout(job.boutId);
    if (bout === undefined) {
      throw new TerminalRoundJobError(
        `The Odds API bout mapping is absent for ${job.boutId}`,
      );
    }

    let snapshot;
    this.metrics.increment(
      "source_requests_total",
      "the-odds-api",
      1,
      { localTimestamp: new Date(this.clock.now()).toISOString() },
    );
    try {
      snapshot = await this.source.getH2hSnapshot(
        bout,
        THE_ODDS_API_H2H_REQUEST,
      );
    } catch (error) {
      throw new TerminalRoundJobError(
        `The Odds API request failed: ${errorText(error)}`,
      );
    }
    if (snapshot === null) return;

    const receivedAt = new Date(this.clock.now()).toISOString();
    const ticks = sportsbookSnapshotToMarketTicks(
      bout,
      snapshot,
      "the-odds-api",
      receivedAt,
    );
    if (ticks.length === 0) return;
    for (const tick of ticks) {
      await this.tickStore.ingest(tick);
      await this.publishTick?.(tick).catch(() => undefined);
    }
    await this.tickStore.snapshotSource(
      job.boutId,
      job.round,
      "the-odds-api",
      "confirmed",
      receivedAt,
      "broad-post-round-comparison",
    );
  }
}
