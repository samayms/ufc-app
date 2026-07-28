import type { Bout } from "../src/schema.ts";
import {
  OddsApiIoRequestError,
  sportsbookSnapshotToMarketTicks,
  type OddsApiIoSource,
} from "../src/sources/oddsApiIo.ts";
import type { MarketTick } from "../src/sources/contract.ts";
import type {
  CollectorEvent,
  CollectorEventBus,
} from "./eventBus.ts";
import {
  DEFAULT_ODDS_API_IO_QUOTA_POLICY,
  RollingQuotaGuard,
  type QuotaClock,
  type QuotaPolicy,
  type QuotaRemaining,
} from "./quota.ts";
import type { Storage } from "./storage.ts";
import type { MarketTickStore } from "./tickStore.ts";
import { NOOP_METRICS, type Metrics } from "./health.ts";

export const ODDS_API_IO_QUOTA_SOURCE = "odds-api-io";
export const ODDS_API_IO_DEFAULT_INTERVAL_MS = 30_000;
export const ODDS_API_IO_MID_INTERVAL_MS = 45_000;
export const ODDS_API_IO_LOW_INTERVAL_MS = 60_000;

export interface OddsApiIoPollingPolicy {
  mode: "periodic" | "boundary-only";
  intervalMs?: number;
}

export interface OddsApiIoPollTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ResolvedOddsApiIoBout {
  bout: Bout;
  externalBoutId: string;
}

export interface OddsApiIoPollerOptions {
  eventBus: CollectorEventBus;
  storage: Storage;
  source: OddsApiIoSource;
  tickStore: Pick<MarketTickStore, "ingest" | "snapshotSource">;
  resolveBout(boutId: string): ResolvedOddsApiIoBout | undefined;
  bookmakers: readonly string[];
  clock?: QuotaClock;
  timer?: OddsApiIoPollTimer;
  quota?: RollingQuotaGuard;
  quotaPolicy?: QuotaPolicy;
  publishTick?: (tick: MarketTick) => Promise<void>;
  metrics?: Metrics;
}

type PollReason = "periodic" | "boundary" | "final";
type RequestResult =
  | { status: "accepted"; receivedAt?: string }
  | { status: "failed" | "terminal" };

export function oddsApiIoPollingPolicy(
  remaining: Pick<QuotaRemaining, "hour" | "day">,
): OddsApiIoPollingPolicy {
  if (remaining.day < 30) return { mode: "boundary-only" };
  if (remaining.hour > 30) {
    return {
      mode: "periodic",
      intervalMs: ODDS_API_IO_DEFAULT_INTERVAL_MS,
    };
  }
  if (remaining.hour >= 15) {
    return {
      mode: "periodic",
      intervalMs: ODDS_API_IO_MID_INTERVAL_MS,
    };
  }
  return {
    mode: "periodic",
    intervalMs: ODDS_API_IO_LOW_INTERVAL_MS,
  };
}

function defaultTimer(): OddsApiIoPollTimer {
  return {
    setTimeout: (callback, delayMs) =>
      globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(
        handle as ReturnType<typeof globalThis.setTimeout>,
      ),
  };
}

function isTerminalRequestError(error: unknown): boolean {
  return (
    error instanceof OddsApiIoRequestError &&
    (error.kind === "auth" ||
      error.kind === "quota" ||
      error.kind === "unavailable")
  );
}

function isTransientRequestError(error: unknown): boolean {
  return (
    error instanceof OddsApiIoRequestError &&
    error.kind === "transient"
  );
}

export class OddsApiIoPoller {
  readonly quota: RollingQuotaGuard;

  private readonly eventBus: CollectorEventBus;

  private readonly source: OddsApiIoSource;

  private readonly tickStore: OddsApiIoPollerOptions["tickStore"];

  private readonly resolveBout: OddsApiIoPollerOptions["resolveBout"];

  private readonly bookmakers: readonly string[];

