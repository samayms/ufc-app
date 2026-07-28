import { describe, expect, it, vi } from "vitest";
import { createXSource } from "../src/sources/x.ts";
import { loadFixtureEvent } from "../src/store/fixtureEvent.ts";
import { CollectorEventBus } from "./eventBus.ts";
import {
  RoundJobScheduler,
  type RoundJobClock,
  type RoundJobTimer,
} from "./roundJobs.ts";
import type { UnifiedRoundRecord } from "./roundStats.ts";
import { MemoryStorage } from "./storage.ts";
import {
  X_API_LATE_CHECK_DELAY_MS,
  X_API_ROUND_JOB_TYPE,
  XRoundJobs,
} from "./xJobs.ts";

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
    for (;;) {
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

function unified(round: number): UnifiedRoundRecord {
  return {
    boutId: "bout-main",
    round,
    detectedEndedAt: "2026-07-28T00:00:00Z",
    endingSignal: "period_transition",
    marketAtEnd: {},
    provisional: false,
  };
}

describe("XRoundJobs", () => {
  it("performs one late API check per round and stops at the spending cap", async () => {
    const storage = new MemoryStorage();
    const time = new ManualTime();
    const eventBus = new CollectorEventBus();
    const scheduler = await RoundJobScheduler.create({
      storage,
      clock: time,
      timer: time,
    });
    const apiFetcher = vi.fn(async ({ round }: { round: number }) => [
      {
        boutId: "bout-main",
        sourcePostId: String(1000 + round),
        scorer: "MMAJunkie",
        round,
        score: { red: 10, blue: 9 },
      },
    ]);
    const source = createXSource({
      mode: "api",
      bearerToken: "secret",
      apiFetcher,
      now: () => new Date(time.now()).toISOString(),
    });
    const records = new Map<number, UnifiedRoundRecord>([
      [1, unified(1)],
      [2, unified(2)],
    ]);
    const setXScores = vi.fn(async (
      _boutId: string,
      round: number,
      scores: NonNullable<UnifiedRoundRecord["xScores"]>,
    ) => {
      records.set(round, { ...records.get(round)!, xScores: scores });
      return true;
    });
    const jobs = await XRoundJobs.create({
      eventBus,
      scheduler,
      storage,
      source,
      roundStats: {
        getUnifiedRound: (_boutId, round) => records.get(round),
        setXScores,
        idle: async () => undefined,
      },
      getBout: (boutId) =>
        loadFixtureEvent().bouts.find((bout) => bout.id === boutId),
      spendingCapUsd: 0.01,
      requestCostUsd: 0.01,
      clock: time,
    });

    eventBus.emit({
      type: "ROUND_ENDED",
      boutId: "bout-main",
      round: 1,
      detectedAt: "2026-07-28T00:00:00Z",
      confirmation: "period_transition",
    });
    await jobs.idle();
    expect(
      scheduler.getJobs().find(
        (job) => job.jobType === X_API_ROUND_JOB_TYPE,
      )?.dueAt,
    ).toBe(time.now() + X_API_LATE_CHECK_DELAY_MS);
    time.advance(X_API_LATE_CHECK_DELAY_MS);
    await jobs.idle();
    expect(apiFetcher).toHaveBeenCalledTimes(1);
    expect(setXScores).toHaveBeenCalledTimes(1);
    await expect(jobs.spending.spentUsd("x-api")).resolves.toBe(0.01);

    eventBus.emit({
      type: "ROUND_ENDED",
      boutId: "bout-main",
      round: 2,
      detectedAt: "2026-07-28T00:01:00Z",
      confirmation: "period_transition",
    });
    await jobs.idle();
    time.advance(X_API_LATE_CHECK_DELAY_MS);
    await jobs.idle();

    expect(apiFetcher).toHaveBeenCalledTimes(1);
    expect(
      scheduler
        .getJobs()
        .find(
          (job) =>
            job.jobType === X_API_ROUND_JOB_TYPE && job.round === 2,
        ),
    ).toMatchObject({ status: "failed", attemptCount: 1 });
    await jobs.close();
    await scheduler.close();
  });
});
