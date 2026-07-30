import type { Bout } from "../src/schema.ts";
import type { SourceConfig } from "../src/sources/contract.ts";
import {
  createLiveCitoLifecycleFetcher,
} from "../src/sources/cito.ts";
import {
  createLiveEspnLifecycleFetcher,
} from "../src/sources/espn.ts";
import { NOOP_METRICS, type Metrics } from "./health.ts";
import { ROUND_LENGTH_SECONDS } from "./lifecycle.ts";
import type {
  FightLifecycleMachine,
  FightLifecycleObservation,
  LifecycleSource,
} from "./lifecycle.ts";

export const DEFAULT_ESPN_FAILURE_THRESHOLD = 3;

export type LifecycleObservationInput = Omit<
  FightLifecycleObservation,
  "source"
>;

/**
 * Per-cycle source of lifecycle observations. Implementations stamp every
 * bout they know about; the driver tags the result with whichever source
 * (ESPN or Cito) actually produced it before handing it to
 * FightLifecycleMachine.observe().
 */
export interface LifecycleObservationProvider {
  fetchObservations(
    now: number,
  ): Promise<readonly LifecycleObservationInput[]>;
}

export interface LifecycleDriverClock {
  now(): number;
}

export interface LifecycleDriverTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Common per-bout shape shared by fixture and live scoreboard/live-state fetchers. */
export interface LifecycleScoreboardEntry {
  externalId: string;
  state: "pre" | "in" | "post";
  period: number;
  completed: boolean;
  clockSeconds?: number;
}

export interface LifecycleScoreboardFetcher {
  fetchEntries(): Promise<readonly LifecycleScoreboardEntry[]>;
}

function defaultDriverClock(): LifecycleDriverClock {
  return { now: () => Date.now() };
}

function defaultDriverTimer(): LifecycleDriverTimer {
  return {
    setTimeout: (callback, delayMs) =>
      globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(
        handle as ReturnType<typeof globalThis.setTimeout>,
      ),
  };
}

/**
 * Adapts a raw per-external-id scoreboard/live-state fetcher into a
 * LifecycleObservationProvider by resolving each entry's external id to an
 * internal bout id and stamping receivedAt from the injected clock. Shared
 * by the fixture provider and both live providers below.
 */
function createScoreboardObservationProvider(options: {
  fetcher: LifecycleScoreboardFetcher;
  resolveBoutId: (externalId: string) => string | undefined;
  clock?: LifecycleDriverClock;
}): LifecycleObservationProvider {
  const clock = options.clock ?? defaultDriverClock();

  return {
    async fetchObservations(): Promise<readonly LifecycleObservationInput[]> {
      const entries = await options.fetcher.fetchEntries();
      const receivedAt = new Date(clock.now()).toISOString();
      const observations: LifecycleObservationInput[] = [];

      for (const entry of entries) {
        const boutId = options.resolveBoutId(entry.externalId);
        if (boutId === undefined) continue;

        observations.push({
          boutId,
          state: entry.state,
          period: entry.period,
          completed: entry.completed,
          ...(entry.clockSeconds === undefined
            ? {}
            : { clockSeconds: entry.clockSeconds }),
          receivedAt,
        });
      }

      return observations;
    },
  };
}

/**
 * Derives a deterministic lifecycle entry from a bout's already-normalized
 * status. Fixture bouts are static, so this always returns the same values
 * for a given bout; it is FightLifecycleMachine's own dedupe (see
 * lifecycle.ts) — not this function — that makes repeated polling safe.
 */
export function boutLifecycleEntry(bout: Bout): LifecycleScoreboardEntry {
  if (bout.status === "final") {
    return {
      externalId: bout.id,
      state: "post",
      period: bout.result?.round ?? 1,
      completed: true,
    };
  }
  if (bout.status === "between-rounds") {
    return {
      externalId: bout.id,
      state: "in",
      period: bout.currentRound ?? 1,
      completed: false,
      // A finished round reads as a full clock, not an empty one — ESPN's
      // clock counts up (see ROUND_LENGTH_SECONDS in lifecycle.ts).
      clockSeconds: ROUND_LENGTH_SECONDS,
    };
  }
  if (bout.status === "in-round") {
    return {
      externalId: bout.id,
      state: "in",
      period: bout.currentRound ?? 1,
      completed: false,
    };
  }
  return {
    externalId: bout.id,
    state: "pre",
    period: 0,
    completed: false,
  };
}

