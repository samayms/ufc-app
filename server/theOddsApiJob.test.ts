import type { OddsSnapshot } from "../src/schema.ts";
import {
  createOddsApiSource,
  THE_ODDS_API_H2H_REQUEST,
  type TheOddsApiSource,
} from "../src/sources/oddsapi.ts";
import { loadFixtureEvent } from "../src/store/fixtureEvent.ts";
import { describe, expect, it, vi } from "vitest";
import { CollectorEventBus } from "./eventBus.ts";
import {
  RoundJobScheduler,
  type RoundJobTimer,
} from "./roundJobs.ts";
import { MemoryStorage } from "./storage.ts";
import {
  TheOddsApiRoundJob,
  THE_ODDS_API_ROUND_JOB_TYPE,
  theOddsApiDelayMs,
} from "./theOddsApiJob.ts";
import { MarketTickStore } from "./tickStore.ts";

class ManualTime implements RoundJobTimer {
  value = Date.parse("2026-07-26T02:40:40Z");

  private nextId = 1;

  private readonly timers = new Map<
    number,
    { callback: () => void; dueAt: number }
  >();

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

function mainBout() {
  const bout = loadFixtureEvent().bouts.find(
    (candidate) => candidate.id === "bout-main",
  );
  if (bout === undefined) throw new Error("Missing main bout");
  return bout;
}

async function setup(
  source: Pick<TheOddsApiSource, "getH2hSnapshot">,
  random = () => 0.5,
  enabled?: boolean | (() => boolean),
) {
  const eventBus = new CollectorEventBus();
  const storage = new MemoryStorage();
  const time = new ManualTime();
  const tickStore = await MarketTickStore.create({
    eventBus,
    storage,
    clock: time,
    staleAfterMs: 60_000,
  });
  const scheduler = await RoundJobScheduler.create({
    storage,
    clock: time,
    timer: time,
  });
  const roundJob = new TheOddsApiRoundJob({
    eventBus,
    scheduler,
    source,
    tickStore,
    getBout: (boutId) =>
      boutId === "bout-main" ? mainBout() : undefined,
    clock: time,
    random,
    ...(enabled === undefined ? {} : { enabled }),
  });
  return { eventBus, roundJob, scheduler, tickStore, time };
}

describe("The Odds API round job", () => {
  it("uses the inclusive T+20–30 second delay window", () => {
    expect(theOddsApiDelayMs(0)).toBe(20_000);
    expect(theOddsApiDelayMs(0.5)).toBe(25_000);
    expect(theOddsApiDelayMs(1)).toBe(30_000);
  });

  it("fetches the exact broad US h2h request once and stores a labeled snapshot", async () => {
    const fixture = createOddsApiSource({ mode: "fixture" });
    const getH2hSnapshot = vi.spyOn(fixture, "getH2hSnapshot");
    const { eventBus, roundJob, scheduler, tickStore, time } =
      await setup(fixture);
    const scheduledAt = time.now();
    await tickStore.ingest({
      source: "kalshi",
      boutId: "bout-main",
      marketType: "fight-winner",
      outcome: "Danilo Reyes",
      bid: 58,
      ask: 60,
      sourceUpdatedAt: "2026-07-26T02:40:30Z",
      receivedAt: "2026-07-26T02:40:35Z",
      stale: false,
    });

    eventBus.emit({
      type: "ROUND_ENDED",
      boutId: "bout-main",
      round: 1,
      detectedAt: new Date(time.now()).toISOString(),
      confirmation: "period_transition",
    });
    await roundJob.idle();
    const job = scheduler.getJobs()[0];
    expect(job).toMatchObject({
      jobType: THE_ODDS_API_ROUND_JOB_TYPE,
      dueAt: scheduledAt + 25_000,
      retryPolicy: { delayMs: 0, maxAttempts: 1 },
    });

    time.advance(24_999);
    await roundJob.idle();
    expect(getH2hSnapshot).not.toHaveBeenCalled();
    time.advance(1);
    await roundJob.idle();

    expect(getH2hSnapshot).toHaveBeenCalledTimes(1);
    expect(getH2hSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bout-main" }),
      THE_ODDS_API_H2H_REQUEST,
    );
    expect(
      tickStore.getSnapshots("bout-main", 1),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "kalshi",
        boundaryType: "confirmed",
      }),
      expect.objectContaining({
        source: "the-odds-api",
        boundaryType: "confirmed",
        label: "broad-post-round-comparison",
        outcomes: expect.arrayContaining([
          expect.objectContaining({
            bookmaker: "draftkings",
            rawOdds: -185,
            noVigProbability: expect.any(Number),
          }),
        ]),
      }),
    ]));
    await roundJob.close();
    await scheduler.close();
    await tickStore.close();
  });

  it("makes a single attempt and omits the snapshot without blocking another job", async () => {
    const getH2hSnapshot = vi.fn<
      TheOddsApiSource["getH2hSnapshot"]
    >(async () => {
      throw new Error("upstream unavailable");
    });
    const { eventBus, roundJob, scheduler, tickStore, time } =
      await setup({ getH2hSnapshot }, () => 0);
    const independent = vi.fn(async () => undefined);
    scheduler.registerHandler("independent", independent);
    await scheduler.schedule({
      boutId: "bout-main",
      round: 1,
      jobType: "independent",
      dueAt: time.now() + 20_000,
      retryPolicy: { delayMs: 0, maxAttempts: 1 },
    });

    eventBus.emit({
      type: "ROUND_ENDED",
      boutId: "bout-main",
      round: 1,
      detectedAt: new Date(time.now()).toISOString(),
      confirmation: "period_transition",
    });
    await roundJob.idle();
    time.advance(20_000);
    await roundJob.idle();

    expect(getH2hSnapshot).toHaveBeenCalledTimes(1);
    expect(independent).toHaveBeenCalledTimes(1);
    expect(tickStore.getSnapshots("bout-main", 1)).toEqual([]);
    expect(
      scheduler.getJobs().find(
        (job) => job.jobType === THE_ODDS_API_ROUND_JOB_TYPE,
      ),
    ).toMatchObject({ status: "failed", attemptCount: 1 });
    await roundJob.close();
    await scheduler.close();
    await tickStore.close();
  });

  it("leaves no-vig absent when a bookmaker has an unpaired h2h outcome", async () => {
    const bout = mainBout();
    const unpaired: OddsSnapshot = {
      boutId: bout.id,
      market: "sportsbook",
      quotes: [
        {
          corner: "red",
          native: {
            kind: "american-moneyline",
            moneyline: -185,
            book: "draftkings",
          },
          impliedProbability: 185 / 285,
        },
      ],
      marketUpdatedAt: "2026-07-26T02:40:30Z",
      provenance: {
        source: "odds-api",
        fetchedAt: "2026-07-26T02:40:30Z",
        synthetic: true,
      },
    };
    const { eventBus, roundJob, scheduler, tickStore, time } =
      await setup({ getH2hSnapshot: async () => unpaired }, () => 0);
    eventBus.emit({
      type: "ROUND_ENDED",
      boutId: "bout-main",
      round: 1,
      detectedAt: new Date(time.now()).toISOString(),
      confirmation: "period_transition",
    });
    await roundJob.idle();
    time.advance(20_000);
    await roundJob.idle();

    const outcome = tickStore.getSnapshots("bout-main", 1)[0]
      ?.outcomes[0];
    expect(outcome).toMatchObject({
      bookmaker: "draftkings",
      rawOdds: -185,
    });
    expect(outcome?.noVigProbability).toBeUndefined();
    await roundJob.close();
    await scheduler.close();
    await tickStore.close();
  });

  it("no-ops on round end when disabled with a boolean", async () => {
    const fixture = createOddsApiSource({ mode: "fixture" });
    const getH2hSnapshot = vi.spyOn(fixture, "getH2hSnapshot");
    const { eventBus, roundJob, scheduler, tickStore, time } =
      await setup(fixture, () => 0.5, false);

    eventBus.emit({
      type: "ROUND_ENDED",
      boutId: "bout-main",
      round: 1,
      detectedAt: new Date(time.now()).toISOString(),
      confirmation: "period_transition",
    });
    await roundJob.idle();
    time.advance(30_000);
    await roundJob.idle();

    expect(scheduler.getJobs()).toEqual([]);
    expect(getH2hSnapshot).not.toHaveBeenCalled();
    await roundJob.close();
    await scheduler.close();
    await tickStore.close();
  });

  it("no-ops on round end when the enabled predicate returns false", async () => {
    const fixture = createOddsApiSource({ mode: "fixture" });
    const getH2hSnapshot = vi.spyOn(fixture, "getH2hSnapshot");
    const { eventBus, roundJob, scheduler, tickStore, time } =
      await setup(fixture, () => 0.5, () => false);

    eventBus.emit({
      type: "ROUND_ENDED",
      boutId: "bout-main",
      round: 1,
      detectedAt: new Date(time.now()).toISOString(),
      confirmation: "period_transition",
    });
    await roundJob.idle();
    time.advance(30_000);
    await roundJob.idle();

    expect(scheduler.getJobs()).toEqual([]);
    expect(getH2hSnapshot).not.toHaveBeenCalled();
    await roundJob.close();
    await scheduler.close();
    await tickStore.close();
  });
});
