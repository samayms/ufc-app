import { describe, expect, it, vi } from "vitest";
import type { RoundJobClock, RoundJobTimer } from "./roundJobs.ts";
import {
  SHERDOG_LIVE_BLOG_CHECKPOINT_OFFSETS_MS,
  SherdogLiveBlogWatcher,
  msUntilNextSherdogLiveBlogCheckpoint,
  nextUnattemptedSherdogLiveBlogCheckpoint,
  sherdogLiveBlogCheckpoints,
} from "./sherdogLiveBlogSchedule.ts";
import type { SherdogNewsItem } from "./sherdogDiscovery.ts";

const startsAt = "2026-08-01T17:00:00.000Z";

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
    this.timers.set(id, { callback, dueAt: this.value + delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  pendingCount(): number {
    return this.timers.size;
  }

  async advance(milliseconds: number): Promise<void> {
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
      // Let any pending microtasks (the async runCheckpoint) settle before
      // checking for newly-armed timers.
      await Promise.resolve();
      await Promise.resolve();
    }
  }
}

const target = {
  eventName: "UFC Belgrade",
  redFighter: "Uros Medic",
  blueFighter: "Daniel Rodriguez",
};

const match: SherdogNewsItem = {
  title: "UFC Belgrade play-by-play",
  url: "https://www.sherdog.com/news/news/UFC-Belgrade-playbyplay-202100",
};

describe("sherdogLiveBlogCheckpoints", () => {
  it("returns the 4 fixed checkpoints: T-2h, T-1h, T-30m, T-0", () => {
    expect(SHERDOG_LIVE_BLOG_CHECKPOINT_OFFSETS_MS).toEqual([
      -2 * 60 * 60 * 1000,
      -1 * 60 * 60 * 1000,
      -30 * 60 * 1000,
      0,
    ]);
    expect(
      sherdogLiveBlogCheckpoints(startsAt).map((date) => date.toISOString()),
    ).toEqual([
      "2026-08-01T15:00:00.000Z",
      "2026-08-01T16:00:00.000Z",
      "2026-08-01T16:30:00.000Z",
      "2026-08-01T17:00:00.000Z",
    ]);
  });
});

describe("nextUnattemptedSherdogLiveBlogCheckpoint", () => {
  it("returns each checkpoint in order as attempts accumulate", () => {
    expect(
      nextUnattemptedSherdogLiveBlogCheckpoint(startsAt, 0)?.toISOString(),
    ).toBe("2026-08-01T15:00:00.000Z");
    expect(
      nextUnattemptedSherdogLiveBlogCheckpoint(startsAt, 3)?.toISOString(),
    ).toBe("2026-08-01T17:00:00.000Z");
  });

  it("returns undefined once all 4 checkpoints have been attempted", () => {
    expect(nextUnattemptedSherdogLiveBlogCheckpoint(startsAt, 4)).toBeUndefined();
  });
});

describe("msUntilNextSherdogLiveBlogCheckpoint", () => {
  it("computes ms until the next unattempted checkpoint", () => {
    expect(
      msUntilNextSherdogLiveBlogCheckpoint(
        new Date("2026-08-01T14:00:00.000Z"),
        startsAt,
        0,
      ),
    ).toBe(60 * 60 * 1000);
  });

  it("clamps to 0 when the checkpoint is already due or past", () => {
    expect(
      msUntilNextSherdogLiveBlogCheckpoint(
        new Date("2026-08-01T15:30:00.000Z"),
        startsAt,
        0,
      ),
    ).toBe(0);
  });

  it("returns undefined once every checkpoint has been attempted", () => {
    expect(
      msUntilNextSherdogLiveBlogCheckpoint(
        new Date("2026-08-01T18:00:00.000Z"),
        startsAt,
        4,
      ),
    ).toBeUndefined();
  });
});

