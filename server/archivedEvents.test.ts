import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";

import * as schema from "./db/schema.ts";
import {
  listArchivedEvents,
  loadArchivedEvent,
  loadArchivedEventSnapshot,
} from "./archivedEvents.ts";
import { MemoryStorage } from "./storage.ts";

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
  db.insert(schema.externalRefs).values([
    { entityType: "event", entityId: "e1", source: "espn", externalId: "e1" },
    { entityType: "bout", entityId: "b1", source: "espn", externalId: "b1" },
    { entityType: "person", entityId: "f-red", source: "espn", externalId: "100" },
    { entityType: "person", entityId: "f-blue", source: "espn", externalId: "200" },
  ]).run();
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
    expect(bout?.fighters.red.name).toBe("Red Fighter");
    expect(bout?.fighters.blue.name).toBe("Blue Fighter");
    expect(bout?.fighters.red.record.wins).toBe(20);
    expect(bout?.externalRefs).toContainEqual({ source: "espn", id: "b1" });
    expect(bout?.fighters.red.externalRefs).toContainEqual({ source: "espn", id: "100" });
    expect(state?.event.externalRefs).toContainEqual({ source: "espn", id: "e1" });
    expect(bout?.result?.winner).toBe("red");
    expect(state?.boutViews.b1?.rounds.espn?.[0]?.stats?.red?.significantStrikesLanded).toBe(12);
  });

  it("renders stale archived lifecycle rows as terminal review bouts", async () => {
    const db = freshDb();
    seedArchivedEvent(db);
    db.update(schema.bouts).set({ status: "between-rounds" }).run();

    const state = await loadArchivedEvent(db, "e1");
    expect(state?.event.bouts[0]?.status).toBe("final");
    expect(state?.boutViews.b1?.rounds.espn?.[0]?.stats?.red?.significantStrikesLanded).toBe(12);
  });

  it("restores the archived card's rich collector state and latest round records", async () => {
    const db = freshDb();
    seedArchivedEvent(db);
    const storage = new MemoryStorage();
    const databaseState = await loadArchivedEvent(db, "e1");
    expect(databaseState).toBeDefined();
    if (databaseState === undefined) return;
    const richState = structuredClone(databaseState);
    const richBout = richState.event.bouts[0];
    if (richBout === undefined) return;
    richBout.status = "between-rounds";
    delete richBout.result;
    richBout.fighters.red.age = 37;
    richBout.fighters.red.recentBouts = [{
      opponentName: "Previous Opponent",
      result: "win",
      method: "decision-unanimous",
      date: "2025-01-01T00:00:00.000Z",
      eventName: "Previous Event",
    }];
    richState.boutViews.b1 = {
      ...(richState.boutViews.b1 as NonNullable<typeof richState.boutViews.b1>),
      bout: richBout,
    };
    await storage.append("collector-state", { version: 1, state: richState });
    const round = {
      boutId: "b1",
      round: 1,
      detectedEndedAt: "2026-01-01T00:10:00.000Z",
      endingSignal: "period_transition",
      espnStats: {
        boutId: "b1",
        round: 1,
        fighterA: { significantStrikesLanded: 18 },
        fighterB: { significantStrikesLanded: 9 },
        observedAt: "2026-01-01T00:10:00.000Z",
        finalized: true,
      },
      sherdog: {
        boutId: "b1",
        round: 1,
        commentary: "Red controlled the round.",
        scorerCards: [],
        sourceUrl: "https://example.com/round",
        fetchedAt: "2026-01-01T00:11:00.000Z",
        parserVersion: "test",
        payloadHash: "hash",
      },
      marketAtEnd: {},
      provisional: false,
      finalizedAt: "2026-01-01T00:11:00.000Z",
    };
    await storage.append("unified-rounds", { version: 1, record: round });
    await storage.append("unified-rounds", {
      version: 1,
      record: { ...round, finalizedAt: "2026-01-01T00:12:00.000Z" },
    });
    await storage.append("unified-rounds", {
      version: 1,
      record: { ...round, boutId: "other-bout" },
    });

    const snapshot = await loadArchivedEventSnapshot(db, "e1", storage);
    expect(snapshot?.event.bouts[0]?.status).toBe("final");
    expect(snapshot?.event.bouts[0]?.result?.winner).toBe("red");
    expect(snapshot?.event.bouts[0]?.fighters.red.age).toBe(37);
    expect(snapshot?.event.bouts[0]?.fighters.red.recentBouts?.[0]?.opponentName)
      .toBe("Previous Opponent");
    expect(snapshot?.unifiedRounds).toHaveLength(1);
    expect(snapshot?.unifiedRounds[0]?.finalizedAt).toBe("2026-01-01T00:12:00.000Z");
  });

  it("returns undefined for an event that is not archived", async () => {
    const db = freshDb();
    db.insert(schema.events).values({ id: "e2", name: "Live Event" }).run();
    expect(await loadArchivedEvent(db, "e2")).toBeUndefined();
  });
});
