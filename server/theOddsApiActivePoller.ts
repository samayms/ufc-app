/**
 * The Odds API polling while a bout is actually live.
 *
 * This sits *beside* `TheOddsApiRoundJob`, which already owns the round-end
 * snapshot (with its deliberate 20–30s settle delay and its
 * `broad-post-round-comparison` label). Duplicating that here would write two
 * snapshots for the same boundary, so this poller covers only the three things
 * the round job does not: fight start, the periodic interval in between, and
 * fight completion.
 *
 * The quota tension is the whole design. The plan for this account is 500
 * requests a *month*. A 45s poll across a thirteen-fight card would spend that
 * in a single event, so `THE_ODDS_API_ACTIVE_POLL_MS` is a target, not a
 * promise: the rolling guard slows polling as the monthly reserve drops and
 * stops it entirely below the reserve, leaving only the round job's boundary
 * fetches. Quota protection always wins over the target interval.
 *
 * Requests never overlap — every operation goes through one serialized queue —
 * and a failed request leaves the previous ticks in place rather than
 * clearing them, so the dashboard keeps showing the last real price.
 */

import type { Bout } from "../src/schema.ts";
import {
  THE_ODDS_API_H2H_REQUEST,
  type TheOddsApiSource,
} from "../src/sources/oddsapi.ts";
import { sportsbookSnapshotToMarketTicks } from "../src/sources/oddsApiIo.ts";
import type { MarketTick } from "../src/sources/contract.ts";
import type { CollectorEvent, CollectorEventBus } from "./eventBus.ts";
import {
  RollingQuotaGuard,
  type QuotaClock,
  type QuotaPolicy,
  type QuotaRemaining,
} from "./quota.ts";
import type { Storage } from "./storage.ts";
import type { MarketTickStore } from "./tickStore.ts";
import { NOOP_METRICS, type Metrics } from "./health.ts";

export const THE_ODDS_API_QUOTA_SOURCE = "the-odds-api";
export const THE_ODDS_API_DEFAULT_ACTIVE_INTERVAL_MS = 45_000;
export const THE_ODDS_API_MID_INTERVAL_MS = 90_000;
export const THE_ODDS_API_LOW_INTERVAL_MS = 180_000;

/**
 * Conservative defaults for a 500-request *month*. The per-day figure leaves
 * room for the twice-daily upcoming sync and a full event on the same day;
 * per-hour caps how fast one live card can burn through it.
 */
export const DEFAULT_THE_ODDS_API_QUOTA_POLICY: QuotaPolicy = {
  perMinute: 4,
  perHour: 60,
  perDay: 120,
};

export interface TheOddsApiPollingPolicy {
  mode: "periodic" | "boundary-only";
  intervalMs?: number;
}

export interface TheOddsApiPollTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TheOddsApiActivePollerOptions {
  eventBus: CollectorEventBus;
  storage: Storage;
  source: Pick<TheOddsApiSource, "getH2hSnapshot">;
  tickStore: Pick<MarketTickStore, "ingest" | "snapshotSource">;
  getBout(boutId: string): Bout | undefined;
  /** Target interval while a bout is live; quota tiers override it. */
  activePollMs?: number;
  clock?: QuotaClock;
  timer?: TheOddsApiPollTimer;
  quota?: RollingQuotaGuard;
  quotaPolicy?: QuotaPolicy;
  publishTick?: (tick: MarketTick) => Promise<void>;
  metrics?: Metrics;
}

/**
 * Same shape as the Odds-API.io policy: the configured target applies only
 * while quota is healthy, and the degraded tiers are floors so a fast target
 * can never override them.
 */
export function theOddsApiPollingPolicy(
  remaining: Pick<QuotaRemaining, "hour" | "day">,
  targetIntervalMs: number = THE_ODDS_API_DEFAULT_ACTIVE_INTERVAL_MS,
): TheOddsApiPollingPolicy {
  // Below this the month's reserve is at risk; boundary fetches only, which
  // is the behaviour this integration had before active polling existed.
  if (remaining.day < 20) return { mode: "boundary-only" };
  if (remaining.hour > 30) {
    return { mode: "periodic", intervalMs: targetIntervalMs };
  }
  if (remaining.hour >= 10) {
    return {
      mode: "periodic",
      intervalMs: Math.max(targetIntervalMs, THE_ODDS_API_MID_INTERVAL_MS),
    };
  }
  return {
    mode: "periodic",
    intervalMs: Math.max(targetIntervalMs, THE_ODDS_API_LOW_INTERVAL_MS),
  };
}

function defaultTimer(): TheOddsApiPollTimer {
  return {
    setTimeout: (callback, delayMs) =>
      globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(
        handle as ReturnType<typeof globalThis.setTimeout>,
      ),
  };
}

type PollReason = "start" | "periodic" | "final";

export class TheOddsApiActivePoller {
  readonly quota: RollingQuotaGuard;

  private readonly eventBus: CollectorEventBus;

  private readonly source: TheOddsApiActivePollerOptions["source"];

  private readonly tickStore: TheOddsApiActivePollerOptions["tickStore"];

  private readonly getBout: TheOddsApiActivePollerOptions["getBout"];

  private readonly activePollMs: number;

  private readonly clock: QuotaClock;

  private readonly timer: TheOddsApiPollTimer;

