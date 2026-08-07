import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";

import * as schema from "./db/schema.ts";
import { listArchivedEvents, loadArchivedEvent } from "./archivedEvents.ts";

const MIGRATIONS_FOLDER = new URL("./db/migrations", import.meta.url).pathname;

function freshDb() {
  const connection = new Database(":memory:");
  const db = drizzle(connection, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

function seedArchivedEvent(db: ReturnType<typeof freshDb>) {
  db.insert(schema.events)
    .values({ id: "e1", name: "UFC 300", startTime: "2026-01-01T00:00:00.000Z", archivedAt: "2026-01-02T00:00:00.000Z" })
    .run();
  db.insert(schema.bouts)
    .values({
      id: "b1", eventId: "e1", cardPosition: 1, weightClass: "heavyweight", status: "final",
      resultWinnerCorner: "red", resultMethod: "ko-tko", resultRound: 2, scheduledRounds: 5,
    })
    .run();
  db.insert(schema.people).values([{ id: "f-red", name: "Red Fighter" }, { id: "f-blue", name: "Blue Fighter" }]).run();
  db.insert(schema.boutParticipants)
    .values([{ boutId: "b1", personId: "f-red", corner: "red" }, { boutId: "b1", personId: "f-blue", corner: "blue" }])
    .run();
  db.insert(schema.fighters)
    .values([
      { boutId: "b1", personId: "f-red", corner: "red", wins: 20, losses: 1, draws: 0, noContests: 0, ranking: "#1", lockedAt: "2026-01-01T00:00:00.000Z" },
      { boutId: "b1", personId: "f-blue", corner: "blue", wins: 15, losses: 3, draws: 0, noContests: 0, lockedAt: "2026-01-01T00:00:00.000Z" },
    ])
    .run();
  db.insert(schema.roundStats)
    .values({ boutId: "b1", round: 1, corner: "red", statName: "significantStrikesLanded", statValue: 12, source: "espn", fetchedAt: "2026-01-01T00:10:00.000Z" })
    .run();
}

describe("listArchivedEvents / loadArchivedEvent", () => {
  it("lists only archived events", async () => {
    const db = freshDb();
    seedArchivedEvent(db);
    db.insert(schema.events).values({ id: "e2", name: "Not Archived Yet" }).run();

    const list = await listArchivedEvents(db);
    expect(list.map((e) => e.id)).toEqual(["e1"]);
  });

  it("assembles a DashboardState with locked fighter records and round stats", async () => {
    const db = freshDb();
    seedArchivedEvent(db);

    const state = await loadArchivedEvent(db, "e1");
    expect(state?.event.name).toBe("UFC 300");
    const bout = state?.event.bouts[0];
    expect(bout?.fighters.red.record.wins).toBe(20);
    expect(bout?.result?.winner).toBe("red");
    expect(state?.boutViews.b1?.rounds.espn?.[0]?.stats?.red?.significantStrikesLanded).toBe(12);
  });

  it("returns undefined for an event that is not archived", async () => {
    const db = freshDb();
    db.insert(schema.events).values({ id: "e2", name: "Live Event" }).run();
    expect(await loadArchivedEvent(db, "e2")).toBeUndefined();
  });
});
