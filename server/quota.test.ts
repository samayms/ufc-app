import { describe, expect, it } from "vitest";
import {
  DEFAULT_ODDS_API_IO_QUOTA_POLICY,
  RequestIntervalGuard,
  RollingQuotaGuard,
  SpendingCapGuard,
  type QuotaClock,
} from "./quota.ts";
import { MemoryStorage } from "./storage.ts";

class TestClock implements QuotaClock {
  value: number;

  constructor(value: number) {
    this.value = value;
  }

  now(): number {
    return this.value;
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

const policies = {
  cito: { perMinute: 9, perHour: 20, perDay: 30 },
};

describe("RollingQuotaGuard", () => {
  it("rolls acquisitions out of exact rolling windows", async () => {
    const clock = new TestClock(Date.parse("2026-07-28T00:00:00Z"));
    const guard = await RollingQuotaGuard.create({
      storage: new MemoryStorage(),
      policies,
      clock,
    });

    await expect(guard.tryAcquire("cito")).resolves.toBe(true);
    expect(await guard.remaining("cito")).toEqual({
      minute: 8,
      hour: 19,
      day: 29,
    });

    clock.advance(60_000);
    expect(await guard.remaining("cito")).toEqual({
      minute: 9,
      hour: 19,
      day: 29,
    });

    clock.advance(59 * 60_000);
    expect(await guard.remaining("cito")).toEqual({
      minute: 9,
      hour: 20,
      day: 29,
    });

    clock.advance(23 * 60 * 60_000);
    expect(await guard.remaining("cito")).toEqual({
      minute: 9,
      hour: 20,
      day: 30,
    });
  });

  it("restores persisted acquisitions after restart", async () => {
    const storage = new MemoryStorage();
    const clock = new TestClock(Date.parse("2026-07-28T00:00:00Z"));
    const first = await RollingQuotaGuard.create({
      storage,
      policies,
      clock,
    });

    await first.tryAcquire("cito");
    await first.tryAcquire("cito");

    const restored = await RollingQuotaGuard.create({
      storage,
      policies,
      clock,
    });

    expect(await restored.remaining("cito")).toEqual({
      minute: 7,
      hour: 18,
      day: 28,
    });
    await expect(
      restored.isRemainingAtOrBelow("cito", "hour", 18),
    ).resolves.toBe(true);
    await expect(
      restored.hasRemaining("cito", "day", 29),
    ).resolves.toBe(false);
  });

  it("atomically keeps Cito below ten serialized acquisitions per minute", async () => {
    const guard = await RollingQuotaGuard.create({
      storage: new MemoryStorage(),
      policies,
      clock: new TestClock(Date.parse("2026-07-28T00:00:00Z")),
    });

    const acquisitions = await Promise.all(
      Array.from({ length: 12 }, () => guard.tryAcquire("cito")),
    );

    expect(acquisitions.filter(Boolean)).toHaveLength(9);
    expect(await guard.remaining("cito")).toMatchObject({ minute: 0 });
  });

  it("persists Odds-API.io hourly and daily soft-cap usage across restart", async () => {
    const storage = new MemoryStorage();
    const clock = new TestClock(Date.parse("2026-07-28T00:00:00Z"));
    const first = await RollingQuotaGuard.create({
      storage,
      policies: {
        "odds-api-io": DEFAULT_ODDS_API_IO_QUOTA_POLICY,
      },
      clock,
    });
    await first.tryAcquire("odds-api-io");
    await first.tryAcquire("odds-api-io");
    await first.tryAcquire("odds-api-io");

    const restored = await RollingQuotaGuard.create({
      storage,
      policies: {
        "odds-api-io": DEFAULT_ODDS_API_IO_QUOTA_POLICY,
      },
      clock,
    });
    await expect(restored.remaining("odds-api-io")).resolves.toEqual({
      minute: 87,
      hour: 87,
      day: 447,
    });
  });

  it("enforces persisted minimum request intervals", async () => {
    const storage = new MemoryStorage();
    const clock = new TestClock(Date.parse("2026-07-28T00:00:00Z"));
    const first = await RequestIntervalGuard.create({
      storage,
      intervalsMs: { sherdog: 30_000 },
      clock,
    });

    await expect(first.tryAcquire("sherdog")).resolves.toBe(true);
    await expect(first.tryAcquire("sherdog")).resolves.toBe(false);
    clock.advance(29_999);
    const restored = await RequestIntervalGuard.create({
      storage,
      intervalsMs: { sherdog: 30_000 },
      clock,
    });
    await expect(restored.tryAcquire("sherdog")).resolves.toBe(false);
    clock.advance(1);
    await expect(restored.tryAcquire("sherdog")).resolves.toBe(true);
  });

  it("persists paid API spend and refuses the request that crosses the cap", async () => {
    const storage = new MemoryStorage();
    const clock = new TestClock(Date.parse("2026-07-28T00:00:00Z"));
    const first = await SpendingCapGuard.create({
      storage,
      capsUsd: { "x-api": 0.02 },
      clock,
    });

    await expect(first.trySpend("x-api", 0.01)).resolves.toBe(true);
    const restored = await SpendingCapGuard.create({
      storage,
      capsUsd: { "x-api": 0.02 },
      clock,
    });
    await expect(restored.trySpend("x-api", 0.01)).resolves.toBe(true);
    await expect(restored.trySpend("x-api", 0.01)).resolves.toBe(false);
    await expect(restored.spentUsd("x-api")).resolves.toBe(0.02);
  });
});
