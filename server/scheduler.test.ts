import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "./db/schema.ts";
import type { RunSyncResult } from "./syncUpcoming.ts";
import {
  mostRecentSlotAtOrBefore,
  nextSlotAfter,
  scheduleSlotsAround,
  UpcomingScheduler,
} from "./scheduler.ts";

const MIGRATIONS_FOLDER = new URL("./db/migrations", import.meta.url)
  .pathname;

function makeInMemoryDb() {
  const connection = new Database(":memory:");
  connection.pragma("foreign_keys = ON");
  const db = drizzle(connection, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

const okResult: RunSyncResult = {
  cards: 1,
  bouts: 3,
  loadedEntries: 3,
  path: "./data/upcoming.json",
};

describe("scheduleSlotsAround / nextSlotAfter / mostRecentSlotAtOrBefore", () => {
  it("produces 6a and 6p America/New_York slots, sorted ascending", () => {
    const now = new Date("2026-03-15T12:00:00.000Z");
    const slots = scheduleSlotsAround(now);
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i]!.getTime()).toBeGreaterThan(slots[i - 1]!.getTime());
    }
  });

  it("finds the next slot strictly after now and the most recent at-or-before now", () => {
    // 2026-03-15 is EDT (UTC-4): 6a ET = 10:00 UTC, 6p ET = 22:00 UTC.
    const now = new Date("2026-03-15T15:00:00.000Z");
    expect(mostRecentSlotAtOrBefore(now).toISOString()).toBe(
      "2026-03-15T10:00:00.000Z",
    );
    expect(nextSlotAfter(now).toISOString()).toBe("2026-03-15T22:00:00.000Z");
  });
});

describe("UpcomingScheduler", () => {
  let db: ReturnType<typeof makeInMemoryDb>;

  beforeEach(() => {
    db = makeInMemoryDb();
  });

  it("reports the most recent slot as missed when no run has succeeded", () => {
    const scheduler = new UpcomingScheduler({
      db,
      sync: vi.fn(),
      now: () => new Date("2026-03-15T15:00:00.000Z"),
      onLog: () => {},
    });

    const { missed, slot } = scheduler.missedMostRecentSlot();
    expect(missed).toBe(true);
    expect(slot.toISOString()).toBe("2026-03-15T10:00:00.000Z");
  });

  it("runs a catch-up sync on startup when the last slot was missed, and skips it once recorded", async () => {
    const sync = vi.fn().mockResolvedValue(okResult);
    const now = () => new Date("2026-03-15T15:00:00.000Z");
    const scheduler = new UpcomingScheduler({ db, sync, now, onLog: () => {} });

    const result = await scheduler.catchUpIfNeeded();
    expect(result).toEqual(okResult);
    expect(sync).toHaveBeenCalledTimes(1);

    const rows = db.select().from(schema.syncRuns).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "catchup", status: "success" });

    // Second startup at the same slot should see the recorded success and skip.
    const second = await scheduler.catchUpIfNeeded();
    expect(second).toBeNull();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("records a failed run with its error message instead of throwing silently", async () => {
    const sync = vi.fn().mockRejectedValue(new Error("provider unreachable"));
    const scheduler = new UpcomingScheduler({
      db,
      sync,
      now: () => new Date("2026-03-15T15:00:00.000Z"),
      onLog: () => {},
    });

    await expect(scheduler.runOnce("manual")).rejects.toThrow(
      "provider unreachable",
    );

    const rows = db.select().from(schema.syncRuns).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "failure",
      error: "provider unreachable",
    });
  });

  it("refuses to start a second run while one is already in flight", async () => {
    let releaseFirst!: () => void;
    const firstRunGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sync = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstRunGate;
        return okResult;
      })
      .mockResolvedValue(okResult);

    const scheduler = new UpcomingScheduler({
      db,
      sync,
      now: () => new Date("2026-03-15T15:00:00.000Z"),
      onLog: () => {},
    });

    const firstRun = scheduler.runOnce("manual");
    // Give the first run's insert a tick to land before we probe overlap.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const overlapping = await scheduler.runOnce("scheduled");
    expect(overlapping).toBeNull();
    expect(sync).toHaveBeenCalledTimes(1);

    releaseFirst();
    await firstRun;

    const rows = db.select().from(schema.syncRuns).all();
    expect(rows).toHaveLength(1);
  });

  it("treats a run stuck in 'running' past the staleness window as crashed, not in flight", async () => {
    const now = () => new Date("2026-03-15T15:00:00.000Z");
    db.insert(schema.syncRuns)
      .values({
        kind: "scheduled",
        status: "running",
        startedAt: new Date("2026-03-15T14:00:00.000Z").toISOString(), // 60 min ago
      })
      .run();

    const sync = vi.fn().mockResolvedValue(okResult);
    const scheduler = new UpcomingScheduler({ db, sync, now, onLog: () => {} });

    const result = await scheduler.runOnce("manual");
    expect(result).toEqual(okResult);
    expect(sync).toHaveBeenCalledTimes(1);
  });
});
