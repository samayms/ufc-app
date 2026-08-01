import { describe, expect, it } from "vitest";
import { loadFixtureEvent } from "../src/store/fixtureEvent.ts";
import { CollectorEventBus } from "./eventBus.ts";
import { FightLifecycleMachine } from "./lifecycle.ts";
import {
  boutLifecycleEntry,
  createFixtureLifecycleProvider,
  createLiveCitoLifecycleProvider,
  createLiveEspnLifecycleProvider,
  DEFAULT_ESPN_FAILURE_THRESHOLD,
  LifecycleDriver,
  type LifecycleDriverClock,
  type LifecycleDriverTimer,
  type LifecycleObservationInput,
  type LifecycleObservationProvider,
} from "./lifecycleDriver.ts";
import { MemoryStorage } from "./storage.ts";

const BOUT_ID = "bout-main";
const BASE_TIME = Date.parse("2026-07-28T00:00:00.000Z");

function at(seconds: number): string {
  return new Date(BASE_TIME + seconds * 1_000).toISOString();
}

class ManualDriverTime implements LifecycleDriverClock, LifecycleDriverTimer {
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
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { callback, dueAt: this.value + delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  pendingTimerCount(): number {
    return this.timers.size;
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

async function createMachine(): Promise<{
  bus: CollectorEventBus;
  machine: FightLifecycleMachine;
}> {
  const bus = new CollectorEventBus();
  const machine = await FightLifecycleMachine.create({
    eventBus: bus,
    storage: new MemoryStorage(),
  });
  return { bus, machine };
}

function observationInput(
  time: ManualDriverTime,
  overrides: Partial<LifecycleObservationInput> = {},
): LifecycleObservationInput {
  return {
    boutId: BOUT_ID,
    state: "in",
    period: 1,
    completed: false,
    // Mid-round: ESPN's clock counts down from 5:00 (300 seconds).
    clockSeconds: 120,
    receivedAt: new Date(time.now()).toISOString(),
    ...overrides,
  };
}

describe("boutLifecycleEntry", () => {
  it("derives pre/in/post lifecycle entries from normalized bout status", () => {
    const bouts = loadFixtureEvent().bouts;
    const main = bouts.find((bout) => bout.id === "bout-main");
    const comain = bouts.find((bout) => bout.id === "bout-comain");
    const upcoming = bouts.find((bout) => bout.id === "bout-3");

    expect(main).toBeDefined();
    expect(comain).toBeDefined();
    expect(upcoming).toBeDefined();

    expect(boutLifecycleEntry(main!)).toEqual({
      externalId: "bout-main",
      state: "in",
      period: 2,
      completed: false,
      clockSeconds: 0,
    });
    expect(boutLifecycleEntry(comain!)).toEqual({
      externalId: "bout-comain",
      state: "post",
      period: 2,
      completed: true,
    });
    expect(boutLifecycleEntry(upcoming!)).toEqual({
      externalId: "bout-3",
      state: "pre",
      period: 0,
      completed: false,
    });
  });
});

describe("createFixtureLifecycleProvider", () => {
  it("never makes network calls and resolves bout ids by identity", async () => {
    const time = new ManualDriverTime();
    const provider = createFixtureLifecycleProvider(
      () => loadFixtureEvent().bouts,
      time,
    );

    const observations = await provider.fetchObservations(time.now());
    const main = observations.find((entry) => entry.boutId === "bout-main");

    expect(main).toEqual({
      boutId: "bout-main",
      state: "in",
      period: 2,
      completed: false,
      clockSeconds: 0,
      receivedAt: at(0),
    });
  });
});

describe("LifecycleDriver", () => {
  it("polls the ESPN provider at the configured cadence", async () => {
    const { machine } = await createMachine();
    const time = new ManualDriverTime();
    const espnProvider: LifecycleObservationProvider = {
      fetchObservations: async () => [],
    };
    let calls = 0;
    const wrapped: LifecycleObservationProvider = {
      fetchObservations: async (now) => {
        calls += 1;
        return espnProvider.fetchObservations(now);
      },
    };

    const driver = new LifecycleDriver({
      machine,
      espnProvider: wrapped,
      espnPollingMs: 5_000,
      citoPollingMs: 15_000,
      clock: time,
      timer: time,
    });

    await driver.start();
    expect(calls).toBe(1);

    time.advance(4_999);
    await driver.idle();
    expect(calls).toBe(1);

    time.advance(1);
    await driver.idle();
    expect(calls).toBe(2);

    time.advance(5_000);
    await driver.idle();
    expect(calls).toBe(3);

    await driver.close();
  });

  it("uses the event-aware cadence when eventStartsAt is supplied and stops after completion", async () => {
    const { machine } = await createMachine();
    const time = new ManualDriverTime();
    let calls = 0;
    const driver = new LifecycleDriver({
      machine,
      espnProvider: {
        fetchObservations: async () => {
          calls += 1;
          return calls === 1
            ? [observationInput(time, { state: "post", completed: true, period: 1 })]
            : [];
        },
      },
      espnPollingMs: 5_000,
      eventStartsAt: "2026-07-27T22:00:00.000Z",
      clock: time,
      timer: time,
    });

    await driver.start();
    expect(calls).toBe(1);
    expect(time.pendingTimerCount()).toBe(0);
    time.advance(120_000);
    await driver.idle();
    expect(calls).toBe(1);
    await driver.close();
  });

  it("uses the one-minute event-day pre-start cadence when eventStartsAt is supplied", async () => {
    const { machine } = await createMachine();
    const time = new ManualDriverTime();
    let calls = 0;
    const driver = new LifecycleDriver({
      machine,
      espnProvider: { fetchObservations: async () => { calls += 1; return []; } },
      espnPollingMs: 5_000,
      eventStartsAt: "2026-07-27T22:00:00.000Z",
      clock: time,
      timer: time,
    });

    await driver.start();
    time.advance(59_999);
    await driver.idle();
    expect(calls).toBe(1);
    time.advance(1);
    await driver.idle();
    expect(calls).toBe(2);
    await driver.close();
  });

  it("feeds observations into the lifecycle machine and is idempotent on repeated polls", async () => {
    const { bus, machine } = await createMachine();
    const time = new ManualDriverTime();
    const responses: LifecycleObservationInput[][] = [
      [observationInput(time)],
      [observationInput(time)],
      [],
      [],
    ];
    let call = 0;
    const espnProvider: LifecycleObservationProvider = {
      fetchObservations: async () => {
        const result = responses[call] ?? [];
        call += 1;
        return result;
      },
    };

    const driver = new LifecycleDriver({
      machine,
      espnProvider,
      espnPollingMs: 5_000,
      citoPollingMs: 15_000,
      clock: time,
      timer: time,
    });

    // Poll 1: establishes the baseline for bout-main. The machine never
    // emits events for a bout's first-ever observation.
    await driver.start();
    expect(bus.getEventLog()).toEqual([]);

    // Poll 2: identical values reported again -- no lifecycle transition
    // occurred, so still no events.
    time.advance(5_000);
    await driver.idle();
    expect(bus.getEventLog()).toEqual([]);

    // Prime the next two responses to report the clock hitting 0:00 twice
    // in a row (simulating ESPN reporting the same "round just ended" state
    // on consecutive polls).
    responses[2] = [
      observationInput(time, { clockSeconds: 0, receivedAt: at(10) }),
    ];
    responses[3] = [
      observationInput(time, { clockSeconds: 0, receivedAt: at(15) }),
    ];

    time.advance(5_000);
    await driver.idle();
    expect(bus.getEventLog()).toEqual([
      {
        type: "PROVISIONAL_ROUND_ENDED",
        boutId: BOUT_ID,
        round: 1,
        detectedAt: at(10),
      },
    ]);

    // Poll 4: the clock-zero boundary is reported again -- the machine's
    // own dedupe means no duplicate PROVISIONAL_ROUND_ENDED is emitted.
    time.advance(5_000);
    await driver.idle();
    expect(bus.getEventLog()).toEqual([
      {
        type: "PROVISIONAL_ROUND_ENDED",
        boutId: BOUT_ID,
        round: 1,
        detectedAt: at(10),
      },
    ]);

    await driver.close();
  });

  it("publishes every successful observation batch as a fresh clock synchronization", async () => {
    const { machine } = await createMachine();
    const time = new ManualDriverTime();
    const batches: unknown[] = [];
    const espnProvider: LifecycleObservationProvider = {
      fetchObservations: async () => [
        observationInput(time, {
          clockSeconds: 197,
          receivedAt: new Date(time.now()).toISOString(),
        }),
      ],
    };
    const driver = new LifecycleDriver({
      machine,
      espnProvider,
      espnPollingMs: 5_000,
      citoPollingMs: 15_000,
      clock: time,
      timer: time,
      onObservations: (observations) => {
        batches.push(observations);
      },
    });

    await driver.start();
    time.advance(5_000);
    await driver.idle();

    expect(batches).toEqual([
      [
        expect.objectContaining({
          boutId: BOUT_ID,
          source: "espn",
          period: 1,
          clockSeconds: 197,
          receivedAt: at(0),
        }),
      ],
      [
        expect.objectContaining({
          boutId: BOUT_ID,
          source: "espn",
          period: 1,
          clockSeconds: 197,
          receivedAt: at(5),
        }),
      ],
    ]);

    await driver.close();
  });

  it("switches to the Cito fallback after consecutive ESPN failures and switches back on recovery", async () => {
    const { machine } = await createMachine();
    const time = new ManualDriverTime();
    let espnShouldFail = true;
    const espnCalls: number[] = [];
    const citoCalls: number[] = [];

    const espnProvider: LifecycleObservationProvider = {
      fetchObservations: async (now) => {
        espnCalls.push(now);
        if (espnShouldFail) throw new Error("espn unavailable");
        return [observationInput(time)];
      },
    };
    const citoProvider: LifecycleObservationProvider = {
      fetchObservations: async (now) => {
        citoCalls.push(now);
        return [observationInput(time, { clockSeconds: 200 })];
      },
    };

    const driver = new LifecycleDriver({
      machine,
      espnProvider,
      citoProvider,
      espnPollingMs: 5_000,
      citoPollingMs: 15_000,
      espnFailureThreshold: 3,
      clock: time,
      timer: time,
    });

    await driver.start(); // failure 1
    expect(driver.getActiveSource()).toBe("espn");
    expect(driver.getConsecutiveEspnFailures()).toBe(1);
    expect(citoCalls).toHaveLength(0);

    time.advance(5_000);
    await driver.idle(); // failure 2
    expect(driver.getConsecutiveEspnFailures()).toBe(2);
    expect(citoCalls).toHaveLength(0);

    time.advance(5_000);
    await driver.idle(); // failure 3 -> threshold reached, Cito engaged
    expect(driver.getConsecutiveEspnFailures()).toBe(3);
    expect(driver.getActiveSource()).toBe("cito");
    expect(citoCalls).toHaveLength(1);
    expect(espnCalls).toHaveLength(3);

    // Cadence is now citoPollingMs (15s); a 5s advance should not yet poll.
    time.advance(5_000);
    await driver.idle();
    expect(espnCalls).toHaveLength(3);
    expect(citoCalls).toHaveLength(1);

    time.advance(10_000);
    await driver.idle(); // still failing -> another Cito cycle
    expect(espnCalls).toHaveLength(4);
    expect(citoCalls).toHaveLength(2);
    expect(driver.getActiveSource()).toBe("cito");

    espnShouldFail = false;
    time.advance(15_000);
    await driver.idle(); // ESPN recovers
    expect(driver.getActiveSource()).toBe("espn");
    expect(driver.getConsecutiveEspnFailures()).toBe(0);
    expect(citoCalls).toHaveLength(2);

    // Cadence is back to espnPollingMs (5s).
    time.advance(5_000);
    await driver.idle();
    expect(espnCalls).toHaveLength(6);

    await driver.close();
  });

  it("defaults the ESPN failure threshold to 3", async () => {
    const { machine } = await createMachine();
    const time = new ManualDriverTime();
    const driver = new LifecycleDriver({
      machine,
      espnProvider: { fetchObservations: async () => [] },
      espnPollingMs: 5_000,
      citoPollingMs: 15_000,
      clock: time,
      timer: time,
    });

    expect(DEFAULT_ESPN_FAILURE_THRESHOLD).toBe(3);
    await driver.close();
  });

  it("rejects non-positive polling intervals and thresholds", async () => {
    const { machine } = await createMachine();
    const espnProvider: LifecycleObservationProvider = {
      fetchObservations: async () => [],
    };

    expect(
      () =>
        new LifecycleDriver({
          machine,
          espnProvider,
          espnPollingMs: 0,
          citoPollingMs: 15_000,
        }),
    ).toThrow(/espnPollingMs/);
    expect(
      () =>
        new LifecycleDriver({
          machine,
          espnProvider,
          espnPollingMs: 5_000,
          citoPollingMs: -1,
        }),
    ).toThrow(/citoPollingMs/);
    expect(
      () =>
        new LifecycleDriver({
          machine,
          espnProvider,
          espnPollingMs: 5_000,
          citoPollingMs: 15_000,
          espnFailureThreshold: 0,
        }),
    ).toThrow(/espnFailureThreshold/);
  });
});

describe("live lifecycle provider construction (fail-closed)", () => {
  it("createLiveEspnLifecycleProvider requires DATA_MODE=live", () => {
    expect(() =>
      createLiveEspnLifecycleProvider(
        { mode: "fixture" },
        "600051234",
        () => [],
      ),
    ).toThrow(/DATA_MODE=live/);

    expect(() =>
      createLiveEspnLifecycleProvider(
        { mode: "live" },
        "600051234",
        () => [],
      ),
    ).not.toThrow();
  });

  it("createLiveCitoLifecycleProvider requires DATA_MODE=live, CITO_API_KEY, and a base URL", () => {
    expect(() =>
      createLiveCitoLifecycleProvider(
        { mode: "fixture" },
        "ufc-fixture-night",
        () => [],
        { baseUrl: "https://cito.example.invalid" },
      ),
    ).toThrow(/DATA_MODE=live/);

    expect(() =>
      createLiveCitoLifecycleProvider(
        { mode: "live", credentials: {} },
        "ufc-fixture-night",
        () => [],
        { baseUrl: "https://cito.example.invalid" },
      ),
    ).toThrow(/CITO_API_KEY/);

    expect(() =>
      createLiveCitoLifecycleProvider(
        { mode: "live", credentials: { CITO_API_KEY: "secret" } },
        "ufc-fixture-night",
        () => [],
        { baseUrl: "" },
      ),
    ).toThrow(/base URL/);

    expect(() =>
      createLiveCitoLifecycleProvider(
        { mode: "live", credentials: { CITO_API_KEY: "secret" } },
        "ufc-fixture-night",
        () => [],
        { baseUrl: "https://cito.example.invalid" },
      ),
    ).not.toThrow();
  });
});
