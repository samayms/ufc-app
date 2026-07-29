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
  createLiveSherdogFetcher,
  SHERDOG_ROUND_ATTEMPT_DELAYS_MS,
  SHERDOG_FINAL_JOB_TYPE,
  SherdogRoundJobs,
  sherdogRoundJobType,
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
    requestIntervalMs?: number;
    storage?: MemoryStorage;
    time?: ManualTime;
  } = {},
) {
  const eventBus = new CollectorEventBus();
  const storage = options.storage ?? new MemoryStorage();
  const time = options.time ?? new ManualTime();
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
    requestIntervalMs: options.requestIntervalMs ?? 0,
    clock: time,
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
  it("schedules three independent attempts at exactly T+15s, T+30s, and T+60s", async () => {
    const fetchBout = vi.fn<SherdogFetcher["fetchBout"]>();
    const { eventBus, time, roundStats, jobs } = await setup({
      fetchBout,
    });

    roundEnded(eventBus);
    await jobs.idle();

    const scheduled = roundStats.scheduler
      .getJobs()
      .filter((job) => job.jobType.startsWith("sherdog_round_"));
    expect(scheduled).toHaveLength(3);
    expect(
      scheduled.map((job) => [
        job.jobType,
        job.dueAt - time.now(),
        job.retryPolicy,
      ]),
    ).toEqual([
      [
        sherdogRoundJobType(1),
        SHERDOG_ROUND_ATTEMPT_DELAYS_MS[0],
        { delayMs: 0, maxAttempts: 1 },
      ],
      [
        sherdogRoundJobType(2),
        SHERDOG_ROUND_ATTEMPT_DELAYS_MS[1],
        { delayMs: 0, maxAttempts: 1 },
      ],
      [
        sherdogRoundJobType(3),
        SHERDOG_ROUND_ATTEMPT_DELAYS_MS[2],
        { delayMs: 0, maxAttempts: 1 },
      ],
    ]);
    await jobs.close();
    await roundStats.close();
  });

  it("keeps later attempts scheduled after a terminal first attempt", async () => {
    const fetchBout = vi
      .fn<SherdogFetcher["fetchBout"]>()
      .mockResolvedValueOnce(
        response("<html><body>no round headings</body></html>"),
      )
      .mockResolvedValueOnce(response(html(1, "Round arrived")));
    const { eventBus, time, roundStats, jobs } = await setup({
      fetchBout,
    });

    roundEnded(eventBus);
    await jobs.idle();

    time.advance(SHERDOG_ROUND_ATTEMPT_DELAYS_MS[0]);
    await jobs.idle();
    expect(fetchBout).toHaveBeenCalledTimes(1);
    expect(jobs.getObservation(bout.id, 1)).toBeUndefined();
    expect(
      roundStats.scheduler.getJob(
        bout.id + ":1:" + sherdogRoundJobType(1),
      ),
    ).toMatchObject({ status: "failed", attemptCount: 1 });
    expect(
      roundStats.scheduler.getJob(
        bout.id + ":1:" + sherdogRoundJobType(2),
      ),
    ).toMatchObject({ status: "pending", attemptCount: 0 });
    expect(
      roundStats.scheduler.getJob(
        bout.id + ":1:" + sherdogRoundJobType(3),
      ),
    ).toMatchObject({ status: "pending", attemptCount: 0 });

    time.advance(
      SHERDOG_ROUND_ATTEMPT_DELAYS_MS[1] -
        SHERDOG_ROUND_ATTEMPT_DELAYS_MS[0],
    );
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

  it("records an absent round when the second attempt finds it", async () => {
    const fetchBout = vi
      .fn<SherdogFetcher["fetchBout"]>()
      .mockResolvedValueOnce(response(html(2, "Wrong round")))
      .mockResolvedValueOnce(response(html(1, "Round arrived")));
    const { eventBus, time, roundStats, jobs } = await setup({
      fetchBout,
    });

    roundEnded(eventBus);
    await jobs.idle();
    time.advance(SHERDOG_ROUND_ATTEMPT_DELAYS_MS[0]);
    await jobs.idle();
    time.advance(
      SHERDOG_ROUND_ATTEMPT_DELAYS_MS[1] -
        SHERDOG_ROUND_ATTEMPT_DELAYS_MS[0],
    );
    await jobs.idle();

    expect(fetchBout).toHaveBeenCalledTimes(2);
    expect(jobs.getObservation(bout.id, 1)).toMatchObject({
      revision: 1,
      observation: { commentary: "Round arrived" },
    });
    expect(jobs.getRevisionHistory(bout.id, 1)).toHaveLength(1);
    expect(
      roundStats.scheduler.getJob(
        bout.id + ":1:" + sherdogRoundJobType(1),
      ),
    ).toMatchObject({ status: "failed", attemptCount: 1 });
    expect(
      roundStats.scheduler.getJob(
        bout.id + ":1:" + sherdogRoundJobType(2),
      ),
    ).toMatchObject({ status: "completed", attemptCount: 1 });
    await jobs.close();
    await roundStats.close();
  });

  it("deduplicates identical payloads across all three attempts", async () => {
    const fetchBout = vi
      .fn<SherdogFetcher["fetchBout"]>()
      .mockResolvedValue(response(html(1, "Same payload")));
    const { eventBus, time, roundStats, jobs } = await setup({
      fetchBout,
    });

    roundEnded(eventBus);
    await jobs.idle();
    time.advance(SHERDOG_ROUND_ATTEMPT_DELAYS_MS[0]);
    await jobs.idle();
    time.advance(
      SHERDOG_ROUND_ATTEMPT_DELAYS_MS[1] -
        SHERDOG_ROUND_ATTEMPT_DELAYS_MS[0],
    );
    await jobs.idle();
    time.advance(
      SHERDOG_ROUND_ATTEMPT_DELAYS_MS[2] -
        SHERDOG_ROUND_ATTEMPT_DELAYS_MS[1],
    );
    await jobs.idle();

    expect(fetchBout).toHaveBeenCalledTimes(3);
    expect(jobs.getObservation(bout.id, 1)).toMatchObject({ revision: 1 });
    expect(jobs.getRevisionHistory(bout.id, 1)).toHaveLength(1);
    expect(
      roundStats.scheduler
        .getJobs()
        .filter((job) => job.jobType.startsWith("sherdog_round_")),
    ).toHaveLength(3);
    await jobs.close();
    await roundStats.close();
  });

  it("does not duplicate attempts when the round event is redelivered", async () => {
    const fetchBout = vi.fn<SherdogFetcher["fetchBout"]>();
    const { eventBus, roundStats, jobs } = await setup({
      fetchBout,
    });

    roundEnded(eventBus);
    roundEnded(eventBus);
    await jobs.idle();

    expect(
      roundStats.scheduler
        .getJobs()
        .filter((job) => job.jobType.startsWith("sherdog_round_")),
    ).toHaveLength(3);
    await jobs.close();
    await roundStats.close();
  });

  it("restores all pending attempts after scheduler restart", async () => {
    const storage = new MemoryStorage();
    const time = new ManualTime();
    const first = await setup(
      { fetchBout: vi.fn<SherdogFetcher["fetchBout"]>() },
      { storage, time },
    );
    roundEnded(first.eventBus);
    await first.jobs.idle();
    await first.jobs.close();
    await first.roundStats.close();

    const second = await setup(
      { fetchBout: vi.fn<SherdogFetcher["fetchBout"]>() },
      { storage, time },
    );
    expect(
      second.roundStats.scheduler
        .getJobs()
        .filter((job) => job.jobType.startsWith("sherdog_round_")),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobType: sherdogRoundJobType(1),
          status: "pending",
          dueAt: time.now() + SHERDOG_ROUND_ATTEMPT_DELAYS_MS[0],
        }),
        expect.objectContaining({
          jobType: sherdogRoundJobType(2),
          status: "pending",
          dueAt: time.now() + SHERDOG_ROUND_ATTEMPT_DELAYS_MS[1],
        }),
        expect.objectContaining({
          jobType: sherdogRoundJobType(3),
          status: "pending",
          dueAt: time.now() + SHERDOG_ROUND_ATTEMPT_DELAYS_MS[2],
        }),
      ]),
    );
    await second.jobs.close();
    await second.roundStats.close();
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
    time.advance(SHERDOG_ROUND_ATTEMPT_DELAYS_MS[0]);
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
    time.advance(SHERDOG_ROUND_ATTEMPT_DELAYS_MS[0]);
    await jobs.idle();

    expect(jobs.getHealth()).toMatchObject({
      stopped: true,
      message: expect.stringContaining("HTTP 403"),
    });
    expect(marketJob).toHaveBeenCalledTimes(1);
    expect(roundStats.getRoundStats(bout.id, 1)).toBeDefined();

    roundEnded(eventBus, 2);
    await jobs.idle();
    time.advance(SHERDOG_ROUND_ATTEMPT_DELAYS_MS[0]);
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
    time.advance(SHERDOG_ROUND_ATTEMPT_DELAYS_MS[0]);
    await jobs.idle();

    expect(fetchBout).not.toHaveBeenCalled();
    expect(
      roundStats.scheduler
        .getJobs()
        .find((job) => job.jobType === sherdogRoundJobType(1)),
    ).toMatchObject({ status: "failed", attemptCount: 1 });
    await jobs.close();
    await roundStats.close();
  });

  it("enforces the configured request interval through the existing guard", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(html(1, "Interval-limited"), { status: 200 }));
    const fetcher = createLiveSherdogFetcher({
      permissionScope: "sherdog-read",
      resolveBoutUrl: () => "/news/news/live-card",
      baseUrl: "https://sherdog.example.invalid",
      fetchImpl,
    });
    const { eventBus, time, roundStats, jobs } = await setup(fetcher, {
      dataMode: "live",
      permissionScope: "sherdog-read",
      requestIntervalMs: 60_000,
    });

    roundEnded(eventBus);
    await jobs.idle();
    time.advance(SHERDOG_ROUND_ATTEMPT_DELAYS_MS[0]);
    await jobs.idle();
    time.advance(
      SHERDOG_ROUND_ATTEMPT_DELAYS_MS[1] -
        SHERDOG_ROUND_ATTEMPT_DELAYS_MS[0],
    );
    await jobs.idle();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      roundStats.scheduler.getJob(
        bout.id + ":1:" + sherdogRoundJobType(2),
      ),
    ).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("request interval has not elapsed"),
    });
    await jobs.close();
    await roundStats.close();
  });
});
