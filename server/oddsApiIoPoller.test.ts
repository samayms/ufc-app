import { loadFixtureEvent } from "../src/store/fixtureEvent.ts";
import {
  createOddsApiIoSource,
  OddsApiIoRequestError,
  type OddsApiIoSource,
} from "../src/sources/oddsApiIo.ts";
import { describe, expect, it, vi } from "vitest";
import { CollectorEventBus } from "./eventBus.ts";
import {
  OddsApiIoPoller,
  oddsApiIoPollingPolicy,
  type OddsApiIoPollTimer,
} from "./oddsApiIoPoller.ts";
import { RollingQuotaGuard } from "./quota.ts";
import { MemoryStorage } from "./storage.ts";

class ManualTime implements OddsApiIoPollTimer {
  value = Date.parse("2026-07-26T02:34:46Z");

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

function resolvedMainBout() {
  const bout = loadFixtureEvent().bouts.find(
    (candidate) => candidate.id === "bout-main",
  );
  if (bout === undefined) throw new Error("Missing fixture main bout");
  return {
    bout,
    externalBoutId: "oai-bout-reyes-volkov",
  };
}

async function createPoller(options?: {
  source?: OddsApiIoSource;
  quota?: RollingQuotaGuard;
}) {
  const eventBus = new CollectorEventBus();
  const storage = new MemoryStorage();
  const time = new ManualTime();
  const ingest = vi.fn(async () => ({} as never));
  const snapshotSource = vi.fn(async () => undefined);
  const source =
    options?.source ?? createOddsApiIoSource({ mode: "fixture" });
  const poller = await OddsApiIoPoller.create({
    eventBus,
    storage,
    source,
    tickStore: { ingest, snapshotSource },
    resolveBout: (boutId) =>
      boutId === "bout-main" ? resolvedMainBout() : undefined,
    bookmakers: ["draftkings", "fanduel"],
    clock: time,
    timer: time,
    ...(options?.quota === undefined ? {} : { quota: options.quota }),
  });
  return { eventBus, ingest, poller, snapshotSource, time };
}

describe("Odds-API.io adaptive polling", () => {
  it.each([
    [{ hour: 31, day: 30 }, { mode: "periodic", intervalMs: 30_000 }],
    [{ hour: 30, day: 30 }, { mode: "periodic", intervalMs: 45_000 }],
    [{ hour: 15, day: 30 }, { mode: "periodic", intervalMs: 45_000 }],
    [{ hour: 14, day: 30 }, { mode: "periodic", intervalMs: 60_000 }],
    [{ hour: 90, day: 29 }, { mode: "boundary-only" }],
  ])("uses the exact quota boundary for %o", (remaining, expected) => {
    expect(oddsApiIoPollingPolicy(remaining)).toEqual(expected);
  });

  it("enters daily-cap boundary-only mode", async () => {
    const storage = new MemoryStorage();
    const time = new ManualTime();
    const quota = await RollingQuotaGuard.create({
      storage,
      policies: {
        "odds-api-io": {
          perMinute: 1_000,
          perHour: 1_000,
          perDay: 450,
        },
      },
      clock: time,
    });
    for (let request = 0; request < 421; request += 1) {
      await quota.tryAcquire("odds-api-io");
    }
    const { eventBus, poller, time: pollTime } = await createPoller({
      quota,
    });
    const source = vi.spyOn(
      (poller as unknown as { source: OddsApiIoSource }).source,
      "getBoutOdds",
    );

    eventBus.emit({
      type: "FIGHT_STARTED",
      boutId: "bout-main",
      detectedAt: new Date(time.now()).toISOString(),
    });
    await poller.idle();
    expect(source).not.toHaveBeenCalled();
    pollTime.advance(120_000);
    await poller.idle();
    expect(source).not.toHaveBeenCalled();

    eventBus.emit({
      type: "PROVISIONAL_ROUND_ENDED",
      boutId: "bout-main",
      round: 1,
      detectedAt: new Date(time.now()).toISOString(),
    });
    await poller.idle();
    expect(source).toHaveBeenCalledTimes(1);
    await poller.close();
  });

  it("gates polling to the active fight, continues through breaks, and takes one final snapshot", async () => {
    const source = createOddsApiIoSource({ mode: "fixture" });
    const fetch = vi.spyOn(source, "getBoutOdds");
    const { eventBus, poller, snapshotSource, time } =
      await createPoller({ source });

    eventBus.emit({
      type: "PROVISIONAL_ROUND_ENDED",
      boutId: "bout-main",
      round: 1,
      detectedAt: new Date(time.now()).toISOString(),
    });
    await poller.idle();
    expect(fetch).not.toHaveBeenCalled();

    eventBus.emit({
      type: "FIGHT_STARTED",
      boutId: "bout-main",
      detectedAt: new Date(time.now()).toISOString(),
    });
    await poller.idle();
    expect(fetch).toHaveBeenCalledTimes(1);

    eventBus.emit({
      type: "ROUND_ENDED",
      boutId: "bout-main",
      round: 1,
      detectedAt: new Date(time.now()).toISOString(),
      confirmation: "period_transition",
    });
    time.advance(30_000);
    await poller.idle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(poller.isActive("bout-main")).toBe(true);

    eventBus.emit({
      type: "FIGHT_ENDED",
      boutId: "bout-main",
      round: 2,
      detectedAt: new Date(time.now()).toISOString(),
    });
    await poller.idle();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(poller.isActive("bout-main")).toBe(false);
    expect(snapshotSource).toHaveBeenCalledWith(
      "bout-main",
      2,
      "odds-api-io",
      "confirmed",
      expect.any(String),
    );

    time.advance(120_000);
    eventBus.emit({
      type: "ROUND_ENDED",
      boutId: "bout-main",
      round: 2,
      detectedAt: new Date(time.now()).toISOString(),
      confirmation: "fight_completed",
    });
    await poller.idle();
    expect(fetch).toHaveBeenCalledTimes(3);
    await poller.close();
  });

  it("retries only a typed transient failure and charges quota for both attempts", async () => {
    const fixture = createOddsApiIoSource({ mode: "fixture" });
    const getBoutOdds = vi
      .fn<OddsApiIoSource["getBoutOdds"]>()
      .mockRejectedValueOnce(
        new OddsApiIoRequestError("transient", "temporary upstream error"),
      )
      .mockImplementation((query) => fixture.getBoutOdds(query));
    const source: OddsApiIoSource = {
      discoverEvents: () => fixture.discoverEvents(),
      getBoutOdds,
      getTickHistory: (boutId, marketSource) =>
        fixture.getTickHistory(boutId, marketSource),
    };
    const { eventBus, poller, time } = await createPoller({ source });

    eventBus.emit({
      type: "FIGHT_STARTED",
      boutId: "bout-main",
      detectedAt: new Date(time.now()).toISOString(),
    });
    await poller.idle();

    expect(getBoutOdds).toHaveBeenCalledTimes(2);
    expect(await poller.quota.remaining("odds-api-io")).toMatchObject({
      hour: 88,
      day: 448,
    });
    await poller.close();
  });

  it("does not retry an authentication failure", async () => {
    const getBoutOdds = vi.fn<OddsApiIoSource["getBoutOdds"]>(
      async () => {
        throw new OddsApiIoRequestError("auth", "invalid key");
      },
    );
    const source: OddsApiIoSource = {
      discoverEvents: async () => [],
      getBoutOdds,
      getTickHistory: async () => [],
    };
    const { eventBus, poller, time } = await createPoller({ source });
    eventBus.emit({
      type: "FIGHT_STARTED",
      boutId: "bout-main",
      detectedAt: new Date(time.now()).toISOString(),
    });
    await poller.idle();
    time.advance(120_000);
    await poller.idle();

    expect(getBoutOdds).toHaveBeenCalledTimes(1);
    await poller.close();
  });
});
