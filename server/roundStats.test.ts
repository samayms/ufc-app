import { describe, expect, it, vi } from "vitest";
import type {
  CitoRoundStatsFetcher,
  CitoRoundStatsPayload,
} from "../src/sources/cito.ts";
import type {
  MarketSnapshot,
  MarketSource,
} from "../src/sources/contract.ts";
import { CollectorEventBus } from "./eventBus.ts";
import type {
  RoundJobClock,
  RoundJobTimer,
} from "./roundJobs.ts";
import {
  CITO_RECONCILIATION_JOB_TYPE,
  CITO_ROUND_STATS_JOB_TYPE,
  ROUND_STATS_STORAGE_STREAM,
  RoundStatsPipeline,
} from "./roundStats.ts";
import { MemoryStorage } from "./storage.ts";

class ManualTime implements RoundJobClock, RoundJobTimer {
  value: number;

  private nextId = 1;

  private readonly timers = new Map<
    number,
    { callback: () => void; dueAt: number }
  >();

  constructor(value: number) {
    this.value = value;
  }

  now(): number {
    return this.value;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, {
      callback,
      dueAt: this.value + delayMs,
    });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.value)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.dueAt - right.dueAt || leftId - rightId,
        )[0];
      if (next === undefined) return;
      this.timers.delete(next[0]);
      next[1].callback();
    }
  }
}

const BASE_TIME = Date.parse("2026-07-28T00:00:00Z");
const BOUT_ID = "bout-main";

const fighterA = {
  significantStrikes: 24,
  totalStrikes: 31,
  takedowns: 1,
  takedownsAttempted: 2,
  controlTimeSeconds: 72,
  knockdowns: 0,
};
const fighterB = {
  significantStrikes: 19,
  totalStrikes: 25,
  takedowns: 0,
  takedownsAttempted: 1,
  controlTimeSeconds: 18,
  knockdowns: 0,
};

const espnFighter = {
  significantStrikesLanded: 13,
  significantStrikesAttempted: 14,
  totalStrikesLanded: 13,
  totalStrikesAttempted: 14,
  takedownsLanded: 0,
  takedownsAttempted: 0,
  submissionsAttempted: 0,
  reversals: 0,
  controlTimeSeconds: 4,
  knockdowns: 1,
  headStrikesLanded: 11,
  headStrikesAttempted: 11,
  bodyStrikesLanded: 1,
  bodyStrikesAttempted: 2,
  legStrikesLanded: 1,
  legStrikesAttempted: 1,
};

function payload(
  round = 1,
  values: Partial<CitoRoundStatsPayload> = {},
): CitoRoundStatsPayload {
  return {
    boutId: BOUT_ID,
    round,
    fighterA: { ...fighterA },
    fighterB: { ...fighterB },
    sourceUpdatedAt: "2026-07-28T00:00:05Z",
    ...values,
  };
}

function fetcher(
  roundResults: Array<CitoRoundStatsPayload | null>,
  allRounds: CitoRoundStatsPayload[] = [],
): CitoRoundStatsFetcher & {
  fetchRound: ReturnType<typeof vi.fn<CitoRoundStatsFetcher["fetchRound"]>>;
  fetchAllRounds: ReturnType<
    typeof vi.fn<CitoRoundStatsFetcher["fetchAllRounds"]>
  >;
} {
  let index = 0;
  const fetchRound = vi.fn<CitoRoundStatsFetcher["fetchRound"]>(
    async (_boutId, _round) => {
      const result =
        roundResults[Math.min(index, roundResults.length - 1)] ?? null;
      index += 1;
      return result;
    },
  );
  const fetchAllRounds = vi.fn<
    CitoRoundStatsFetcher["fetchAllRounds"]
  >(async (_boutId) => allRounds);
  return { fetchRound, fetchAllRounds };
}

async function setup(
  cito: CitoRoundStatsFetcher,
  options: {
    storage?: MemoryStorage;
    time?: ManualTime;
  } = {},
): Promise<{
  bus: CollectorEventBus;
  storage: MemoryStorage;
  time: ManualTime;
  pipeline: RoundStatsPipeline;
}> {
  const bus = new CollectorEventBus();
  const storage = options.storage ?? new MemoryStorage();
  const time = options.time ?? new ManualTime(BASE_TIME);
  const pipeline = await RoundStatsPipeline.create({
    eventBus: bus,
    storage,
    fetcher: cito,
    clock: time,
    timer: time,
    initialDelayMs: 6_000,
    retryDelayMs: 20_000,
  });
  return { bus, storage, time, pipeline };
}