describe("SherdogLiveBlogWatcher", () => {
  it("arms the first checkpoint at T-2h", () => {
    const time = new ManualTime(Date.parse("2026-08-01T10:00:00.000Z"));
    const discover = vi.fn(async () => undefined);
    const onFound = vi.fn();
    const watcher = new SherdogLiveBlogWatcher({
      target,
      startsAt,
      discoverOptions: { permissionScope: "sherdog-read" },
      discover,
      onFound,
      clock: time,
      timer: time,
    });

    watcher.start();
    expect(time.pendingCount()).toBe(1);
    expect(discover).not.toHaveBeenCalled();
  });

  it("retries at T-1h, T-30m, and T-0, then stops after the final miss", async () => {
    const time = new ManualTime(Date.parse("2026-08-01T10:00:00.000Z"));
    const discover = vi.fn(async () => undefined);
    const onFound = vi.fn();
    const onExhausted = vi.fn();
    const watcher = new SherdogLiveBlogWatcher({
      target,
      startsAt,
      discoverOptions: { permissionScope: "sherdog-read" },
      discover,
      onFound,
      onExhausted,
      clock: time,
      timer: time,
    });

    watcher.start();
    await time.advance(Date.parse(startsAt) - time.now()); // fast-forward through all 4 checkpoints
    // one more tick so the (already-armed-with-0-delay) final checkpoint runs
    await time.advance(0);

    expect(discover).toHaveBeenCalledTimes(4);
    expect(onFound).not.toHaveBeenCalled();
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(watcher.isFound()).toBe(false);
    expect(time.pendingCount()).toBe(0);
  });

  it("stops retrying once the link is found, without scheduling further checkpoints", async () => {
    const time = new ManualTime(Date.parse("2026-08-01T10:00:00.000Z"));
    const discover = vi
      .fn<
        (...args: unknown[]) => Promise<SherdogNewsItem | undefined>
      >()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(match);
    const onFound = vi.fn();
    const watcher = new SherdogLiveBlogWatcher({
      target,
      startsAt,
      discoverOptions: { permissionScope: "sherdog-read" },
      discover,
      onFound,
      clock: time,
      timer: time,
    });

    watcher.start();
    // Clock starts at 10:00Z; T-2h checkpoint is due at 15:00Z (5h away).
    await time.advance(5 * 60 * 60 * 1000); // T-2h checkpoint: miss
    await time.advance(60 * 60 * 1000); // T-1h checkpoint: hit

    expect(discover).toHaveBeenCalledTimes(2);
    expect(onFound).toHaveBeenCalledExactlyOnceWith(match);
    expect(watcher.isFound()).toBe(true);
    expect(time.pendingCount()).toBe(0); // no T-30m/T-0 checkpoints armed

    // Advancing further must not trigger any more discovery attempts.
    await time.advance(2 * 60 * 60 * 1000);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("treats a discovery error as a miss and still retries at the next checkpoint", async () => {
    const time = new ManualTime(Date.parse("2026-08-01T10:00:00.000Z"));
    const discover = vi
      .fn<
        (...args: unknown[]) => Promise<SherdogNewsItem | undefined>
      >()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce(match);
    const onFound = vi.fn();
    const onCheckpointFailed = vi.fn();
    const watcher = new SherdogLiveBlogWatcher({
      target,
      startsAt,
      discoverOptions: { permissionScope: "sherdog-read" },
      discover,
      onFound,
      onCheckpointFailed,
      clock: time,
      timer: time,
    });

    watcher.start();
    // Clock starts at 10:00Z; T-2h checkpoint is due at 15:00Z (5h away).
    await time.advance(5 * 60 * 60 * 1000);
    expect(onCheckpointFailed).toHaveBeenCalledTimes(1);
    expect(onFound).not.toHaveBeenCalled();

    await time.advance(60 * 60 * 1000);
    expect(onFound).toHaveBeenCalledExactlyOnceWith(match);
  });

  it("stop() cancels a pending checkpoint and prevents any further attempts", async () => {
    const time = new ManualTime(Date.parse("2026-08-01T10:00:00.000Z"));
    const discover = vi.fn(async () => undefined);
    const onFound = vi.fn();
    const watcher = new SherdogLiveBlogWatcher({
      target,
      startsAt,
      discoverOptions: { permissionScope: "sherdog-read" },
      discover,
      onFound,
      clock: time,
      timer: time,
    });

    watcher.start();
    watcher.stop();
    await time.advance(24 * 60 * 60 * 1000);

    expect(discover).not.toHaveBeenCalled();
    expect(time.pendingCount()).toBe(0);
  });

  it("starting after some checkpoints have already elapsed replays them immediately, in order", async () => {
    // Process started at T-45m: the T-2h and T-1h checkpoints are already in
    // the past, so they fire back-to-back with 0 delay instead of being
    // skipped — the watcher still attempts every checkpoint up to the one
    // that is actually due.
    const time = new ManualTime(Date.parse("2026-08-01T16:15:00.000Z"));
    const discover = vi.fn(async () => undefined);
    const watcher = new SherdogLiveBlogWatcher({
      target,
      startsAt,
      discoverOptions: { permissionScope: "sherdog-read" },
      discover,
      onFound: vi.fn(),
      clock: time,
      timer: time,
    });

    watcher.start();
    expect(time.pendingCount()).toBe(1); // T-2h armed with delay clamped to 0

    await time.advance(0);
    expect(discover).toHaveBeenCalledTimes(2); // T-2h and T-1h both overdue
    expect(time.pendingCount()).toBe(1); // T-30m is the next one actually due

    await time.advance(15 * 60 * 1000); // reach T-30m
    expect(discover).toHaveBeenCalledTimes(3);
  });
});
