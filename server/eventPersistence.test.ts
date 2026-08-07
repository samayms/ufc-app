import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "./db/schema.ts";
import { persistDashboardState } from "./eventPersistence.ts";
import type { DashboardState, Fighter } from "../src/schema.ts";

const MIGRATIONS_FOLDER = new URL("./db/migrations", import.meta.url).pathname;

function freshDb() {
  const connection = new Database(":memory:");
  const db = drizzle(connection, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

function fighter(id: string, name: string): Fighter {
  return {
    id,
    externalRefs: [],
    name,
    record: { wins: 10, losses: 2, draws: 0, noContests: 0 },
    provenance: { source: "espn", fetchedAt: "2026-01-01T00:00:00.000Z", synthetic: false },
  };
}

function state(boutStatus: "upcoming" | "final"): DashboardState {
  return {
    event: {
      id: "e1",
      externalRefs: [],
      name: "UFC 300",
      startsAt: "2026-01-01T00:00:00.000Z",
      bouts: [
        {
          id: "b1",
          externalRefs: [],
          eventId: "e1",
          cardPosition: 1,
          segment: "main-card",
          weightClass: "heavyweight",
          scheduledRounds: 5,
          titleFight: true,
          fighters: { red: fighter("f-red", "Red Fighter"), blue: fighter("f-blue", "Blue Fighter") },
          status: boutStatus,
          provenance: { source: "espn", fetchedAt: "2026-01-01T00:00:00.000Z", synthetic: false },
        },
      ],
      provenance: { source: "espn", fetchedAt: "2026-01-01T00:00:00.000Z", synthetic: false },
    },
    boutViews: {
      b1: {
        bout: {
          id: "b1", externalRefs: [], eventId: "e1", cardPosition: 1, segment: "main-card",
          weightClass: "heavyweight", scheduledRounds: 5, titleFight: true,
          fighters: { red: fighter("f-red", "Red Fighter"), blue: fighter("f-blue", "Blue Fighter") },
          status: boutStatus,
          provenance: { source: "espn", fetchedAt: "2026-01-01T00:00:00.000Z", synthetic: false },
        },
        rounds: {
          espn: [
            { boutId: "b1", round: 1, summary: "Round 1 recap", provenance: { source: "espn", fetchedAt: "2026-01-01T00:00:00.000Z", synthetic: false } },
          ],
        },
        latestOdds: {},
        oddsHistory: {},
        marketMoves: {},
        preFightOdds: {},
      },
    },
  };
}

describe("persistDashboardState", () => {
  it("writes event, bout, fighters, and round stats", async () => {
    const db = freshDb();
    await persistDashboardState(db, state("upcoming"));

    expect(db.select().from(schema.events).get()?.id).toBe("e1");
    expect(db.select().from(schema.bouts).get()?.id).toBe("b1");
    expect(db.select().from(schema.fighters).all()).toHaveLength(2);
  });

  it("locks fighter rows once the bout is no longer upcoming", async () => {
    const db = freshDb();
    await persistDashboardState(db, state("upcoming"));
    await persistDashboardState(db, state("final"));

    const rows = db.select().from(schema.fighters).all();
    expect(rows.every((row) => row.lockedAt !== null)).toBe(true);
  });

  it("skips a bout whose event is archived instead of throwing", async () => {
    const db = freshDb();
    await persistDashboardState(db, state("upcoming"));
    db.update(schema.events)
      .set({ archivedAt: "2026-01-02T00:00:00.000Z" })
      .where(eq(schema.events.id, "e1"))
      .run();

    await expect(persistDashboardState(db, state("final"))).resolves.toBeUndefined();
    const bout = db.select().from(schema.bouts).get();
    expect(bout?.status).toBe("upcoming"); // untouched
  });
});