  private readonly clock: QuotaClock;

  private readonly timer: OddsApiIoPollTimer;

  private readonly publishTick:
    | ((tick: MarketTick) => Promise<void>)
    | undefined;

  private readonly metrics: Metrics;

  private readonly activeBouts = new Set<string>();

  private readonly timers = new Map<string, unknown>();

  private readonly unsubscribers: Array<() => void> = [];

  private operationQueue: Promise<void> = Promise.resolve();

  private halted = false;

  private closed = false;

  constructor(options: OddsApiIoPollerOptions) {
    if (options.bookmakers.length === 0) {
      throw new TypeError("Odds-API.io requires at least one bookmaker");
    }
    this.eventBus = options.eventBus;
    this.source = options.source;
    this.tickStore = options.tickStore;
    this.resolveBout = options.resolveBout;
    this.bookmakers = [...new Set(
      options.bookmakers.map((bookmaker) => bookmaker.toLowerCase()),
    )];
    this.clock = options.clock ?? { now: () => Date.now() };
    this.timer = options.timer ?? defaultTimer();
    this.publishTick = options.publishTick;
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.quota =
      options.quota ??
      new RollingQuotaGuard({
        storage: options.storage,
        policies: {
          [ODDS_API_IO_QUOTA_SOURCE]:
            options.quotaPolicy ?? DEFAULT_ODDS_API_IO_QUOTA_POLICY,
        },
        clock: this.clock,
        metrics: this.metrics,
      });

    this.unsubscribers.push(
      this.eventBus.subscribe("FIGHT_STARTED", (event) => {
        this.enqueue(() => this.onFightStarted(event));
      }),
      this.eventBus.subscribe("PROVISIONAL_ROUND_ENDED", (event) => {
        this.enqueue(() => this.onBoundary(event));
      }),
      this.eventBus.subscribe("FIGHT_ENDED", (event) => {
        this.enqueue(() => this.onFightEnded(event));
      }),
    );
  }

  static async create(
    options: OddsApiIoPollerOptions,
  ): Promise<OddsApiIoPoller> {
    const poller = new OddsApiIoPoller(options);
    await poller.quota.restore();
    return poller;
  }

  startActiveBout(boutId: string): void {
    this.enqueue(async () => {
      if (this.closed || this.halted || this.activeBouts.has(boutId)) return;
      this.activeBouts.add(boutId);
      await this.poll(boutId, "periodic");
    });
  }

  isActive(boutId: string): boolean {
    return this.activeBouts.has(boutId);
  }

  async idle(): Promise<void> {
    while (true) {
      const queue = this.operationQueue;
      await queue;
      if (queue === this.operationQueue) return;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const handle of this.timers.values()) {
      this.timer.clearTimeout(handle);
    }
    this.timers.clear();
    this.activeBouts.clear();
    await this.idle();
  }

  private enqueue(operation: () => Promise<void>): void {
    this.operationQueue = this.operationQueue
      .then(operation)
      .catch(() => undefined);
  }

  private async onFightStarted(
    event: Extract<CollectorEvent, { type: "FIGHT_STARTED" }>,
  ): Promise<void> {
    if (this.closed || this.halted || this.activeBouts.has(event.boutId)) {
      return;
    }
    this.activeBouts.add(event.boutId);
    await this.poll(event.boutId, "periodic");
  }

  private async onBoundary(
    event: Extract<
      CollectorEvent,
      { type: "PROVISIONAL_ROUND_ENDED" }
    >,
  ): Promise<void> {
    if (!this.activeBouts.has(event.boutId) || this.halted) return;
    this.clearTimer(event.boutId);
    await this.poll(event.boutId, "boundary", event.round);
  }

  private async onFightEnded(
    event: Extract<CollectorEvent, { type: "FIGHT_ENDED" }>,
  ): Promise<void> {
    if (!this.activeBouts.has(event.boutId)) return;
    this.clearTimer(event.boutId);
    if (!this.halted) {
      await this.poll(event.boutId, "final", event.round);
    }
    this.activeBouts.delete(event.boutId);
  }