/** Fixture-mode provider: derives observations from the normalized fixture event, no network calls. */
export function createFixtureLifecycleProvider(
  getBouts: () => readonly Bout[],
  clock?: LifecycleDriverClock,
): LifecycleObservationProvider {
  return createScoreboardObservationProvider({
    fetcher: {
      async fetchEntries() {
        return getBouts().map(boutLifecycleEntry);
      },
    },
    resolveBoutId: (externalId) => externalId,
    ...(clock === undefined ? {} : { clock }),
  });
}

function resolveByExternalRef(
  getBouts: () => readonly Bout[],
  source: LifecycleSource,
): (externalId: string) => string | undefined {
  return (externalId) =>
    getBouts().find((bout) =>
      bout.externalRefs.some(
        (ref) => ref.source === source && ref.id === externalId,
      ),
    )?.id;
}

/** Live ESPN provider. Fails closed unless DATA_MODE=live (see createLiveEspnLifecycleFetcher). */
export function createLiveEspnLifecycleProvider(
  config: SourceConfig,
  eventExternalId: string,
  getBouts: () => readonly Bout[],
  options?: { fetchImpl?: typeof fetch; clock?: LifecycleDriverClock },
): LifecycleObservationProvider {
  const fetcher = createLiveEspnLifecycleFetcher(config, options?.fetchImpl);

  return createScoreboardObservationProvider({
    fetcher: { fetchEntries: () => fetcher.fetchLifecycle(eventExternalId) },
    resolveBoutId: resolveByExternalRef(getBouts, "espn"),
    ...(options?.clock === undefined ? {} : { clock: options.clock }),
  });
}

