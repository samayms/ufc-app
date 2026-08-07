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

    const archiver = new EventArchiver({ db, now: () => now });
    const result = await archiver.sweepOnce();

    expect(result.archived).toEqual(["e1"]);
    expect(db.select().from(schema.events).get()?.archivedAt).not.toBeNull();
  });

  it("does not archive an event still within the 24h delay", async () => {
    const db = freshDb();
    const now = new Date("2026-02-01T00:00:00.000Z");
    seed(db, ["final"], new Date(now.getTime() - 1000).toISOString());

    const archiver = new EventArchiver({ db, now: () => now });
    const result = await archiver.sweepOnce();

    expect(result.archived).toEqual([]);
    expect(db.select().from(schema.events).get()?.archivedAt).toBeNull();
  });

  it("does not archive an event with any non-final bout", async () => {
    const db = freshDb();
    const now = new Date("2026-02-01T00:00:00.000Z");
    seed(db, ["final", "upcoming"], new Date(now.getTime() - ARCHIVE_DELAY_MS - 1000).toISOString());

    const archiver = new EventArchiver({ db, now: () => now });
    const result = await archiver.sweepOnce();

    expect(result.archived).toEqual([]);
  });

  it("is idempotent — a second sweep does nothing to an already-archived event", async () => {
    const db = freshDb();
    const now = new Date("2026-02-01T00:00:00.000Z");
    seed(db, ["final"], new Date(now.getTime() - ARCHIVE_DELAY_MS - 1000).toISOString());

    const archiver = new EventArchiver({ db, now: () => now });
    await archiver.sweepOnce();
    const firstArchivedAt = db.select().from(schema.events).get()?.archivedAt;

    await archiver.sweepOnce();
    expect(db.select().from(schema.events).get()?.archivedAt).toBe(firstArchivedAt);
  });
});
