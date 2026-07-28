import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ROUND_JOB_DEAD_LETTER_STREAM,
  RoundJobScheduler,
  roundJobKey,
  type RoundJobClock,
  type RoundJobTimer,
} from "./roundJobs.ts";
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

const retryPolicy = { delayMs: 20_000, maxAttempts: 2 };

describe("RoundJobScheduler", () => {
  it("persists unique jobs and never reruns completed work after restart", async () => {
    const storage = new MemoryStorage();
    const time = new ManualTime(1_000);
    const run = vi.fn(async () => undefined);
    const first = await RoundJobScheduler.create({
      storage,
      clock: time,
      timer: time,
      handlers: { cito_round_stats: run },
    });

    await expect(
      first.schedule({
        boutId: "bout-main",
        round: 1,
        jobType: "cito_round_stats",
        dueAt: 6_000,
        retryPolicy,
      }),
    ).resolves.toBe(true);
    await expect(
      first.schedule({
        boutId: "bout-main",
        round: 1,
        jobType: "cito_round_stats",
        dueAt: 9_000,
        retryPolicy,
      }),
    ).resolves.toBe(false);

    time.advance(5_000);
    await first.idle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      first.getJob(
        roundJobKey("bout-main", 1, "cito_round_stats"),
      )?.status,
    ).toBe("completed");
    await first.close();

    const restoredRun = vi.fn(async () => undefined);
    const restored = await RoundJobScheduler.create({
      storage,
      clock: time,
      timer: time,
      handlers: { cito_round_stats: restoredRun },
    });
    time.advance(60_000);
    await restored.idle();

    expect(restoredRun).not.toHaveBeenCalled();
    await restored.close();
  });

  it("runs jobs missed while down immediately on restore", async () => {
    const storage = new MemoryStorage();
    const firstTime = new ManualTime(1_000);
    const first = await RoundJobScheduler.create({
      storage,
      clock: firstTime,
      timer: firstTime,
      handlers: { stats: async () => undefined },
    });
    await first.schedule({
      boutId: "bout-main",
      round: 2,
      jobType: "stats",
      dueAt: 6_000,
      retryPolicy,
    });
    await first.close();

    const restoredTime = new ManualTime(10_000);
    const run = vi.fn(async () => undefined);
    const restored = await RoundJobScheduler.create({
      storage,
      clock: restoredTime,
      timer: restoredTime,
      handlers: { stats: run },
    });
    restoredTime.advance(0);
    await restored.idle();

    expect(run).toHaveBeenCalledTimes(1);
    expect(restored.getJobs()[0]?.status).toBe("completed");
    await restored.close();
  });

  it("retries per policy and persists a dead letter after terminal failure", async () => {
    const storage = new MemoryStorage();
    const time = new ManualTime(1_000);
    const run = vi.fn(async () => {
      throw new Error("still absent");
    });
    const scheduler = await RoundJobScheduler.create({
      storage,
      clock: time,
      timer: time,
      handlers: { stats: run },
    });
    await scheduler.schedule({
      boutId: "bout-main",
      round: 1,
      jobType: "stats",
      dueAt: 1_000,
      retryPolicy,
    });

    time.advance(0);
    await scheduler.idle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.getJobs()[0]).toMatchObject({
      status: "pending",
      attemptCount: 1,
      dueAt: 21_000,
    });

    time.advance(20_000);
    await scheduler.idle();
    expect(run).toHaveBeenCalledTimes(2);
    expect(scheduler.getJobs()[0]).toMatchObject({
      status: "failed",
      attemptCount: 2,
      lastError: "still absent",
    });
    await expect(
      storage.read(DEFAULT_ROUND_JOB_DEAD_LETTER_STREAM),
    ).resolves.toEqual([
      expect.objectContaining({
        error: "still absent",
        job: expect.objectContaining({ status: "failed" }),
      }),
    ]);
    await scheduler.close();
  });

  it("runs independent jobs concurrently and isolates a failure", async () => {
    const storage = new MemoryStorage();
    const time = new ManualTime(1_000);
    let releaseSlow: (() => void) | undefined;
    let markSlowStarted: (() => void) | undefined;
    let markFailedStarted: (() => void) | undefined;
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    const failedStarted = new Promise<void>((resolve) => {
      markFailedStarted = resolve;
    });
    const slow = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          markSlowStarted?.();
          releaseSlow = resolve;
        }),
    );
    const failed = vi.fn(async () => {
      markFailedStarted?.();
      throw new Error("source failed");
    });
    const scheduler = await RoundJobScheduler.create({
      storage,
      clock: time,
      timer: time,
      handlers: { slow, failed },
    });
    await scheduler.schedule({
      boutId: "bout-main",
      round: 1,
      jobType: "slow",
      dueAt: 1_000,
      retryPolicy: { delayMs: 0, maxAttempts: 1 },
    });
    await scheduler.schedule({
      boutId: "bout-main",
      round: 1,
      jobType: "failed",
      dueAt: 1_000,
      retryPolicy: { delayMs: 0, maxAttempts: 1 },
    });

    time.advance(0);
    await Promise.all([slowStarted, failedStarted]);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
    releaseSlow?.();
    await scheduler.idle();

    expect(
      scheduler.getJob(roundJobKey("bout-main", 1, "slow"))?.status,
    ).toBe("completed");
    expect(
      scheduler.getJob(roundJobKey("bout-main", 1, "failed"))
        ?.status,
    ).toBe("failed");
    await scheduler.close();
  });
});
