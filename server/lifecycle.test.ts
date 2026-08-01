import { describe, expect, it, vi } from "vitest";
import { CollectorEventBus, type CollectorEvent } from "./eventBus.ts";
import {
  FightLifecycleMachine,
  type FightLifecycleObservation,
  type FightLifecycleMachineOptions,
} from "./lifecycle.ts";
import { MemoryStorage, type Storage } from "./storage.ts";

const BOUT_ID = "bout-main";
const BASE_TIME = Date.parse("2026-07-28T00:00:00.000Z");

function at(seconds: number): string {
  return new Date(BASE_TIME + seconds * 1_000).toISOString();
}

function observation(
  seconds: number,
  values: Partial<FightLifecycleObservation> = {},
): FightLifecycleObservation {
  return {
    boutId: BOUT_ID,
    source: "espn",
    state: "in",
    period: 1,
    completed: false,
    // ESPN's clock counts down from five minutes; zero ends a round.
    clockSeconds: 120,
    sourceUpdatedAt: at(seconds),
    receivedAt: at(seconds),
    ...values,
  };
}

async function createMachine(
  options: Partial<FightLifecycleMachineOptions> = {},
): Promise<{
  bus: CollectorEventBus;
  storage: Storage;
  machine: FightLifecycleMachine;
}> {
  const bus = new CollectorEventBus();
  const storage = options.storage ?? new MemoryStorage();
  const machine = await FightLifecycleMachine.create({
    eventBus: bus,
    storage,
    ...options,
  });

  return { bus, storage, machine };
}

function eventsOfType<Type extends CollectorEvent["type"]>(
  events: readonly CollectorEvent[],
  type: Type,
): Extract<CollectorEvent, { type: Type }>[] {
  return events.filter(
    (event): event is Extract<CollectorEvent, { type: Type }> =>
      event.type === type,
  );
}

