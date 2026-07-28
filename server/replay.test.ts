import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CitoRoundStatsFetcher } from "../src/sources/cito.ts";
import {
  createCollector,
  type Collector,
} from "./collector.ts";
import {
  CITO_ROUND_STATS_JOB_TYPE,
} from "./roundStats.ts";
import {
  SHERDOG_ROUND_JOB_TYPE,
  type SherdogFetcher,
} from "./sherdogJobs.ts";
import {
  THE_ODDS_API_ROUND_JOB_TYPE,
} from "./theOddsApiJob.ts";
import {
  ReplayClock,
  runFixtureReplay,
} from "./replay.ts";
import { MemoryStorage } from "./storage.ts";

interface CapturedSseEvent {
  event: string;
  data: unknown;
}

class InProcessSseClient {
  readonly writes: string[] = [];

  private closeListener: (() => void) | undefined;

  readonly request = {
    method: "GET",
    url: "/api/events",
    headers: {},
    on: (event: string, listener: () => void) => {
      if (event === "close") this.closeListener = listener;
      return this.request;
    },
  } as unknown as IncomingMessage;

  readonly response = {
    headersSent: false,
    writeHead: () => this.response,
    flushHeaders: () => undefined,
    write: (chunk: string) => {
      this.writes.push(chunk);
      return true;
    },
    end: () => {
      this.closeListener?.();
    },
    on: () => this.response,
  } as unknown as ServerResponse;

  events(): CapturedSseEvent[] {
    return this.writes.flatMap((write) =>
      write
        .split("\n\n")
        .filter((frame) => frame.includes("data:"))
        .map((frame) => {
          const event =
            frame
              .split("\n")
              .find((line) => line.startsWith("event:"))
              ?.slice("event:".length)
              .trim() ?? "message";
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trimStart())
            .join("\n");
          return {
            event,
            data: JSON.parse(data) as unknown,
          };
        }),
    );
  }
}

const collectors: Collector[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    collectors.splice(0).map((collector) => collector.close()),
  );
});

function normalizedForDeterminism(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizedForDeterminism);
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          key !== "receivedAt" &&
          key !== "createdAt" &&
          key !== "checkedAt" &&
          key !== "localTimestamp" &&
          key !== "firstObservedAt" &&
          key !== "lastObservedAt",
      )
      .map(([key, entry]) => [key, normalizedForDeterminism(entry)]),
  );
}

describe("complete deterministic fixture replay", () => {
  it("delivers every normalized record kind to SSE and restores it after restart", async () => {
    const storage = new MemoryStorage();
    const sse = new InProcessSseClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await runFixtureReplay({
      storage,
      listen: false,
      onReady: async ({ collector }) => {
        await collector.push.handle(sse.request, sse.response);
      },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    const events = sse.events();
    const updates = events
      .filter((event) => event.event === "update")
      .map((event) => event.data as Record<string, unknown>);
    const lifecycle = updates
      .filter((data) => data.kind === "lifecycle")
      .map((data) => data.event as { type: string });
    const rounds = updates
      .filter((data) => data.kind === "round")
      .map((data) => data.record as Record<string, unknown>);
    const snapshots = updates
      .filter((data) => data.kind === "market-snapshot")
      .map((data) => data.snapshot as { source: string });

    expect(lifecycle.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "FIGHT_STARTED",
        "PROVISIONAL_ROUND_ENDED",
        "ROUND_ENDED",
        "FIGHT_ENDED",
      ]),
    );
    expect(rounds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provisional: true }),
        expect.objectContaining({
          provisional: false,
          citoStats: expect.any(Object),
        }),
        expect.objectContaining({
          sherdog: expect.any(Object),
          xScores: [
            expect.objectContaining({ mode: "embed" }),
          ],
          expertConsensus: expect.any(Object),
        }),
      ]),
    );
    expect(new Set(snapshots.map((snapshot) => snapshot.source))).toEqual(
      new Set([
        "kalshi",
        "polymarket",
        "odds-api-io",
        "the-odds-api",
      ]),
    );
    expect(
      events.some(
        (event) =>
          event.event === "health" &&
          typeof event.data === "object" &&
          event.data !== null &&
          "metrics" in event.data,
      ),
    ).toBe(true);
    expect(result.bootstrap.unifiedRounds).toHaveLength(2);
    for (const round of result.bootstrap.unifiedRounds) {
      expect(Object.keys(round.marketAtEnd).sort()).toEqual([
        "kalshi",
        "oddsApiIo",
        "polymarket",
        "theOddsApi",
      ]);
      expect(round).toMatchObject({
        provisional: false,
        citoStats: expect.any(Object),
        sherdog: expect.any(Object),
        xScores: [expect.objectContaining({ mode: "embed" })],
        expertConsensus: {
          sherdog: expect.any(Object),
          x: expect.any(Object),
        },
      });
    }

    const restored = await createCollector({
      env: {
        DATA_MODE: "fixture",
        COLLECTOR_PORT: "0",
        SHERDOG_REQUEST_INTERVAL_MS: "1",
      },
      storage,
      market: {
        clock: new ReplayClock("2026-07-26T02:41:44.000Z"),
      },
      health: {
        now: () => "2026-07-26T02:41:44.000Z",
      },
    });
    collectors.push(restored);
    expect(restored.getBootstrap()).toMatchObject({
      unifiedRounds: result.bootstrap.unifiedRounds,
      marketSnapshots: result.bootstrap.marketSnapshots,
      latestMarkets: result.bootstrap.latestMarkets,
    });
    expect(restored.boutMappings.getAll()).toEqual(
      result.bootstrap.boutMappings,
    );
    expect(restored.roundStats.scheduler.getJobs()).not.toHaveLength(0);
  });

  it("produces equivalent records twice modulo local receipt timestamps", async () => {
    const first = await runFixtureReplay({
      storage: new MemoryStorage(),
      listen: false,
    });
    const second = await runFixtureReplay({
      storage: new MemoryStorage(),
      listen: false,
    });

    expect(
      normalizedForDeterminism(second.recordsByStream),
    ).toEqual(normalizedForDeterminism(first.recordsByStream));
  });
});