  private async poll(
    boutId: string,
    reason: PollReason,
    round?: number,
  ): Promise<void> {
    if (
      this.closed ||
      this.halted ||
      !this.activeBouts.has(boutId)
    ) {
      return;
    }
    const remaining = await this.quota.remaining(
      ODDS_API_IO_QUOTA_SOURCE,
    );
    const policy = oddsApiIoPollingPolicy(remaining);
    if (reason === "periodic" && policy.mode === "boundary-only") {
      return;
    }

    const result = await this.request(boutId);
    if (result.status === "terminal") {
      this.halted = true;
      for (const handle of this.timers.values()) {
        this.timer.clearTimeout(handle);
      }
      this.timers.clear();
      return;
    }
    if (
      result.status === "accepted" &&
      result.receivedAt !== undefined &&
      round !== undefined &&
      reason !== "periodic"
    ) {
      await this.tickStore.snapshotSource(
        boutId,
        round,
        "odds-api-io",
        reason === "boundary" ? "provisional" : "confirmed",
        result.receivedAt,
      );
    }
    if (reason !== "final" && this.activeBouts.has(boutId)) {
      await this.scheduleNext(boutId);
    }
  }

  private async request(
    boutId: string,
  ): Promise<RequestResult> {
    const resolved = this.resolveBout(boutId);
    if (resolved === undefined) return { status: "failed" };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!(await this.quota.tryAcquire(ODDS_API_IO_QUOTA_SOURCE))) {
        return { status: "terminal" };
      }
      const startedAt = this.clock.now();
      try {
        const snapshot = await this.source.getBoutOdds({
          bout: resolved.bout,
          externalBoutId: resolved.externalBoutId,
          bookmakers: this.bookmakers,
        });
        if (snapshot === null) return { status: "accepted" };
        const receivedAt = new Date(this.clock.now()).toISOString();
        const ticks = sportsbookSnapshotToMarketTicks(
          resolved.bout,
          snapshot,
          "odds-api-io",
          receivedAt,
        );
        for (const tick of ticks) {
          await this.tickStore.ingest(tick);
          await this.publishTick?.(tick).catch(() => undefined);
        }
        this.metrics.set(
          "source_response_latency_ms",
          ODDS_API_IO_QUOTA_SOURCE,
          Math.max(0, this.clock.now() - startedAt),
          { localTimestamp: receivedAt },
        );
        return { status: "accepted", receivedAt };
      } catch (error) {
        this.metrics.increment(
          "source_errors_total",
          ODDS_API_IO_QUOTA_SOURCE,
          1,
          {
            localTimestamp: new Date(this.clock.now()).toISOString(),
          },
        );
        if (isTerminalRequestError(error)) {
          return { status: "terminal" };
        }
        if (!isTransientRequestError(error) || attempt === 1) {
          return { status: "failed" };
        }
      }
    }
    return { status: "failed" };
  }

  private async scheduleNext(boutId: string): Promise<void> {
    this.clearTimer(boutId);
    const policy = oddsApiIoPollingPolicy(
      await this.quota.remaining(ODDS_API_IO_QUOTA_SOURCE),
    );
    if (
      policy.mode === "boundary-only" ||
      policy.intervalMs === undefined ||
      this.closed ||
      this.halted
    ) {
      return;
    }
    const handle = this.timer.setTimeout(() => {
      this.timers.delete(boutId);
      this.enqueue(() => this.poll(boutId, "periodic"));
    }, policy.intervalMs);
    this.timers.set(boutId, handle);
  }

  private clearTimer(boutId: string): void {
    const handle = this.timers.get(boutId);
    if (handle !== undefined) this.timer.clearTimeout(handle);
    this.timers.delete(boutId);
  }
}
