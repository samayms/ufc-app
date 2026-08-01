import { pathToFileURL } from "node:url";
import {
  createCollector,
  type Collector,
  type CollectorBootstrap,
} from "./collector.ts";
import type {
  RoundJobClock,
  RoundJobTimer,
} from "./roundJobs.ts";
import {
  JsonlStorage,
  type Storage,
} from "./storage.ts";

export const REPLAY_BOUT_ID = "bout-main";
export const REPLAY_STARTED_AT = "2026-07-26T02:40:40.000Z";

export class ReplayClock implements RoundJobClock, RoundJobTimer {
  private value: number;

  private nextTimerId = 1;

  private readonly timers = new Map<
    number,
    { callback: () => void; dueAt: number }
  >();

  constructor(startedAt = REPLAY_STARTED_AT) {
    const parsed = Date.parse(startedAt);
    if (!Number.isFinite(parsed)) {
      throw new TypeError("Replay clock requires a valid start timestamp");
    }
    this.value = parsed;
  }

  now(): number {
    return this.value;
  }

  nowIso(): string {
    return new Date(this.value).toISOString();
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextTimerId;
    this.nextTimerId += 1;
    this.timers.set(id, {
      callback,
      dueAt: this.value + Math.max(0, delayMs),
    });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new TypeError("Replay time advances must be non-negative");
    }
    this.value += milliseconds;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.value)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.dueAt - right.dueAt || leftId - rightId,
        )[0];
      if (due === undefined) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

export interface FixtureReplayReady {
  collector: Collector;
  port: number;
  clock: ReplayClock;
}

export interface FixtureReplayOptions {
  storage?: Storage;
  persistencePath?: string;
  onReady?: (ready: FixtureReplayReady) => void | Promise<void>;
  listen?: boolean;
}

export interface FixtureReplayResult {
  persistencePath?: string;
  serverListening: boolean;
  bootstrap: CollectorBootstrap;
  recordsByStream: Readonly<Record<string, readonly unknown[]>>;
}

async function drain(collector: Collector): Promise<void> {
  await collector.tickStore.idle();
  await collector.oddsApiIoPoller.idle();
  await collector.roundStats.idle();
  await collector.sherdogJobs.idle();
  await collector.theOddsApiJob.idle();
  await collector.roundStats.idle();
  await collector.health.flush();
}

async function observe(
  collector: Collector,
  clock: ReplayClock,
  state: "pre" | "in" | "post",
  period: number,
  completed: boolean,
  clockSeconds?: number,
): Promise<void> {
  const receivedAt = clock.nowIso();
  const sourceUpdatedAt = new Date(clock.now() - 250).toISOString();
  await collector.lifecycle.observe({
    source: "espn",
    boutId: REPLAY_BOUT_ID,
    state,
    period,
    completed,
    ...(clockSeconds === undefined ? {} : { clockSeconds }),
    sourceUpdatedAt,
    receivedAt,
  });
  await drain(collector);
}

async function snapshotStorage(
  storage: Storage,
): Promise<Readonly<Record<string, readonly unknown[]>>> {
  const streams = await storage.listStreams();
  return Object.fromEntries(
    await Promise.all(
      streams.map(async (stream) => [stream, await storage.read(stream)]),
    ),
  );
}

export async function runFixtureReplay(
  options: FixtureReplayOptions = {},
): Promise<FixtureReplayResult> {
  const persistencePath =
    options.persistencePath ??
    (options.storage === undefined
      ? `./data/replay-${Date.now()}`
      : undefined);
  const storage =
    options.storage ??
    new JsonlStorage(persistencePath as string);
  const clock = new ReplayClock();
  const collector = await createCollector({
    env: {
      DATA_MODE: "fixture",
      COLLECTOR_PORT: "0",
      SHERDOG_REQUEST_INTERVAL_MS: "1",
      ...(persistencePath === undefined
        ? {}
        : { PERSISTENCE_PATH: persistencePath }),
    },
    storage,
    sse: {
      heartbeatMs: 60_000,
      now: () => clock.nowIso(),
      flushIntervalMs: 0,
    },
    health: {
      now: () => clock.nowIso(),
      persistIntervalMs: 60_000,
    },
    roundStats: {
      clock,
      timer: clock,
      initialDelayMs: 5,
      retryDelayMs: 5,
    },
    market: {
      clock,
      staleAfterMs: 30_000,
    },
    sportsbook: {
      clock,
      timer: clock,
      random: () => 0,
    },
  });

  try {
    let port = 0;
    let serverListening = false;
    if (options.listen !== false) {
      try {
        port = await collector.start();
        serverListening = true;
      } catch (error) {
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error
            ? error.code
            : undefined;
        if (code !== "EPERM" && code !== "EACCES") throw error;
      }
    }
    await options.onReady?.({ collector, port, clock });

    await collector.replayMarkets();
    await drain(collector);

    await observe(collector, clock, "pre", 0, false);
    clock.advance(1_000);
    await observe(collector, clock, "in", 1, false, 300);
    clock.advance(1_000);
    await observe(collector, clock, "in", 1, false, 0);

    clock.advance(10_000);
    await drain(collector);
    await observe(collector, clock, "in", 2, false, 300);

    clock.advance(20_000);
    await drain(collector);
    clock.advance(1_000);
    await observe(collector, clock, "in", 2, false, 0);

    clock.advance(10_000);
    await drain(collector);
    clock.advance(1_000);
    await observe(collector, clock, "post", 2, true, 0);

    clock.advance(20_000);
    await drain(collector);
    await collector.publishHealth({
      source: "fixture-replay",
      status: "healthy",
      fresh: true,
      checkedAt: clock.nowIso(),
      sourceUpdatedAt: clock.nowIso(),
      message: "Deterministic fixture replay completed",
    });
    await collector.health.flush();

    const bootstrap = collector.getBootstrap();
    await collector.close();
    const recordsByStream = await snapshotStorage(storage);
    return {
      ...(persistencePath === undefined ? {} : { persistencePath }),
      serverListening,
      bootstrap,
      recordsByStream,
    };
  } catch (error) {
    await collector.close().catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  const result = await runFixtureReplay({
    ...(process.env.REPLAY_PERSISTENCE_PATH === undefined
      ? {}
      : { persistencePath: process.env.REPLAY_PERSISTENCE_PATH }),
    listen: process.env.REPLAY_NO_LISTEN !== "1",
  });
  const rounds = result.bootstrap.unifiedRounds.length;
  const snapshots = result.bootstrap.marketSnapshots.length;
  const events = result.recordsByStream["sse-events"]?.length ?? 0;
  console.log(
    JSON.stringify(
      {
        replay: "complete",
        persistencePath: result.persistencePath,
        serverListening: result.serverListening,
        rounds,
        marketSnapshots: snapshots,
        sseEvents: events,
      },
      null,
      2,
    ),
  );
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  import.meta.url === pathToFileURL(entry).href
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Fixture replay failed",
    );
    process.exitCode = 1;
  });
}