describe("FightLifecycleMachine", () => {
  it("runs a normal three-round fight through every round boundary", async () => {
    const { bus, machine } = await createMachine();

    await machine.observe(
      observation(0, { state: "pre", clockSeconds: undefined }),
    );
    await machine.observe(observation(1));
    await machine.observe(observation(2, { clockSeconds: 0 }));
    await machine.observe(
      observation(3, { period: 2, clockSeconds: 300 }),
    );
    await machine.observe(observation(4, { period: 2, clockSeconds: 0 }));
    await machine.observe(
      observation(5, { period: 3, clockSeconds: 300 }),
    );
    await machine.observe(observation(6, { period: 3, clockSeconds: 0 }));
    await machine.observe(
      observation(7, {
        state: "post",
        period: 3,
        clockSeconds: 0,
        completed: true,
      }),
    );

    expect(bus.getEventLog()).toEqual([
      {
        type: "FIGHT_STARTED",
        boutId: BOUT_ID,
        detectedAt: at(1),
      },
      {
        type: "PROVISIONAL_ROUND_ENDED",
        boutId: BOUT_ID,
        round: 1,
        detectedAt: at(2),
      },
      {
        type: "ROUND_ENDED",
        boutId: BOUT_ID,
        round: 1,
        detectedAt: at(3),
        confirmation: "period_transition",
      },
      {
        type: "PROVISIONAL_ROUND_ENDED",
        boutId: BOUT_ID,
        round: 2,
        detectedAt: at(4),
      },
      {
        type: "ROUND_ENDED",
        boutId: BOUT_ID,
        round: 2,
        detectedAt: at(5),
        confirmation: "period_transition",
      },
      {
        type: "PROVISIONAL_ROUND_ENDED",
        boutId: BOUT_ID,
        round: 3,
        detectedAt: at(6),
      },
      {
        type: "ROUND_ENDED",
        boutId: BOUT_ID,
        round: 3,
        detectedAt: at(7),
        confirmation: "fight_completed",
      },
      {
        type: "FIGHT_ENDED",
        boutId: BOUT_ID,
        round: 3,
        detectedAt: at(7),
      },
    ]);
    expect(machine.getState(BOUT_ID)).toEqual({
      boutId: BOUT_ID,
      state: "post",
      period: 3,
      completed: true,
      clockSeconds: 0,
      sourceUpdatedAt: at(7),
      receivedAt: at(7),
    });
  });

  it("confirms the fifth round of a decision when the fight completes", async () => {
    const { bus, machine } = await createMachine();

    await machine.observe(
      observation(0, { state: "pre", clockSeconds: undefined }),
    );
    await machine.observe(observation(1));

    let seconds = 2;
    for (let round = 1; round <= 5; round += 1) {
      await machine.observe(
        observation(seconds, { period: round, clockSeconds: 0 }),
      );
      seconds += 1;

      if (round < 5) {
        await machine.observe(
          observation(seconds, {
            period: round + 1,
            clockSeconds: 300,
          }),
        );
        seconds += 1;
      }
    }

    await machine.observe(
      observation(seconds, {
        state: "post",
        period: 5,
        clockSeconds: 0,
        completed: true,
      }),
    );

    const confirmed = eventsOfType(bus.getEventLog(), "ROUND_ENDED");
    expect(confirmed.map(({ round }) => round)).toEqual([1, 2, 3, 4, 5]);
    expect(confirmed.slice(0, 4).every(
      ({ confirmation }) => confirmation === "period_transition",
    )).toBe(true);
    expect(confirmed[4]).toMatchObject({
      round: 5,
      confirmation: "fight_completed",
    });
    expect(eventsOfType(bus.getEventLog(), "FIGHT_ENDED")).toHaveLength(1);
  });

  it("confirms the current round before ending an early stoppage", async () => {
    const { bus, machine } = await createMachine();

    await machine.observe(
      observation(0, { state: "pre", clockSeconds: undefined }),
    );
    await machine.observe(observation(1));
    await machine.observe(
      observation(2, {
        state: "post",
        clockSeconds: 143,
        completed: true,
      }),
    );

    expect(bus.getEventLog()).toEqual([
      {
        type: "FIGHT_STARTED",
        boutId: BOUT_ID,
        detectedAt: at(1),
      },
      {
        type: "ROUND_ENDED",
        boutId: BOUT_ID,
        round: 1,
        detectedAt: at(2),
        confirmation: "fight_completed",
      },
      {
        type: "FIGHT_ENDED",
        boutId: BOUT_ID,
        round: 1,
        detectedAt: at(2),
      },
    ]);
  });

  it("supersedes a zero-clock boundary when the clock resumes and can re-emit it", async () => {
    const onProvisionalSuperseded = vi.fn();
    const { bus, machine } = await createMachine({
      onProvisionalSuperseded,
    });
    const firstZero = observation(2, {
      clockSeconds: 0,
      sourceUpdatedAt: at(1),
    });

    await machine.observe(
      observation(0, { state: "pre", clockSeconds: undefined }),
    );
    await machine.observe(observation(1));
    await machine.observe(firstZero);
    await machine.observe(
      observation(3, { clockSeconds: 1, sourceUpdatedAt: at(1) }),
    );
    await machine.observe(firstZero);
    await machine.observe(
      observation(4, { clockSeconds: 0, sourceUpdatedAt: at(1) }),
    );

    expect(
      eventsOfType(bus.getEventLog(), "PROVISIONAL_ROUND_ENDED"),
    ).toEqual([
      {
        type: "PROVISIONAL_ROUND_ENDED",
        boutId: BOUT_ID,
        round: 1,
        detectedAt: at(2),
      },
      {
        type: "PROVISIONAL_ROUND_ENDED",
        boutId: BOUT_ID,
        round: 1,
        detectedAt: at(4),
      },
    ]);

    const supersession = {
      boutId: BOUT_ID,
      round: 1,
      provisionalDetectedAt: at(2),
      supersededAt: at(3),
      source: "espn",
    };
    expect(onProvisionalSuperseded).toHaveBeenCalledOnce();
    expect(onProvisionalSuperseded).toHaveBeenCalledWith(supersession);
    expect(machine.getSupersessionLog(BOUT_ID)).toEqual([supersession]);
  });

  it("does not duplicate events for duplicate or replayed observations", async () => {
    const { bus, machine } = await createMachine();
    const pre = observation(0, { state: "pre", clockSeconds: undefined });
    const active = observation(1);
    const zero = observation(2, { clockSeconds: 0 });
    const completed = observation(3, {
      state: "post",
      clockSeconds: 0,
      completed: true,
    });

    for (const current of [
      pre,
      pre,
      active,
      active,
      zero,
      zero,
      completed,
      completed,
      active,
      zero,
    ]) {
      await machine.observe(current);
    }

    expect(eventsOfType(bus.getEventLog(), "FIGHT_STARTED")).toHaveLength(1);
    expect(
      eventsOfType(bus.getEventLog(), "PROVISIONAL_ROUND_ENDED"),
    ).toHaveLength(1);
    expect(eventsOfType(bus.getEventLog(), "ROUND_ENDED")).toHaveLength(1);
    expect(eventsOfType(bus.getEventLog(), "FIGHT_ENDED")).toHaveLength(1);
  });

  it("restores mid-fight state without re-emitting past events", async () => {
    const storage = new MemoryStorage();
    const first = await createMachine({ storage });

    await first.machine.observe(
      observation(0, { state: "pre", clockSeconds: undefined }),
    );
    await first.machine.observe(observation(1));
    await first.machine.observe(observation(2, { clockSeconds: 0 }));
    const roundTwo = observation(3, { period: 2, clockSeconds: 300 });
    await first.machine.observe(roundTwo);

    const restored = await createMachine({ storage });
    expect(restored.machine.getState(BOUT_ID)).toEqual({
      boutId: BOUT_ID,
      state: "in",
      period: 2,
      completed: false,
      clockSeconds: 300,
      sourceUpdatedAt: at(3),
      receivedAt: at(3),
    });
    expect(() =>
      JSON.parse(JSON.stringify(restored.machine.getState(BOUT_ID))),
    ).not.toThrow();

    await restored.machine.observe(roundTwo);
    await restored.machine.observe(
      observation(4, { period: 2, clockSeconds: 0 }),
    );
    await restored.machine.observe(
      observation(5, { period: 3, clockSeconds: 300 }),
    );

    expect(restored.bus.getEventLog()).toEqual([
      {
        type: "PROVISIONAL_ROUND_ENDED",
        boutId: BOUT_ID,
        round: 2,
        detectedAt: at(4),
      },
      {
        type: "ROUND_ENDED",
        boutId: BOUT_ID,
        round: 2,
        detectedAt: at(5),
        confirmation: "period_transition",
      },
    ]);
  });

  it("does nothing while the countdown remains above zero", async () => {
    const { bus, machine } = await createMachine();

    await machine.observe(
      observation(0, { state: "pre", clockSeconds: undefined }),
    );
    await machine.observe(observation(1, { clockSeconds: 17 }));
    await machine.observe(observation(2, { clockSeconds: 17 }));
    await machine.observe(observation(3, { clockSeconds: 18 }));

    expect(bus.getEventLog()).toEqual([
      {
        type: "FIGHT_STARTED",
        boutId: BOUT_ID,
        detectedAt: at(1),
      },
    ]);
  });

  it("uses Cito only after ESPN is stale and returns authority to ESPN", async () => {
    const { bus, machine } = await createMachine({ espnFreshnessMs: 10_000 });

    await machine.observe(
      observation(0, { state: "pre", clockSeconds: undefined }),
    );
    await machine.observe(
      observation(5, {
        source: "cito",
        state: "in",
        clockSeconds: 290,
      }),
    );

    expect(machine.getState(BOUT_ID)?.state).toBe("pre");
    expect(machine.getActiveSource(BOUT_ID)).toBe("espn");

    await machine.observe(
      observation(11, {
        source: "cito",
        state: "in",
        clockSeconds: 284,
      }),
    );
    expect(machine.getActiveSource(BOUT_ID)).toBe("cito");

    await machine.observe(observation(12, { clockSeconds: 283 }));
    expect(machine.getActiveSource(BOUT_ID)).toBe("espn");

    await machine.observe(
      observation(20, {
        source: "cito",
        clockSeconds: 0,
      }),
    );
    await machine.observe(
      observation(23, {
        source: "cito",
        clockSeconds: 0,
      }),
    );

    expect(bus.getEventLog()).toEqual([
      {
        type: "FIGHT_STARTED",
        boutId: BOUT_ID,
        detectedAt: at(11),
      },
      {
        type: "PROVISIONAL_ROUND_ENDED",
        boutId: BOUT_ID,
        round: 1,
        detectedAt: at(23),
      },
    ]);
    expect(machine.getActiveSource(BOUT_ID)).toBe("cito");
  });
});