function emitProvisional(bus: CollectorEventBus, round = 1): void {
  bus.emit({
    type: "PROVISIONAL_ROUND_ENDED",
    boutId: BOUT_ID,
    round,
    detectedAt: new Date(BASE_TIME).toISOString(),
  });
}

function emitConfirmed(bus: CollectorEventBus, round = 1): void {
  bus.emit({
    type: "ROUND_ENDED",
    boutId: BOUT_ID,
    round,
    detectedAt: new Date(BASE_TIME + 10_000).toISOString(),
    confirmation: "period_transition",
  });
}

function marketSnapshot(source: MarketSource): MarketSnapshot {
  return {
    source,
    boutId: BOUT_ID,
    round: 1,
    boundaryType: "provisional",
    takenAt: new Date(BASE_TIME).toISOString(),
    fresh: true,
    outcomes: [
      {
        marketType: "fight-winner",
        outcome: "red",
        impliedProbability: 0.6,
        receivedAt: new Date(BASE_TIME).toISOString(),
        stale: false,
      },
      {
        marketType: "fight-winner",
        outcome: "blue",
        impliedProbability: 0.4,
        receivedAt: new Date(BASE_TIME).toISOString(),
        stale: false,
      },
    ],
  };
}

describe("RoundStatsPipeline", () => {
  it("persists finalized ESPN round stats in the unified round", async () => {
    const storage = new MemoryStorage();
    const first = await setup(fetcher([]), { storage });
    const stats = first.pipeline.observeEspnCumulative({
      boutId: BOUT_ID,
      round: 1,
      fighterA: espnFighter,
      fighterB: { ...espnFighter, knockdowns: 0 },
      observedAt: "2026-07-28T00:05:00Z",
    }, true);
    await first.pipeline.persistEspnRoundStats(stats);
    emitConfirmed(first.bus);
    await first.pipeline.idle();

    expect(first.pipeline.getUnifiedRound(BOUT_ID, 1)).toMatchObject({
      provisional: false,
      espnStats: {
        finalized: true,
        fighterA: { significantStrikesLanded: 13, knockdowns: 1 },
      },
    });
    await first.pipeline.close();

    const restored = await setup(fetcher([]), { storage });
    expect(restored.pipeline.getUnifiedRound(BOUT_ID, 1)?.espnStats).toMatchObject({
      finalized: true,
      fighterB: { knockdowns: 0 },
    });
    await restored.pipeline.close();
  });

  it("produces provisional then confirmed records in a normal round flow", async () => {
    const cito = fetcher([payload()]);
    const { bus, storage, time, pipeline } = await setup(cito);

    emitProvisional(bus);
    await pipeline.idle();
    time.advance(6_000);
    await pipeline.idle();

    expect(pipeline.getRoundStats(BOUT_ID, 1)).toMatchObject({
      provisional: true,
      revision: 1,
      fighterA,
      fighterB,
    });
    expect(pipeline.getUnifiedRound(BOUT_ID, 1)).toMatchObject({
      endingSignal: "clock_zero_provisional",
      provisional: true,
      marketAtEnd: {},
    });

    emitConfirmed(bus);
    await pipeline.idle();

    const confirmed = pipeline.getRoundStats(BOUT_ID, 1);
    expect(confirmed).toMatchObject({
      provisional: false,
      revision: 1,
    });
    expect(pipeline.getUnifiedRound(BOUT_ID, 1)).toMatchObject({
      endingSignal: "period_transition",
      provisional: false,
      finalizedAt: expect.any(String),
      citoStats: { provisional: false, revision: 1 },
    });
    const persisted = await storage.read<{
      record: { provisional: boolean; revision: number };
    }>(ROUND_STATS_STORAGE_STREAM);
    expect(
      persisted.map(({ record }) => ({
        provisional: record.provisional,
        revision: record.revision,
      })),
    ).toEqual([
      { provisional: true, revision: 1 },
      { provisional: false, revision: 1 },
    ]);
    await pipeline.close();
  });

  it("retains every source snapshot through later round-stat updates", async () => {
    const { bus, time, pipeline } = await setup(fetcher([payload()]));
    emitProvisional(bus);
    await pipeline.idle();
    for (const source of [
      "kalshi",
      "polymarket",
      "odds-api-io",
      "the-odds-api",
    ] as const) {
      await pipeline.setMarketSnapshot(marketSnapshot(source));
    }

    time.advance(6_000);
    await pipeline.idle();
    expect(pipeline.getUnifiedRound(BOUT_ID, 1)?.marketAtEnd).toEqual({
      kalshi: expect.objectContaining({ source: "kalshi" }),
      polymarket: expect.objectContaining({ source: "polymarket" }),
      oddsApiIo: expect.objectContaining({ source: "odds-api-io" }),
      theOddsApi: expect.objectContaining({ source: "the-odds-api" }),
    });
    await pipeline.close();
  });

  it("retries an absent round exactly once and leaves it pending", async () => {
    const cito = fetcher([null, null]);
    const { bus, time, pipeline } = await setup(cito);

    emitProvisional(bus);
    await pipeline.idle();
    time.advance(6_000);
    await pipeline.idle();
    expect(cito.fetchRound).toHaveBeenCalledTimes(1);

    time.advance(20_000);
    await pipeline.idle();
    expect(cito.fetchRound).toHaveBeenCalledTimes(2);
    expect(pipeline.getRoundStats(BOUT_ID, 1)).toBeUndefined();
    expect(pipeline.getUnifiedRound(BOUT_ID, 1)?.provisional).toBe(true);
    expect(
      pipeline.scheduler.getJobs().find(
        ({ jobType }) => jobType === CITO_ROUND_STATS_JOB_TYPE,
      ),
    ).toMatchObject({ status: "failed", attemptCount: 2 });
    await pipeline.close();
  });

  it("retries a structurally incomplete response and then completes", async () => {
    const cito = fetcher([
      payload(1, {
        fighterB: {
          significantStrikes: 19,
        },
      }),
      payload(),
    ]);
    const { bus, time, pipeline } = await setup(cito);

    emitProvisional(bus);
    await pipeline.idle();
    time.advance(6_000);
    await pipeline.idle();
    expect(pipeline.getRoundStats(BOUT_ID, 1)).toBeUndefined();

    time.advance(20_000);
    await pipeline.idle();
    expect(cito.fetchRound).toHaveBeenCalledTimes(2);
    expect(pipeline.getRoundStats(BOUT_ID, 1)).toMatchObject({
      provisional: true,
      revision: 1,
      fighterB,
    });
    await pipeline.close();
  });

  it("reconciles all rounds once and bumps revision only for a corrected hash", async () => {
    const corrected = payload(1, {
      fighterB: { ...fighterB, significantStrikes: 21 },
      sourceUpdatedAt: "2026-07-28T00:20:00Z",
    });
    const cito = fetcher([payload()], [corrected]);
    const { bus, time, pipeline } = await setup(cito);

    emitProvisional(bus);
    await pipeline.idle();
    time.advance(6_000);
    await pipeline.idle();
    emitConfirmed(bus);
    await pipeline.idle();
    const firstHash = pipeline.getRoundStats(BOUT_ID, 1)?.payloadHash;

    bus.emit({
      type: "FIGHT_ENDED",
      boutId: BOUT_ID,
      round: 1,
      detectedAt: new Date(BASE_TIME + 30_000).toISOString(),
    });
    await pipeline.idle();
    time.advance(0);
    await pipeline.idle();

    const reconciled = pipeline.getRoundStats(BOUT_ID, 1);
    expect(cito.fetchAllRounds).toHaveBeenCalledTimes(1);
    expect(reconciled).toMatchObject({
      provisional: false,
      revision: 2,
      fighterB: { significantStrikes: 21 },
    });
    expect(reconciled?.payloadHash).not.toBe(firstHash);
    expect(pipeline.getRevisionHistory(BOUT_ID, 1)).toHaveLength(2);

    bus.emit({
      type: "FIGHT_ENDED",
      boutId: BOUT_ID,
      round: 1,
      detectedAt: new Date(BASE_TIME + 31_000).toISOString(),
    });
    await pipeline.idle();
    time.advance(0);
    await pipeline.idle();
    expect(cito.fetchAllRounds).toHaveBeenCalledTimes(1);
    await pipeline.close();
  });

  it("deduplicates lifecycle events, jobs, and current records", async () => {
    const cito = fetcher([payload()]);
    const { bus, storage, time, pipeline } = await setup(cito);

    emitProvisional(bus);
    emitProvisional(bus);
    await pipeline.idle();
    expect(pipeline.scheduler.getJobs()).toHaveLength(1);

    time.advance(6_000);
    await pipeline.idle();
    emitConfirmed(bus);
    emitConfirmed(bus);
    await pipeline.idle();

    expect(cito.fetchRound).toHaveBeenCalledTimes(1);
    expect(pipeline.scheduler.getJobs()).toHaveLength(1);
    const persisted = await storage.read(ROUND_STATS_STORAGE_STREAM);
    expect(persisted).toHaveLength(2);
    expect(pipeline.getRevisionHistory(BOUT_ID, 1)).toHaveLength(1);
    await pipeline.close();
  });

  it("restores pending jobs but never reruns a completed round job", async () => {
    const storage = new MemoryStorage();
    const time = new ManualTime(BASE_TIME);
    const firstFetcher = fetcher([payload()]);
    const first = await setup(firstFetcher, { storage, time });

    emitProvisional(first.bus);
    await first.pipeline.idle();
    await first.pipeline.close();

    time.advance(10_000);
    const restoredFetcher = fetcher([payload()]);
    const restored = await setup(restoredFetcher, { storage, time });
    time.advance(0);
    await restored.pipeline.idle();
    expect(restoredFetcher.fetchRound).toHaveBeenCalledTimes(1);
    expect(restored.pipeline.getRoundStats(BOUT_ID, 1)).toBeDefined();
    await restored.pipeline.close();

    const thirdFetcher = fetcher([payload()]);
    const third = await setup(thirdFetcher, { storage, time });
    time.advance(60_000);
    await third.pipeline.idle();
    expect(thirdFetcher.fetchRound).not.toHaveBeenCalled();
    expect(third.pipeline.getRoundStats(BOUT_ID, 1)).toBeDefined();
    await third.pipeline.close();
  });

  it("isolates one terminal Cito failure from another round job", async () => {
    const calls: number[] = [];
    const cito: CitoRoundStatsFetcher = {
      async fetchRound(_boutId, round) {
        calls.push(round);
        if (round === 1) throw new Error("round one transport failed");
        return payload(round);
      },
      async fetchAllRounds() {
        return [];
      },
    };
    const { bus, time, pipeline } = await setup(cito);

    emitProvisional(bus, 1);
    emitProvisional(bus, 2);
    await pipeline.idle();
    time.advance(6_000);
    await pipeline.idle();

    expect(calls).toEqual([1, 2]);
    expect(pipeline.getRoundStats(BOUT_ID, 1)).toBeUndefined();
    expect(pipeline.getRoundStats(BOUT_ID, 2)).toBeDefined();
    expect(
      pipeline.scheduler.getJobs().find(({ round }) => round === 1),
    ).toMatchObject({ status: "failed", attemptCount: 1 });
    expect(
      pipeline.scheduler.getJobs().find(({ round }) => round === 2),
    ).toMatchObject({ status: "completed", attemptCount: 1 });
    expect(
      pipeline.scheduler.getJobs().some(
        ({ jobType }) => jobType === CITO_RECONCILIATION_JOB_TYPE,
      ),
    ).toBe(false);
    await pipeline.close();
  });

  it("serializes independent Cito requests through the quota guard", async () => {
    let active = 0;
    let maximumActive = 0;
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const cito: CitoRoundStatsFetcher = {
      async fetchRound(_boutId, round) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (round === 1) {
          markFirstStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        active -= 1;
        return payload(round);
      },
      async fetchAllRounds() {
        return [];
      },
    };
    const { bus, time, pipeline } = await setup(cito);

    emitProvisional(bus, 1);
    emitProvisional(bus, 2);
    await pipeline.idle();
    time.advance(6_000);
    await firstStarted;
    expect(active).toBe(1);
    releaseFirst?.();
    await pipeline.idle();

    expect(maximumActive).toBe(1);
    expect(pipeline.getRoundStats(BOUT_ID, 1)).toBeDefined();
    expect(pipeline.getRoundStats(BOUT_ID, 2)).toBeDefined();
    await pipeline.close();
  });
});
