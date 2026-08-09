import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";

import * as schema from "./db/schema.ts";
import { ARCHIVE_DELAY_MS, EventArchiver } from "./eventArchiver.ts";

const MIGRATIONS_FOLDER = new URL("./db/migrations", import.meta.url).pathname;

function freshDb() {
  const connection = new Database(":memory:");
  const db = drizzle(connection, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

function seed(db: ReturnType<typeof freshDb>, boutStatuses: string[], updatedAt: string) {
  db.insert(schema.events).values({ id: "e1", name: "Event One" }).run();
  db.insert(schema.bouts)
    .values(boutStatuses.map((status, i) => ({ id: `b${i}`, eventId: "e1", status, updatedAt })))
    .run();
}

describe("EventArchiver", () => {
  it("archives an event whose bouts are all final and past the delay", async () => {
    const db = freshDb();
    const now = new Date("2026-02-01T00:00:00.000Z");
    seed(db, ["final", "final"], new Date(now.getTime() - ARCHIVE_DELAY_MS - 1000).toISOString());
    db.update(schema.bouts).set({ resultWinnerCorner: "red" }).run();

    const archiver = new EventArchiver({ db, now: () => now });
    const result = await archiver.sweepOnce();

    expect(result.archived).toEqual(["e1"]);
    expect(db.select().from(schema.events).get()?.archivedAt).not.toBeNull();
  });

  it("does not archive an event still within the 24h delay", async () => {
    const db = freshDb();
    const now = new Date("2026-02-01T00:00:00.000Z");
    seed(db, ["final"], new Date(now.getTime() - 1000).toISOString());
    db.update(schema.bouts).set({ resultWinnerCorner: "red" }).run();

    const archiver = new EventArchiver({ db, now: () => now });
    const result = await archiver.sweepOnce();

    expect(result.archived).toEqual([]);
    expect(db.select().from(schema.events).get()?.archivedAt).toBeNull();
  });

  it("immediately archives a completed superseded card but never the current card", async () => {
    const db = freshDb();
    const now = new Date("2026-02-01T00:00:00.000Z");
    seed(db, ["final"], new Date(now.getTime() - 1000).toISOString());
    db.update(schema.bouts).set({ resultWinnerCorner: "red" }).run();
    db.insert(schema.events).values({ id: "current", name: "Current" }).run();
    db.insert(schema.bouts).values({ id: "current-bout", eventId: "current", status: "final", resultWinnerCorner: "red", updatedAt: now.toISOString() }).run();

    const result = await new EventArchiver({ db, now: () => now })
      .sweepOnce({ immediate: true, excludeEventId: "current" });

    expect(result.archived).toEqual(["e1"]);
    expect(db.select().from(schema.events).all().find((event) => event.id === "current")?.archivedAt).toBeNull();
  });

  it("does not archive an event with any non-final bout", async () => {
    const db = freshDb();
    const now = new Date("2026-02-01T00:00:00.000Z");
    seed(db, ["final", "upcoming"], new Date(now.getTime() - ARCHIVE_DELAY_MS - 1000).toISOString());

    const archiver = new EventArchiver({ db, now: () => now });
    const result = await archiver.sweepOnce();

    expect(result.archived).toEqual([]);
  });

  it("does not freeze a final bout before ESPN has supplied its result", async () => {
    const db = freshDb();
    const now = new Date("2026-02-01T00:00:00.000Z");
    seed(db, ["final"], new Date(now.getTime() - ARCHIVE_DELAY_MS - 1000).toISOString());

    const result = await new EventArchiver({ db, now: () => now })
      .sweepOnce({ immediate: true });

    expect(result.archived).toEqual([]);
    expect(db.select().from(schema.events).get()?.archivedAt).toBeNull();
  });

  it("keeps a stale-status card writable until ESPN results are persisted", async () => {
    const db = freshDb();
    const now = new Date("2026-02-01T00:00:00.000Z");
    db.insert(schema.events).values([
      { id: "old", name: "Old", startTime: "2026-01-25T00:00:00.000Z" },
      { id: "future", name: "Future", startTime: "2026-02-08T00:00:00.000Z" },
    ]).run();
    db.insert(schema.bouts).values([
      { id: "old-stale", eventId: "old", status: "upcoming", updatedAt: now.toISOString() },
      { id: "future-bout", eventId: "future", status: "upcoming", updatedAt: now.toISOString() },
    ]).run();
    const result = await new EventArchiver({ db, now: () => now }).sweepOnce({
      excludeEventId: "current", supersededBefore: "2026-02-01T12:00:00.000Z", immediate: true,
    });
    expect(result.archived).toEqual([]);
    expect(db.select().from(schema.events).all().find((event) => event.id === "old")?.archivedAt).toBeNull();
    expect(db.select().from(schema.events).all().find((event) => event.id === "future")?.archivedAt).toBeNull();
  });

  it("keeps a superseded final card writable when ESPN has not supplied every result", async () => {
    const db = freshDb();
    const now = new Date("2026-02-01T00:00:00.000Z");
    db.insert(schema.events).values({
      id: "old", name: "Old", startTime: "2026-01-25T00:00:00.000Z",
    }).run();
    db.insert(schema.bouts).values([
      {
        id: "settled", eventId: "old", status: "final",
        resultWinnerCorner: "red", updatedAt: now.toISOString(),
      },
      {
        id: "missing", eventId: "old", status: "final",
        updatedAt: now.toISOString(),
      },
    ]).run();

    const result = await new EventArchiver({ db, now: () => now }).sweepOnce({
      supersededBefore: "2026-02-01T12:00:00.000Z", immediate: true,
    });

    expect(result.archived).toEqual([]);
    expect(db.select().from(schema.events).get()?.archivedAt).toBeNull();
  });

  it("archives a superseded stale-status card once every bout has a durable result", async () => {
    const db = freshDb();
    const now = new Date("2026-02-01T00:00:00.000Z");
    db.insert(schema.events).values({ id: "old", name: "Old", startTime: "2026-01-25T00:00:00.000Z" }).run();
    db.insert(schema.bouts).values({
      id: "old-stale", eventId: "old", status: "upcoming", resultWinnerCorner: "blue", updatedAt: now.toISOString(),
    }).run();

    const result = await new EventArchiver({ db, now: () => now }).sweepOnce({
      supersededBefore: "2026-02-01T12:00:00.000Z", immediate: true,
    });

    expect(result.archived).toEqual(["old"]);
  });

  it("is idempotent — a second sweep does nothing to an already-archived event", async () => {
    const db = freshDb();
    const now = new Date("2026-02-01T00:00:00.000Z");
    seed(db, ["final"], new Date(now.getTime() - ARCHIVE_DELAY_MS - 1000).toISOString());
    db.update(schema.bouts).set({ resultWinnerCorner: "red" }).run();

    const archiver = new EventArchiver({ db, now: () => now });
    await archiver.sweepOnce();
    const firstArchivedAt = db.select().from(schema.events).get()?.archivedAt;

    await archiver.sweepOnce();
    expect(db.select().from(schema.events).get()?.archivedAt).toBe(firstArchivedAt);
  });
});
