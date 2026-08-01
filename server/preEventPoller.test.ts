import { describe, expect, it } from "vitest";
import {
  CollectorEventBus,
} from "./eventBus.ts";
import {
  PRE_EVENT_INTERVAL_EVENT_DAY_MS,
  PRE_EVENT_INTERVAL_NON_EVENT_DAY_MS,
  PRE_EVENT_POLL_STORAGE_STREAM,
  PreEventPoller,
  nextPreEventPollAt,
  preEventIntervalMs,
  sourceCalendarDay,
  type PreEventPollClock,
  type PreEventPollTimer,
} from "./preEventPoller.ts";
import { MemoryStorage } from "./storage.ts";
import type { UpcomingOddsDocument } from "../src/lib/upcomingOdds.ts";

const BASE_TIME = Date.parse("2026-07-29T00:00:00.000Z");

class ManualTime implements PreEventPollClock, PreEventPollTimer {
  value = BASE_TIME;
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

  timerCount(): number {
    return this.timers.size;
  }
}

function documentWithStarts(...startsAt: string[]): UpcomingOddsDocument {
  return {
    version: 1,
    generatedAt: "2026-07-29T00:00:00.000Z",
    synthetic: true,
    events: startsAt.map((start, index) => ({
      espnEventId: `event-${index}`,
      name: `Event ${index}`,
      startsAt: start,
      bouts: [],
    })),
    providerRuns: {},
    unmatchedMarkets: [],
  };
}

function pollerOptions(
  time: ManualTime,
  storage = new MemoryStorage(),
  overrides: Partial<ConstructorParameters<typeof PreEventPoller>[0]> = {},
) {
  let document = documentWithStarts("2026-07-30T12:00:00.000Z");
  return {
    storage,
    clock: time,
    timer: time,
    readDocument: async () => document,
    runSync: async () => undefined,
    ...overrides,
    setDocument(next: UpcomingOddsDocument) {
      document = next;
    },
  };
}

describe("pre-event schedule helpers", () => {
  it("uses twelve hours off event day and one hour on event day", () => {
    const now = Date.parse("2026-07-29T09:00:00Z");
    expect(
      preEventIntervalMs({
        now,
        eventStartTimes: ["2026-07-30T12:00:00Z"],
      }),
    ).toBe(PRE_EVENT_INTERVAL_NON_EVENT_DAY_MS);
    expect(
      preEventIntervalMs({
        now,
        eventStartTimes: ["2026-07-29T12:00:00Z"],
      }),
    ).toBe(PRE_EVENT_INTERVAL_EVENT_DAY_MS);
  });

  it("uses the event timestamp offset at a source-local day boundary", () => {
    expect(sourceCalendarDay("2026-07-29T00:30:00-04:00")).toEqual({
      day: "2026-07-29",
      offsetMinutes: -240,
    });
    expect(
      preEventIntervalMs({
        now: Date.parse("2026-07-29T03:59:00Z"),
        eventStartTimes: ["2026-07-29T00:30:00-04:00"],
      }),
    ).toBe(PRE_EVENT_INTERVAL_NON_EVENT_DAY_MS);
    expect(
      preEventIntervalMs({
        now: Date.parse("2026-07-29T04:01:00Z"),
        eventStartTimes: ["2026-07-29T00:30:00-04:00"],
      }),
    ).toBe(PRE_EVENT_INTERVAL_EVENT_DAY_MS);
    expect(
      preEventIntervalMs({
        now: Date.parse("2026-07-29T09:00:00Z"),
        eventStartTimes: ["not-a-time", "2026-07-28T12:00:00Z"],
      }),
    ).toBe(PRE_EVENT_INTERVAL_NON_EVENT_DAY_MS);
  });

  it("returns now for a never-run poll and the remaining persisted interval otherwise", () => {
    const now = Date.parse("2026-07-29T09:00:00Z");
    expect(
      nextPreEventPollAt({
        now,
        eventStartTimes: ["2026-07-29T12:00:00Z"],
      }),
    ).toBe(now);
    expect(
      nextPreEventPollAt({
        now,
        lastSuccessAt: now - 5 * 60_000,
        eventStartTimes: ["2026-07-29T12:00:00Z"],
      }),
    ).toBe(now - 5 * 60_000 + PRE_EVENT_INTERVAL_EVENT_DAY_MS);
  });
});

