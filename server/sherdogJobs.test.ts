import { describe, expect, it, vi } from "vitest";
import type { Bout } from "../src/schema.ts";
import type { CitoRoundStatsFetcher } from "../src/sources/cito.ts";
import { parserVersion } from "../src/sources/sherdog.ts";
import { loadFixtureEvent } from "../src/store/fixtureEvent.ts";
import { CollectorEventBus } from "./eventBus.ts";
import type {
  RoundJobClock,
  RoundJobTimer,
} from "./roundJobs.ts";
import { RoundStatsPipeline } from "./roundStats.ts";
import {
  SHERDOG_FINAL_JOB_TYPE,
  SHERDOG_ROUND_JOB_TYPE,
  SherdogRoundJobs,
  sherdogInitialDelayMs,
  sherdogRetryDelayMs,
  type SherdogFetchResponse,
  type SherdogFetcher,
} from "./sherdogJobs.ts";
import { MemoryStorage } from "./storage.ts";

class ManualTime implements RoundJobClock, RoundJobTimer {
  value = Date.parse("2026-07-28T00:00:00Z");

  private nextId = 1;

  private readonly timers = new Map<
    number,
    { callback: () => void; dueAt: number }
  >();

  now(): number {
    return this.value;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
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

const bout = loadFixtureEvent().bouts.find(
  (candidate) => candidate.id === "bout-main",
)!;

const cito: CitoRoundStatsFetcher = {
  async fetchRound(boutId, round) {
    return {
      boutId,
      round,
      fighterA: {
        significantStrikes: 10,
        totalStrikes: 15,
        takedowns: 0,
        takedownsAttempted: 0,
        controlTimeSeconds: 0,
        knockdowns: 0,
      },
      fighterB: {
        significantStrikes: 9,
        totalStrikes: 14,
        takedowns: 0,
        takedownsAttempted: 0,
        controlTimeSeconds: 0,
        knockdowns: 0,
      },
    };
  },
  async fetchAllRounds() {
    return [];
  },
};

function html(round: number, commentary: string): string {
  return `<article><h3>Round ${round}</h3><p>${commentary}</p><p>Sherdog scores the round 10-9 Reyes.</p></article>`;
}

function response(body: string, status = 200): SherdogFetchResponse {
  return {
    status,
    html: body,
    sourceUrl: "https://www.sherdog.com/news/fixture",
    publishedAt: "2026-07-28T00:00:09Z",
  };
}

async function setup(
  fetcher: SherdogFetcher,
  options: {
    dataMode?: "fixture" | "live";
    permissionScope?: string;
  } = {},
) {
  const eventBus = new CollectorEventBus();
  const storage = new MemoryStorage();
  const time = new ManualTime();
  const roundStats = await RoundStatsPipeline.create({
    eventBus,
    storage,
    fetcher: cito,
    clock: time,
    timer: time,
  });
  const jobs = await SherdogRoundJobs.create({
    eventBus,
    scheduler: roundStats.scheduler,
    storage,
    roundStats,
    fetcher,
    getBout: (boutId): Bout | undefined =>
      boutId === bout.id ? bout : undefined,
    dataMode: options.dataMode ?? "fixture",
    permissionScope: options.permissionScope ?? "none",
    requestIntervalMs: 0,
    clock: time,
    random: () => 0,
  });
  return { eventBus, storage, time, roundStats, jobs };
}

function roundEnded(eventBus: CollectorEventBus, round = 1): void {
  eventBus.emit({
    type: "PROVISIONAL_ROUND_ENDED",
    boutId: bout.id,
    round,
    detectedAt: "2026-07-28T00:00:00Z",
  });
}

describe("SherdogRoundJobs", () => {
  it("keeps both scheduling windows inside the specified bounds", () => {
    expect([
      sherdogInitialDelayMs(0),
      sherdogInitialDelayMs(1),
    ]).toEqual([10_000, 15_000]);
    expect([
      sherdogInitialDelayMs(0) + sherdogRetryDelayMs(0),
      sherdogInitialDelayMs(1) + sherdogRetryDelayMs(1),
    ]).toEqual([30_000, 45_000]);
  });

  it("schedules at T+10–15 seconds and retries an absent round once inside T+30–45", async () => {
    const fetchBout = vi
      .fn<SherdogFetcher["fetchBout"]>()
      .mockResolvedValueOnce(response(html(2, "Later round")))
      .mockResolvedValueOnce(response(html(1, "Round arrived")));
    const setupValue = await setup({ fetchBout });
    const { eventBus, time, roundStats, jobs } = setupValue;

    roundEnded(eventBus);
    await jobs.idle();
    const scheduled = roundStats.scheduler
      .getJobs()
      .find((job) => job.jobType === SHERDOG_ROUND_JOB_TYPE);
    expect(scheduled).toBeDefined();
    expect(scheduled!.dueAt - time.now()).toBe(10_000);

    time.advance(9_999);
    await jobs.idle();
    expect(fetchBout).not.toHaveBeenCalled();
    time.advance(1);
    await jobs.idle();
    expect(fetchBout).toHaveBeenCalledTimes(1);
    expect(jobs.getObservation(bout.id, 1)).toBeUndefined();

    time.advance(19_999);
    await jobs.idle();
    expect(fetchBout).toHaveBeenCalledTimes(1);
    time.advance(1);
    await jobs.idle();
    expect(fetchBout).toHaveBeenCalledTimes(2);
    expect(jobs.getObservation(bout.id, 1)).toMatchObject({
      revision: 1,
      observation: {
        commentary: "Round arrived",
        parserVersion,
        payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(
      roundStats.getUnifiedRound(bout.id, 1)?.sherdog,
    ).toMatchObject({ commentary: "Round arrived" });
    await jobs.close();
    await roundStats.close();
  });

  it("omits an absent round after the single retry", async () => {
    const fetchBout = vi
      .fn<SherdogFetcher["fetchBout"]>()
      .mockResolvedValue(response(html(2, "Wrong round")));
    const { eventBus, time, roundStats, jobs } = await setup({
      fetchBout,
    });

    roundEnded(eventBus);
    await jobs.idle();
    time.advance(10_000);
    await jobs.idle();
    time.advance(20_000);
    await jobs.idle();

    expect(fetchBout).toHaveBeenCalledTimes(2);
    expect(jobs.getObservation(bout.id, 1)).toBeUndefined();
    expect(
      roundStats.scheduler
        .getJobs()
        .find((job) => job.jobType === SHERDOG_ROUND_JOB_TYPE),
    ).toMatchObject({ status: "failed", attemptCount: 2 });
    await jobs.close();
    await roundStats.close();
  });

  it("reconciles once after fight end and revises only a changed payload", async () => {
    const fetchBout = vi
      .fn<SherdogFetcher["fetchBout"]>()
      .mockResolvedValueOnce(response(html(1, "Original")))
      .mockResolvedValueOnce(response(html(1, "Corrected")));
    const { eventBus, time, roundStats, jobs } = await setup({
      fetchBout,
    });

    roundEnded(eventBus);
    await jobs.idle();
    time.advance(10_000);
    await jobs.idle();
    const firstHash = jobs.getObservation(bout.id, 1)?.observation.payloadHash;

    eventBus.emit({
      type: "FIGHT_ENDED",
      boutId: bout.id,
      round: 1,
      detectedAt: "2026-07-28T00:01:00Z",
    });
    await jobs.idle();
    time.advance(0);
    await jobs.idle();
    expect(fetchBout).toHaveBeenCalledTimes(2);
    expect(jobs.getObservation(bout.id, 1)).toMatchObject({
      revision: 2,
      observation: { commentary: "Corrected" },
    });
    expect(
      jobs.getObservation(bout.id, 1)?.observation.payloadHash,
    ).not.toBe(firstHash);
    expect(jobs.getRevisionHistory(bout.id, 1)).toHaveLength(2);

    eventBus.emit({
      type: "FIGHT_ENDED",
      boutId: bout.id,
      round: 1,
      detectedAt: "2026-07-28T00:01:01Z",
    });
    await jobs.idle();
    time.advance(0);
    await jobs.idle();
    expect(
      roundStats.scheduler
        .getJobs()
        .filter((job) => job.jobType === SHERDOG_FINAL_JOB_TYPE),
    ).toHaveLength(1);
    expect(fetchBout).toHaveBeenCalledTimes(2);
    await jobs.close();
    await roundStats.close();
  });

  it("stops the run after HTTP 403 without blocking Cito or market jobs", async () => {
    const fetchBout = vi
      .fn<SherdogFetcher["fetchBout"]>()
      .mockResolvedValue(response("", 403));
    const { eventBus, time, roundStats, jobs } = await setup({
      fetchBout,
    });
    const marketJob = vi.fn(async () => undefined);
    roundStats.scheduler.registerHandler("market_test", marketJob);

    roundEnded(eventBus);
    await jobs.idle();
    await roundStats.scheduler.schedule({
      boutId: bout.id,
      round: 1,
      jobType: "market_test",
      dueAt: time.now() + 10_000,
      retryPolicy: { delayMs: 0, maxAttempts: 1 },
    });
    time.advance(10_000);
    await jobs.idle();

    expect(jobs.getHealth()).toMatchObject({
      stopped: true,
      message: expect.stringContaining("HTTP 403"),
    });
    expect(marketJob).toHaveBeenCalledTimes(1);
    expect(roundStats.getRoundStats(bout.id, 1)).toBeDefined();

    roundEnded(eventBus, 2);
    await jobs.idle();
    time.advance(10_000);
    await jobs.idle();
    expect(fetchBout).toHaveBeenCalledTimes(1);
    await jobs.close();
    await roundStats.close();
  });

  it("does not call the live fetcher outside the configured permission scope", async () => {
    const fetchBout = vi
      .fn<SherdogFetcher["fetchBout"]>()
      .mockResolvedValue(response(html(1, "Must not be fetched")));
    const { eventBus, time, roundStats, jobs } = await setup(
      { fetchBout },
      { dataMode: "live", permissionScope: "none" },
    );

    roundEnded(eventBus);
    await jobs.idle();
    time.advance(10_000);
    await jobs.idle();

    expect(fetchBout).not.toHaveBeenCalled();
    expect(
      roundStats.scheduler
        .getJobs()
        .find((job) => job.jobType === SHERDOG_ROUND_JOB_TYPE),
    ).toMatchObject({ status: "failed", attemptCount: 1 });
    await jobs.close();
    await roundStats.close();
  });
});