/** Live Cito fallback provider. Fails closed unless DATA_MODE=live and CITO_API_KEY + baseUrl are present. */
export function createLiveCitoLifecycleProvider(
  config: SourceConfig,
  eventExternalId: string,
  getBouts: () => readonly Bout[],
  options: {
    baseUrl: string;
    fetchImpl?: typeof fetch;
    clock?: LifecycleDriverClock;
  },
): LifecycleObservationProvider {
  const fetcher = createLiveCitoLifecycleFetcher(config, {
    baseUrl: options.baseUrl,
    ...(options.fetchImpl === undefined
      ? {}
      : { fetchImpl: options.fetchImpl }),
  });

  return createScoreboardObservationProvider({
    fetcher: { fetchEntries: () => fetcher.fetchLifecycle(eventExternalId) },
    resolveBoutId: resolveByExternalRef(getBouts, "cito"),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}

export interface LifecycleDriverOptions {
  machine: Pick<FightLifecycleMachine, "observe">;
  espnProvider: LifecycleObservationProvider;
  citoProvider?: LifecycleObservationProvider;
  espnPollingMs: number;
  citoPollingMs: number;
  /** Consecutive ESPN failures before switching to the Cito provider. Default 3. */
  espnFailureThreshold?: number;
  clock?: LifecycleDriverClock;
  timer?: LifecycleDriverTimer;
  metrics?: Metrics;
  /**
   * Receives one normalized batch after every successful source poll. This is
   * deliberately separate from transition events: an unchanged ESPN clock is
   * still a fresh synchronization point for the browser's local countdown.
   */
  onObservations?: (
    observations: readonly FightLifecycleObservation[],
  ) => void | Promise<void>;
}

/**
 * Owns a poll loop that feeds per-bout lifecycle observations into
 * FightLifecycleMachine.observe(). ESPN is always attempted first (both as
 * the normal path and as a recovery probe while in Cito fallback); after
 * `espnFailureThreshold` consecutive ESPN failures, the Cito provider is
 * consulted for that cycle and subsequent polls run at citoPollingMs until
 * ESPN succeeds again.
 */
export class LifecycleDriver {
  private readonly machine: Pick<FightLifecycleMachine, "observe">;

  private readonly espnProvider: LifecycleObservationProvider;

  private readonly citoProvider: LifecycleObservationProvider | undefined;

  private readonly espnPollingMs: number;

  private readonly citoPollingMs: number;

  private readonly espnFailureThreshold: number;

  private readonly clock: LifecycleDriverClock;

  private readonly timer: LifecycleDriverTimer;

  private readonly metrics: Metrics;

  private readonly onObservations:
    | LifecycleDriverOptions["onObservations"]
    | undefined;

  private activeSource: LifecycleSource = "espn";

  private consecutiveEspnFailures = 0;

  private timerHandle: unknown;

  private started = false;

  private closed = false;

  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: LifecycleDriverOptions) {
    if (
      !Number.isFinite(options.espnPollingMs) ||
      options.espnPollingMs <= 0
    ) {
      throw new TypeError(
        "lifecycle driver espnPollingMs must be a positive number",
      );
    }
    if (
      !Number.isFinite(options.citoPollingMs) ||
      options.citoPollingMs <= 0
    ) {
      throw new TypeError(
        "lifecycle driver citoPollingMs must be a positive number",
      );
    }
    const threshold =
      options.espnFailureThreshold ?? DEFAULT_ESPN_FAILURE_THRESHOLD;
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new TypeError(
        "lifecycle driver espnFailureThreshold must be a positive integer",
      );
    }

    this.machine = options.machine;
    this.espnProvider = options.espnProvider;
    this.citoProvider = options.citoProvider;
    this.espnPollingMs = options.espnPollingMs;
    this.citoPollingMs = options.citoPollingMs;
    this.espnFailureThreshold = threshold;
    this.clock = options.clock ?? defaultDriverClock();
    this.timer = options.timer ?? defaultDriverTimer();
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.onObservations = options.onObservations;
  }

  getActiveSource(): LifecycleSource {
    return this.activeSource;
  }

  getConsecutiveEspnFailures(): number {
    return this.consecutiveEspnFailures;
  }

  isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    await this.enqueue(() => this.pollOnce());
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
    if (this.timerHandle !== undefined) {
      this.timer.clearTimeout(this.timerHandle);
      this.timerHandle = undefined;
    }
    await this.idle();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async pollOnce(): Promise<void> {
    if (this.closed) return;

    const now = this.clock.now();
    let observations: readonly LifecycleObservationInput[] | undefined;
    let usedSource: LifecycleSource | undefined;

    try {
      observations = await this.espnProvider.fetchObservations(now);
      usedSource = "espn";
      this.consecutiveEspnFailures = 0;
      this.activeSource = "espn";
    } catch {
      this.consecutiveEspnFailures += 1;
      this.metrics.increment("source_errors_total", "espn", 1, {
        localTimestamp: new Date(now).toISOString(),
      });

      if (
        this.consecutiveEspnFailures >= this.espnFailureThreshold &&
        this.citoProvider !== undefined
      ) {
        this.activeSource = "cito";
        try {
          observations = await this.citoProvider.fetchObservations(now);
          usedSource = "cito";
        } catch {
          this.metrics.increment("source_errors_total", "cito", 1, {
            localTimestamp: new Date(now).toISOString(),
          });
        }
      }
    }

    if (observations !== undefined && usedSource !== undefined) {
      const taggedObservations = observations.map((input) => ({
        ...input,
        source: usedSource,
      }));
      for (const input of observations) {
        await this.machine.observe({ ...input, source: usedSource });
      }
      await this.onObservations?.(taggedObservations);
    }

    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.closed) return;
    const delayMs =
      this.activeSource === "cito" ? this.citoPollingMs : this.espnPollingMs;
    this.timerHandle = this.timer.setTimeout(() => {
      this.timerHandle = undefined;
      this.enqueue(() => this.pollOnce());
    }, delayMs);
  }
}
