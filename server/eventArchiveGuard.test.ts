// server/eventArchiveGuard.test.ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";

import * as schema from "./db/schema.ts";
import { assertEventNotArchived, EventArchivedError } from "./eventArchiveGuard.ts";

const MIGRATIONS_FOLDER = new URL("./db/migrations", import.meta.url).pathname;

function freshDb() {
  const connection = new Database(":memory:");
  const db = drizzle(connection, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

describe("assertEventNotArchived", () => {
  it("resolves when the event has no archivedAt", async () => {
    const db = freshDb();
    db.insert(schema.events).values({ id: "e1", name: "Event One" }).run();
    await expect(assertEventNotArchived(db, "e1")).resolves.toBeUndefined();
  });

  it("resolves when the event does not exist yet", async () => {
    const db = freshDb();
    await expect(assertEventNotArchived(db, "unknown")).resolves.toBeUndefined();
  });

  it("throws EventArchivedError when archivedAt is set", async () => {
    const db = freshDb();
    db.insert(schema.events)
      .values({ id: "e1", name: "Event One", archivedAt: "2026-01-01T00:00:00.000Z" })
      .run();
    await expect(assertEventNotArchived(db, "e1")).rejects.toThrow(EventArchivedError);
  });
});
