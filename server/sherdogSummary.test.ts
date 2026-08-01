import { describe, expect, it, vi } from "vitest";
import type { Bout } from "../src/schema.ts";
import type { CitoRoundStatsFetcher } from "../src/sources/cito.ts";
import { loadFixtureEvent } from "../src/store/fixtureEvent.ts";
import { CollectorEventBus } from "./eventBus.ts";
import type { RoundSummarizer } from "./geminiSummarizer.ts";
import type { RoundJobClock, RoundJobTimer } from "./roundJobs.ts";
import { RoundStatsPipeline } from "./roundStats.ts";
import {
  SHERDOG_OBSERVATIONS_STORAGE_STREAM,
  SHERDOG_BOUNDARY_POLL_INTERVAL_MS,
  SherdogRoundJobs,
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
    this.timers.set(id, { callback, dueAt: this.value + delayMs });
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
    const zero = {
      significantStrikes: 0,
      totalStrikes: 0,
      takedowns: 0,
      takedownsAttempted: 0,
      controlTimeSeconds: 0,
      knockdowns: 0,
    };
    return { boutId, round, fighterA: zero, fighterB: zero };
  },
  async fetchAllRounds() {
    return [];
  },
};

function html(commentary: string): string {
  return `<article><h3>Round 1</h3><p>${commentary}</p><p>Sherdog scores the round 10-9 Reyes.</p></article>`;
}

function response(body: string): SherdogFetchResponse {
  return {
    status: 200,
    html: body,
    sourceUrl: "https://www.sherdog.com/news/fixture",
    publishedAt: "2026-07-28T00:00:09Z",
  };
}

async function setup(
  fetchBout: SherdogFetcher["fetchBout"],
  summarizer: RoundSummarizer,
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
    fetcher: { fetchBout },
    getBout: (boutId): Bout | undefined =>
      boutId === bout.id ? bout : undefined,
    dataMode: "fixture",
    permissionScope: "none",
    requestIntervalMs: 0,
    summarizer,
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

describe("Sherdog round summaries", () => {
  it("attaches the model's summary to the stored observation", async () => {
    const summarize = vi
      .fn<RoundSummarizer["summarize"]>()
      .mockResolvedValue("Reyes controls the round behind the jab.");
    const { eventBus, storage, time, roundStats, jobs } = await setup(
      async () => response(html("Reyes jabs and circles all round.")),
      { summarize },
    );

    roundEnded(eventBus);
    await jobs.idle();
    time.advance(SHERDOG_BOUNDARY_POLL_INTERVAL_MS);
    await jobs.idle();

    expect(jobs.getObservation(bout.id, 1)?.observation).toMatchObject({
      commentary: "Reyes jabs and circles all round.",
      aiSummary: "Reyes controls the round behind the jab.",
    });
    await expect(
      storage.read(SHERDOG_OBSERVATIONS_STORAGE_STREAM),
    ).resolves.toEqual([
      expect.objectContaining({
        value: expect.objectContaining({
          observation: expect.objectContaining({
            aiSummary: "Reyes controls the round behind the jab.",
          }),
        }),
      }),
    ]);
    await jobs.close();
    await roundStats.close();
  });

  it("gives the model the bout's fighters and the round's scorer cards", async () => {
    const summarize = vi
      .fn<RoundSummarizer["summarize"]>()
      .mockResolvedValue("A summary.");
    const { eventBus, time, roundStats, jobs } = await setup(
      async () => response(html("Reyes jabs.")),
      { summarize },
    );

    roundEnded(eventBus);
    await jobs.idle();
    time.advance(SHERDOG_BOUNDARY_POLL_INTERVAL_MS);
    await jobs.idle();

    expect(summarize).toHaveBeenCalledWith({
      round: 1,
      redName: bout.fighters.red.name,
      blueName: bout.fighters.blue.name,
      commentary: "Reyes jabs.",
      scorerCards: [
        { scorer: "Sherdog", winner: "Reyes", roundScore: "10-9" },
      ],
    });
    await jobs.close();
    await roundStats.close();
  });

  it("does not re-summarize a payload that has not changed", async () => {
    const summarize = vi
      .fn<RoundSummarizer["summarize"]>()
      .mockResolvedValue("A summary.");
    const { eventBus, time, roundStats, jobs } = await setup(
      async () => response(html("Reyes jabs.")),
      { summarize },
    );

    roundEnded(eventBus);
    await jobs.idle();
    time.advance(SHERDOG_BOUNDARY_POLL_INTERVAL_MS);
    await jobs.idle();
    eventBus.emit({
      type: "FIGHT_ENDED",
      boutId: bout.id,
      round: 1,
      detectedAt: "2026-07-28T00:01:00Z",
    });
    await jobs.idle();
    time.advance(SHERDOG_BOUNDARY_POLL_INTERVAL_MS);
    await jobs.idle();

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(jobs.getObservation(bout.id, 1)?.observation.aiSummary).toBe(
      "A summary.",
    );
    await jobs.close();
    await roundStats.close();
  });

  it("re-summarizes when the live blog revises the round", async () => {
    const summarize = vi
      .fn<RoundSummarizer["summarize"]>()
      .mockResolvedValueOnce("First summary.")
      .mockResolvedValueOnce("Revised summary.");
    let body = html("Reyes jabs.");
    const { eventBus, time, roundStats, jobs } = await setup(
      async () => response(body),
      { summarize },
    );

    roundEnded(eventBus);
    await jobs.idle();
    time.advance(SHERDOG_BOUNDARY_POLL_INTERVAL_MS);
    await jobs.idle();
    body = html("Reyes jabs, then drops Volkov late.");
    eventBus.emit({
      type: "FIGHT_ENDED",
      boutId: bout.id,
      round: 1,
      detectedAt: "2026-07-28T00:01:00Z",
    });
    await jobs.idle();
    time.advance(SHERDOG_BOUNDARY_POLL_INTERVAL_MS);
    await jobs.idle();

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(jobs.getObservation(bout.id, 1)?.observation.aiSummary).toBe(
      "Revised summary.",
    );
    await jobs.close();
    await roundStats.close();
  });

  it("keeps the observation when the summarizer returns nothing", async () => {
    const { eventBus, time, roundStats, jobs } = await setup(
      async () => response(html("Reyes jabs.")),
      { summarize: async () => "" },
    );

    roundEnded(eventBus);
    await jobs.idle();
    time.advance(SHERDOG_BOUNDARY_POLL_INTERVAL_MS);
    await jobs.idle();

    const stored = jobs.getObservation(bout.id, 1)?.observation;
    expect(stored?.commentary).toBe("Reyes jabs.");
    expect(stored?.aiSummary).toBeUndefined();
    await jobs.close();
    await roundStats.close();
  });

  it("keeps the observation when the summarizer throws", async () => {
    const { eventBus, time, roundStats, jobs } = await setup(
      async () => response(html("Reyes jabs.")),
      {
        summarize: async () => {
          throw new Error("gemini exploded");
        },
      },
    );

    roundEnded(eventBus);
    await jobs.idle();
    time.advance(SHERDOG_BOUNDARY_POLL_INTERVAL_MS);
    await jobs.idle();

    const stored = jobs.getObservation(bout.id, 1)?.observation;
    expect(stored?.commentary).toBe("Reyes jabs.");
    expect(stored?.aiSummary).toBeUndefined();
    await jobs.close();
    await roundStats.close();
  });
});
