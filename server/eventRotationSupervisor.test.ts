import { describe, expect, it, vi } from "vitest";

import {
  EventRotationSupervisor,
  type EventRotationClock,
  type EventRotationTimer,
} from "./eventRotationSupervisor.ts";
import { MemoryStorage } from "./storage.ts";

class ManualTime implements EventRotationClock, EventRotationTimer {
  value = Date.parse("2026-08-01T00:00:00.000Z");
  private nextId = 1;
  private readonly timers = new Map<number, { callback: () => void; due: number }>();

  now(): number { return this.value; }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { callback, due: this.value + delayMs });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  advance(ms: number): void {
    this.value += ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= this.value)
        .sort(([, left], [, right]) => left.due - right.due)[0];
      if (next === undefined) return;
      this.timers.delete(next[0]);
      next[1].callback();
    }
  }
}

describe("EventRotationSupervisor", () => {
  it("rotates on the initial id and once more only when the id changes", async () => {
    const time = new ManualTime();
    const storage = new MemoryStorage();
    let id: string | undefined = "event-a";
    const rotate = vi.fn(async () => undefined);
    const supervisor = new EventRotationSupervisor({
      storage, resolveEventId: async () => id, rotate, intervalMs: 1_000,
      clock: time, timer: time,
    });

    await supervisor.start();
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(rotate).toHaveBeenLastCalledWith("event-a");
    expect(supervisor.getCurrentEventId()).toBe("event-a");

    time.advance(1_000);
    await supervisor.idle();
    expect(rotate).toHaveBeenCalledTimes(1);

    id = "event-b";
    time.advance(1_000);
    await supervisor.idle();
    expect(rotate).toHaveBeenCalledTimes(2);
    expect(rotate).toHaveBeenLastCalledWith("event-b");
    expect((await storage.read("event-rotation-supervisor"))).toEqual([
      expect.objectContaining({ version: 1, eventId: "event-b" }),
    ]);
    await supervisor.close();
  });

  it("restores the last rotated id and does not rotate it again after restart", async () => {
    const time = new ManualTime();
    const storage = new MemoryStorage();
    await storage.replace("event-rotation-supervisor", [{
      version: 1, eventId: "event-a", rotatedAt: new Date(time.now()).toISOString(),
    }]);
    const rotate = vi.fn(async () => undefined);
    const supervisor = new EventRotationSupervisor({
      storage, resolveEventId: async () => "event-a", rotate, intervalMs: 1_000,
      clock: time, timer: time,
    });

    await supervisor.start();
    expect(rotate).not.toHaveBeenCalled();
    await supervisor.close();
  });

  it("keeps polling after a resolver or rotation failure and stops when closed", async () => {
    const time = new ManualTime();
    const storage = new MemoryStorage();
    const onError = vi.fn();
    let attempts = 0;
    const supervisor = new EventRotationSupervisor({
      storage,
      resolveEventId: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary ESPN failure");
        return "event-a";
      },
      rotate: async () => undefined,
      intervalMs: 1_000, clock: time, timer: time, onError,
    });

    await supervisor.start();
    expect(onError).toHaveBeenCalledTimes(1);
    time.advance(1_000);
    await supervisor.idle();
    expect(supervisor.getCurrentEventId()).toBe("event-a");
    await supervisor.close();
    time.advance(10_000);
    await supervisor.idle();
    expect(attempts).toBe(2);
  });
});
