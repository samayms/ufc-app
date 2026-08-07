// server/fighterSnapshots.test.ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";

import * as schema from "./db/schema.ts";
import { recordFighterSnapshot } from "./fighterSnapshots.ts";
import type { Fighter } from "../src/schema.ts";

const MIGRATIONS_FOLDER = new URL("./db/migrations", import.meta.url).pathname;

function freshDb() {
  const connection = new Database(":memory:");
  const db = drizzle(connection, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

function seedEventAndBout(db: ReturnType<typeof freshDb>) {
  db.insert(schema.events).values({ id: "e1", name: "Event One" }).run();
  db.insert(schema.bouts).values({ id: "b1", eventId: "e1" }).run();
}

const jones: Fighter = {
  id: "jon-jones",
  externalRefs: [{ source: "espn", id: "1234" }],
  name: "Jon Jones",
  record: { wins: 28, losses: 1, draws: 0, noContests: 1 },
  ranking: "#1 Heavyweight",
  provenance: { source: "espn", fetchedAt: "2026-01-01T00:00:00.000Z", synthetic: false },
};

describe("recordFighterSnapshot", () => {
  it("upserts an unlocked row while the bout is upcoming", async () => {
    const db = freshDb();
    seedEventAndBout(db);

    await recordFighterSnapshot(db, {
      eventId: "e1",
      boutId: "b1",
      corner: "red",
      fighter: jones,
      boutIsUpcoming: true,
    });

    const row = db.select().from(schema.fighters).get();
    expect(row?.personId).toBe("jon-jones");
    expect(row?.wins).toBe(28);
    expect(row?.lockedAt).toBeNull();
  });

  it("locks the row the first time boutIsUpcoming is false", async () => {
    const db = freshDb();
    seedEventAndBout(db);
    await recordFighterSnapshot(db, {
      eventId: "e1", boutId: "b1", corner: "red", fighter: jones, boutIsUpcoming: true,
    });

    await recordFighterSnapshot(db, {
      eventId: "e1", boutId: "b1", corner: "red", fighter: jones, boutIsUpcoming: false,
    });

    const row = db.select().from(schema.fighters).get();
    expect(row?.lockedAt).not.toBeNull();
  });

  it("never overwrites a locked row, even with different data", async () => {
    const db = freshDb();
    seedEventAndBout(db);
    await recordFighterSnapshot(db, {
      eventId: "e1", boutId: "b1", corner: "red", fighter: jones, boutIsUpcoming: false,
    });

    const postFightJones: Fighter = {
      ...jones,
      record: { wins: 29, losses: 1, draws: 0, noContests: 1 },
      ranking: "P4P #1",
    };
    await recordFighterSnapshot(db, {
      eventId: "e1", boutId: "b1", corner: "red", fighter: postFightJones, boutIsUpcoming: false,
    });

    const row = db.select().from(schema.fighters).get();
    expect(row?.wins).toBe(28);
    expect(row?.ranking).toBe("#1 Heavyweight");
  });

  it("throws if the event is already archived", async () => {
    const db = freshDb();
    db.insert(schema.events)
      .values({ id: "e1", name: "Event One", archivedAt: "2026-01-01T00:00:00.000Z" })
      .run();
    db.insert(schema.bouts).values({ id: "b1", eventId: "e1" }).run();

    await expect(
      recordFighterSnapshot(db, {
        eventId: "e1", boutId: "b1", corner: "red", fighter: jones, boutIsUpcoming: true,
      }),
    ).rejects.toThrow();
  });
});