async function runIsolationCase(options: {
  roundStats?: CitoRoundStatsFetcher;
  sherdog?: SherdogFetcher;
}): Promise<Collector> {
  const clock = new ReplayClock();
  const collector = await createCollector({
    env: {
      DATA_MODE: "fixture",
      COLLECTOR_PORT: "0",
      SHERDOG_REQUEST_INTERVAL_MS: "1",
    },
    storage: new MemoryStorage(),
    roundStats: {
      clock,
      timer: clock,
      initialDelayMs: 5,
      retryDelayMs: 5,
      ...(options.roundStats === undefined
        ? {}
        : { fetcher: options.roundStats }),
    },
    market: { clock },
    sportsbook: {
      clock,
      timer: clock,
      random: () => 0,
    },
    sherdog: {
      random: () => 0,
      ...(options.sherdog === undefined
        ? {}
        : { fetcher: options.sherdog }),
    },
  });
  collectors.push(collector);
  await collector.replayMarkets();
  collector.eventBus.emit({
    type: "PROVISIONAL_ROUND_ENDED",
    boutId: "bout-main",
    round: 1,
    detectedAt: clock.nowIso(),
  });
  collector.eventBus.emit({
    type: "ROUND_ENDED",
    boutId: "bout-main",
    round: 1,
    detectedAt: clock.nowIso(),
    confirmation: "period_transition",
  });
  await collector.roundStats.idle();
  await collector.sherdogJobs.idle();
  await collector.theOddsApiJob.idle();
  clock.advance(30_000);
  await collector.roundStats.idle();
  await collector.sherdogJobs.idle();
  await collector.theOddsApiJob.idle();
  await collector.roundStats.idle();
  return collector;
}

describe("round-source failure isolation", () => {
  it("keeps Sherdog and all markets complete when Cito fails terminally", async () => {
    const failingCito: CitoRoundStatsFetcher = {
      async fetchRound() {
        throw new Error("Cito fixture failure");
      },
      async fetchAllRounds() {
        throw new Error("Cito fixture failure");
      },
    };
    const collector = await runIsolationCase({
      roundStats: failingCito,
    });
    const jobs = collector.roundStats.scheduler.getJobs();

    expect(
      jobs.find((job) => job.jobType === CITO_ROUND_STATS_JOB_TYPE),
    ).toMatchObject({ status: "failed" });
    expect(
      jobs.find((job) => job.jobType === SHERDOG_ROUND_JOB_TYPE),
    ).toMatchObject({ status: "completed" });
    expect(
      jobs.find((job) => job.jobType === THE_ODDS_API_ROUND_JOB_TYPE),
    ).toMatchObject({ status: "completed" });
    expect(
      new Set(
        collector.tickStore
          .getSnapshots("bout-main", 1)
          .map((snapshot) => snapshot.source),
      ),
    ).toEqual(
      new Set([
        "kalshi",
        "polymarket",
        "odds-api-io",
        "the-odds-api",
      ]),
    );
    expect(
      collector.roundStats.getUnifiedRound("bout-main", 1),
    ).toMatchObject({
      sherdog: expect.any(Object),
    });
  });

  it("keeps Cito and all markets complete when Sherdog fails terminally", async () => {
    const failingSherdog: SherdogFetcher = {
      async fetchBout() {
        return {
          status: 200,
          html: "<html><body>no round headings</body></html>",
          sourceUrl: "https://www.sherdog.com/fixture-failure",
        };
      },
    };
    const collector = await runIsolationCase({
      sherdog: failingSherdog,
    });
    const jobs = collector.roundStats.scheduler.getJobs();

    expect(
      jobs.find((job) => job.jobType === SHERDOG_ROUND_JOB_TYPE),
    ).toMatchObject({ status: "failed" });
    expect(
      jobs.find((job) => job.jobType === CITO_ROUND_STATS_JOB_TYPE),
    ).toMatchObject({ status: "completed" });
    expect(
      jobs.find((job) => job.jobType === THE_ODDS_API_ROUND_JOB_TYPE),
    ).toMatchObject({ status: "completed" });
    expect(
      new Set(
        collector.tickStore
          .getSnapshots("bout-main", 1)
          .map((snapshot) => snapshot.source),
      ),
    ).toEqual(
      new Set([
        "kalshi",
        "polymarket",
        "odds-api-io",
        "the-odds-api",
      ]),
    );
    expect(
      collector.roundStats.getUnifiedRound("bout-main", 1),
    ).toMatchObject({
      citoStats: expect.any(Object),
    });
    await expect(collector.review.getReviewRecords()).resolves.toMatchObject({
      parserErrors: [
        expect.objectContaining({ source: "sherdog" }),
      ],
    });
  });
});