describe("PreEventPoller", () => {
  it("runs immediately when never run, persists success, and re-arms on the new interval", async () => {
    const time = new ManualTime();
    let calls = 0;
    let promotions = 0;
    const options = pollerOptions(time, undefined, {
      runSync: async () => {
        calls += 1;
      },
      onSuccess: async () => {
        promotions += 1;
      },
    });
    const poller = new PreEventPoller(options);

    await poller.start();
    expect(calls).toBe(1);
    expect(promotions).toBe(1);
    await expect(options.storage.read(PRE_EVENT_POLL_STORAGE_STREAM)).resolves
      .toEqual([
        {
          version: 1,
          completedAt: BASE_TIME,
          intervalMs: PRE_EVENT_INTERVAL_NON_EVENT_DAY_MS,
          mode: "non-event-day",
        },
      ]);
    expect(time.timerCount()).toBe(1);
    time.advance(PRE_EVENT_INTERVAL_NON_EVENT_DAY_MS - 1);
    await poller.idle();
    expect(calls).toBe(1);
    time.advance(1);
    await poller.idle();
    expect(calls).toBe(2);
    expect(promotions).toBe(2);
    await poller.close();
  });

  it("deduplicates a restart inside the persisted interval and runs after an old success", async () => {
    const storage = new MemoryStorage();
    await storage.append(PRE_EVENT_POLL_STORAGE_STREAM, {
      version: 1,
      completedAt: BASE_TIME - 2 * 60 * 60_000,
      intervalMs: PRE_EVENT_INTERVAL_NON_EVENT_DAY_MS,
      mode: "non-event-day",
    });
    const time = new ManualTime();
    let calls = 0;
    const first = new PreEventPoller(
      pollerOptions(time, storage, {
        runSync: async () => {
          calls += 1;
        },
      }),
    );
    await first.start();
    expect(calls).toBe(0);
    expect(time.timerCount()).toBe(1);
    time.advance(10 * 60 * 60_000 - 1);
    await first.idle();
    expect(calls).toBe(0);
    time.advance(1);
    await first.idle();
    expect(calls).toBe(1);
    await first.close();

    const oldStorage = new MemoryStorage();
    await oldStorage.append(PRE_EVENT_POLL_STORAGE_STREAM, {
      version: 1,
      completedAt: BASE_TIME - 13 * 60 * 60_000,
      intervalMs: PRE_EVENT_INTERVAL_NON_EVENT_DAY_MS,
      mode: "non-event-day",
    });
    const old = new PreEventPoller(
      pollerOptions(time, oldStorage, {
        runSync: async () => {
          calls += 1;
        },
      }),
    );
    await old.start();
    expect(calls).toBe(2);
    await old.close();
  });

  it("retries failures without advancing last success", async () => {
    const time = new ManualTime();
    const storage = new MemoryStorage();
    let calls = 0;
    const options = pollerOptions(time, storage, {
      retryMs: 15 * 60_000,
      runSync: async () => {
        calls += 1;
        if (calls === 1) throw new Error("temporary outage");
      },
    });
    const poller = new PreEventPoller(
      options,
    );
    await poller.start();
    expect(calls).toBe(1);
    expect(poller.getLastSuccessAt()).toBeUndefined();
    expect(time.timerCount()).toBe(1);
    time.advance(15 * 60_000);
    await poller.idle();
    expect(calls).toBe(2);
    expect(poller.getLastSuccessAt()).toBe(time.now());
    await expect(
      storage.read(PRE_EVENT_POLL_STORAGE_STREAM),
    ).resolves.toEqual([
      expect.objectContaining({ reason: "retryable" }),
      expect.objectContaining({ completedAt: time.now() }),
    ]);
    await poller.close();
  });

  it("suspends on active bouts, skips a due slot, and resumes after fight end", async () => {
    const time = new ManualTime();
    const bus = new CollectorEventBus();
    let active = true;
    let calls = 0;
    const poller = new PreEventPoller(
      pollerOptions(time, undefined, {
        eventBus: bus,
        getLifecycleStates: () =>
          active
            ? [{
                boutId: "bout-1",
                state: "in",
                period: 1,
                completed: false,
                receivedAt: new Date(time.now()).toISOString(),
              }]
            : [],
        runSync: async () => {
          calls += 1;
        },
      }),
    );
    await poller.start();
    expect(poller.isSuspended()).toBe(true);
    expect(calls).toBe(0);
    bus.emit({
      type: "FIGHT_STARTED",
      boutId: "bout-1",
      detectedAt: new Date(time.now()).toISOString(),
    });
    time.advance(PRE_EVENT_INTERVAL_NON_EVENT_DAY_MS);
    await poller.idle();
    expect(calls).toBe(0);
    active = false;
    bus.emit({
      type: "FIGHT_ENDED",
      boutId: "bout-1",
      round: 1,
      detectedAt: new Date(time.now()).toISOString(),
    });
    time.advance(PRE_EVENT_INTERVAL_NON_EVENT_DAY_MS - 1);
    await poller.idle();
    expect(calls).toBe(0);
    time.advance(1);
    await poller.idle();
    expect(calls).toBe(1);
    await poller.close();
  });

  it("starts suspended after restoring an active lifecycle state", async () => {
    const time = new ManualTime();
    let calls = 0;
    const poller = new PreEventPoller(
      pollerOptions(time, undefined, {
        getLifecycleStates: () => [{
          boutId: "bout-1",
          state: "in",
          period: 1,
          completed: false,
          receivedAt: new Date(time.now()).toISOString(),
        }],
        runSync: async () => {
          calls += 1;
        },
      }),
    );
    await poller.start();
    expect(poller.isSuspended()).toBe(true);
    expect(calls).toBe(0);
    await poller.close();
  });

  it("does not overlap concurrent triggers", async () => {
    const time = new ManualTime();
    let release!: () => void;
    let calls = 0;
    const runSync = () =>
      new Promise<void>((resolve) => {
        calls += 1;
        release = resolve;
      });
    const poller = new PreEventPoller(
      pollerOptions(time, undefined, { runSync }),
    );
    const first = poller.trigger();
    const second = poller.trigger();
    for (let index = 0; index < 10 && release === undefined; index += 1) {
      await Promise.resolve();
    }
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    await poller.close();
  });

  it("never runs when disabled and close is idempotent", async () => {
    const time = new ManualTime();
    let calls = 0;
    const poller = new PreEventPoller(
      pollerOptions(time, undefined, {
        enabled: false,
        runSync: async () => {
          calls += 1;
        },
      }),
    );
    await poller.start();
    await poller.close();
    await poller.close();
    expect(calls).toBe(0);
    expect(time.timerCount()).toBe(0);
  });
});
