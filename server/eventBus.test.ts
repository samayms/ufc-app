import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  CollectorEventBus,
  type CollectorEvent,
} from "./eventBus.ts";

describe("CollectorEventBus", () => {
  it("emits only to subscribers of the matching typed event", () => {
    const bus = new CollectorEventBus();
    const roundListener = vi.fn();
    const fightListener = vi.fn();

    bus.subscribe("ROUND_ENDED", (event) => {
      expectTypeOf(event).toEqualTypeOf<
        Extract<CollectorEvent, { type: "ROUND_ENDED" }>
      >();
      roundListener(event);
    });
    bus.subscribe("FIGHT_ENDED", fightListener);

    const event: CollectorEvent = {
      type: "ROUND_ENDED",
      boutId: "bout-main",
      round: 2,
      detectedAt: "2026-07-28T01:02:03Z",
      confirmation: "period_transition",
    };
    bus.emit(event);

    expect(roundListener).toHaveBeenCalledOnce();
    expect(roundListener).toHaveBeenCalledWith(event);
    expect(fightListener).not.toHaveBeenCalled();
    expect(bus.getEventLog()).toEqual([event]);
  });

  it("supports explicit and returned unsubscribe functions", () => {
    const bus = new CollectorEventBus();
    const explicitListener = vi.fn();
    const returnedListener = vi.fn();

    bus.subscribe("FIGHT_STARTED", explicitListener);
    const unsubscribe = bus.subscribe("FIGHT_STARTED", returnedListener);
    bus.unsubscribe("FIGHT_STARTED", explicitListener);
    unsubscribe();

    bus.emit({
      type: "FIGHT_STARTED",
      boutId: "bout-main",
      detectedAt: "2026-07-28T01:02:03Z",
    });

    expect(explicitListener).not.toHaveBeenCalled();
    expect(returnedListener).not.toHaveBeenCalled();
    expect(bus.getEventLog()).toHaveLength(1);
  });

  it("returns a defensive event-log snapshot", () => {
    const bus = new CollectorEventBus();
    const event: CollectorEvent = {
      type: "PROVISIONAL_ROUND_ENDED",
      boutId: "bout-main",
      round: 1,
      detectedAt: "2026-07-28T01:02:03Z",
    };

    bus.emit(event);
    const snapshot = bus.getEventLog() as CollectorEvent[];
    snapshot.length = 0;

    expect(bus.getEventLog()).toEqual([event]);
  });
});
