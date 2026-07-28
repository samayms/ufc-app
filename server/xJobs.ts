import type { Bout } from "../src/schema.ts";
import type {
  ParsedExpertScore,
  XScoreSource,
} from "../src/sources/x.ts";
import type {
  CollectorEvent,
  CollectorEventBus,
} from "./eventBus.ts";
import { computeExpertConsensus } from "./expertConsensus.ts";
import { SpendingCapGuard } from "./quota.ts";
import type { RoundStatsPipeline } from "./roundStats.ts";
import {
  RoundJobScheduler,
  TerminalRoundJobError,
  type RoundJob,
  type RoundJobClock,
} from "./roundJobs.ts";
import type { Storage } from "./storage.ts";

export const X_API_ROUND_JOB_TYPE = "x_api_round";
export const X_API_LATE_CHECK_DELAY_MS = 40_000;
export const X_API_SPEND_SOURCE = "x-api";

export interface XRoundJobsOptions {
  eventBus: CollectorEventBus;
  scheduler: RoundJobScheduler;
  storage: Storage;
  source: XScoreSource;
  roundStats: Pick<
    RoundStatsPipeline,
    "getUnifiedRound" | "setXScores" | "idle"
  >;
  getBout(boutId: string): Bout | undefined;
  spendingCapUsd: number;
  requestCostUsd: number;
  clock?: RoundJobClock;
  spending?: SpendingCapGuard;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deduplicateScores(
  scores: readonly ParsedExpertScore[],
): ParsedExpertScore[] {
  const unique = new Map<string, ParsedExpertScore>();
  for (const score of scores) {
    const key = `${score.source}:${score.sourcePostId}`;
    if (!unique.has(key)) {
      unique.set(key, {
        ...score,
        score: { ...score.score },
      });
    }
  }
  return [...unique.values()];
}

export class XRoundJobs {
  readonly spending: SpendingCapGuard;

  private readonly eventBus: CollectorEventBus;

  private readonly scheduler: RoundJobScheduler;

  private readonly source: XScoreSource;

  private readonly roundStats: XRoundJobsOptions["roundStats"];

  private readonly getBout: XRoundJobsOptions["getBout"];

  private readonly requestCostUsd: number;

  private readonly clock: RoundJobClock;

  private readonly unsubscribe: () => void;

  private eventQueue: Promise<void> = Promise.resolve();

  constructor(options: XRoundJobsOptions) {
    if (
      !Number.isFinite(options.requestCostUsd) ||
      options.requestCostUsd <= 0
    ) {
      throw new TypeError("X request cost must be a positive number");
    }
    this.eventBus = options.eventBus;
    this.scheduler = options.scheduler;
    this.source = options.source;
    this.roundStats = options.roundStats;
    this.getBout = options.getBout;
    this.requestCostUsd = options.requestCostUsd;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.spending =
      options.spending ??
      new SpendingCapGuard({
        storage: options.storage,
        capsUsd: { [X_API_SPEND_SOURCE]: options.spendingCapUsd },
        clock: this.clock,
      });

    if (this.source.mode === "api") {
      this.scheduler.registerHandler(
        X_API_ROUND_JOB_TYPE,
        (job) => this.runApi(job),
      );
    }
    this.unsubscribe = this.eventBus.subscribe(
      "ROUND_ENDED",
      (event) => {
        this.eventQueue = this.eventQueue
          .then(() => this.onRoundEnded(event))
          .catch(() => undefined);
      },
    );
  }

  static async create(options: XRoundJobsOptions): Promise<XRoundJobs> {
    const jobs = new XRoundJobs(options);
    await jobs.spending.restore();
    return jobs;
  }

  async idle(): Promise<void> {
    await this.eventQueue;
    await this.scheduler.idle();
  }

  async close(): Promise<void> {
    this.unsubscribe();
    await this.eventQueue;
  }

  private async onRoundEnded(
    event: Extract<CollectorEvent, { type: "ROUND_ENDED" }>,
  ): Promise<void> {
    if (this.source.mode === "disabled") return;
    if (this.source.mode === "api") {
      await this.scheduler.schedule({
        boutId: event.boutId,
        round: event.round,
        jobType: X_API_ROUND_JOB_TYPE,
        dueAt: this.clock.now() + X_API_LATE_CHECK_DELAY_MS,
        retryPolicy: { delayMs: 0, maxAttempts: 1 },
      });
      return;
    }
    await this.roundStats.idle();
    await this.deliver(
      event.boutId,
      event.round,
      this.source.configuredScores(event.boutId, event.round),
    );
  }

  private async runApi(job: RoundJob): Promise<void> {
    if (
      !(await this.spending.trySpend(
        X_API_SPEND_SOURCE,
        this.requestCostUsd,
      ))
    ) {
      throw new TerminalRoundJobError(
        "X API spending cap exhausted; request was not attempted",
      );
    }

    let scores: ParsedExpertScore[];
    try {
      scores = await this.source.fetchApiScores(job.boutId, job.round);
    } catch (error) {
      throw new TerminalRoundJobError(
        `X API round check failed: ${errorText(error)}`,
      );
    }
    await this.deliver(job.boutId, job.round, scores);
  }

  private async deliver(
    boutId: string,
    round: number,
    scores: readonly ParsedExpertScore[],
  ): Promise<void> {
    const bout = this.getBout(boutId);
    if (bout === undefined) {
      throw new TerminalRoundJobError(
        `X bout mapping is absent for ${boutId}`,
      );
    }
    const unique = deduplicateScores(scores);
    if (unique.length === 0) return;
    const existing = this.roundStats.getUnifiedRound(boutId, round);
    await this.roundStats.setXScores(
      boutId,
      round,
      unique,
      computeExpertConsensus(bout, existing?.sherdog, unique),
    );
  }
}