  private readonly publishTick:
    | ((tick: MarketTick) => Promise<void>)
    | undefined;

  private readonly metrics: Metrics;

  private readonly activeBouts = new Set<string>();

  private readonly timers = new Map<string, unknown>();

  private readonly unsubscribers: Array<() => void> = [];

  private operationQueue: Promise<void> = Promise.resolve();

  private closed = false;

  constructor(options: TheOddsApiActivePollerOptions) {
    this.eventBus = options.eventBus;
    this.source = options.source;
    this.tickStore = options.tickStore;
    this.getBout = options.getBout;
    this.activePollMs =
      options.activePollMs ?? THE_ODDS_API_DEFAULT_ACTIVE_INTERVAL_MS;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.timer = options.timer ?? defaultTimer();
    this.publishTick = options.publishTick;
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.quota =
      options.quota ??
      new RollingQuotaGuard({
        storage: options.storage,
        policies: {
          [THE_ODDS_API_QUOTA_SOURCE]:
            options.quotaPolicy ?? DEFAULT_THE_ODDS_API_QUOTA_POLICY,
        },
        clock: this.clock,
        metrics: this.metrics,
      });

    this.unsubscribers.push(
      this.eventBus.subscribe("FIGHT_STARTED", (event) => {
        this.enqueue(() => this.onFightStarted(event));
      }),
      this.eventBus.subscribe("FIGHT_ENDED", (event) => {
        this.enqueue(() => this.onFightEnded(event));
      }),
    );
  }

  static async create(
    options: TheOddsApiActivePollerOptions,
  ): Promise<TheOddsApiActivePoller> {
    const poller = new TheOddsApiActivePoller(options);
    await poller.quota.restore();
    return poller;
  }

  /** Starts collection for a bout already live when the collector booted. */
  startActiveBout(boutId: string): void {
    this.enqueue(async () => {
      if (this.closed || this.activeBouts.has(boutId)) return;
      this.activeBouts.add(boutId);
      await this.poll(boutId, "start");
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
    if (this.closed || this.activeBouts.has(event.boutId)) return;
    this.activeBouts.add(event.boutId);
    await this.poll(event.boutId, "start");
  }

  private async onFightEnded(
    event: Extract<CollectorEvent, { type: "FIGHT_ENDED" }>,
  ): Promise<void> {
    if (!this.activeBouts.has(event.boutId)) return;
    this.clearTimer(event.boutId);
    await this.poll(event.boutId, "final", event.round);
    this.activeBouts.delete(event.boutId);
  }

  private async poll(
    boutId: string,
    reason: PollReason,
    round?: number,
  ): Promise<void> {
    if (this.closed || !this.activeBouts.has(boutId)) return;

    const policy = theOddsApiPollingPolicy(
      await this.quota.remaining(THE_ODDS_API_QUOTA_SOURCE),
      this.activePollMs,
    );
    // Fight start and completion are worth a request even in the degraded
    // tier; only the periodic cadence is suppressed.
    if (reason === "periodic" && policy.mode === "boundary-only") return;

    const receivedAt = await this.request(boutId);
    if (receivedAt !== null && reason === "final" && round !== undefined) {
      await this.tickStore.snapshotSource(
        boutId,
        round,
        "the-odds-api",
        "confirmed",
        receivedAt,
      );
    }
    if (reason !== "final" && this.activeBouts.has(boutId)) {
      await this.scheduleNext(boutId);
    }
  }

  /** Returns the receive timestamp, or null when nothing usable arrived. */
  private async request(boutId: string): Promise<string | null> {
    const bout = this.getBout(boutId);
    if (bout === undefined) return null;
    if (!(await this.quota.tryAcquire(THE_ODDS_API_QUOTA_SOURCE))) {
      return null;
    }

    const startedAt = this.clock.now();
    try {
      const snapshot = await this.source.getH2hSnapshot(
        bout,
        THE_ODDS_API_H2H_REQUEST,
      );
      if (snapshot === null) return null;

      const receivedAt = new Date(this.clock.now()).toISOString();
      const ticks = sportsbookSnapshotToMarketTicks(
        bout,
        snapshot,
        "the-odds-api",
        receivedAt,
      );
      if (ticks.length === 0) return null;
      for (const tick of ticks) {
        await this.tickStore.ingest(tick);
        await this.publishTick?.(tick).catch(() => undefined);
      }
      this.metrics.set(
        "source_response_latency_ms",
        THE_ODDS_API_QUOTA_SOURCE,
        Math.max(0, this.clock.now() - startedAt),
        { localTimestamp: receivedAt },
      );
      return receivedAt;
    } catch {
      // The previous ticks stay in the store: a failed refresh must never
      // clear a real price mid-fight.
      this.metrics.increment(
        "source_errors_total",
        THE_ODDS_API_QUOTA_SOURCE,
        1,
        { localTimestamp: new Date(this.clock.now()).toISOString() },
      );
      return null;
    }
  }

  private async scheduleNext(boutId: string): Promise<void> {
    this.clearTimer(boutId);
    if (this.closed) return;
    const policy = theOddsApiPollingPolicy(
      await this.quota.remaining(THE_ODDS_API_QUOTA_SOURCE),
      this.activePollMs,
    );
    if (policy.mode === "boundary-only" || policy.intervalMs === undefined) {
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
