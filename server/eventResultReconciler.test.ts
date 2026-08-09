import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";

import * as schema from "./db/schema.ts";
import { reconcileEspnEventResults } from "./eventResultReconciler.ts";
import type { DashboardState } from "../src/schema.ts";

const MIGRATIONS_FOLDER = new URL("./db/migrations", import.meta.url).pathname;

function freshDb() {
  const connection = new Database(":memory:");
  const db = drizzle(connection, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

function resultState(result: DashboardState["event"]["bouts"][number]["result"]): DashboardState {
  const bout = {
    id: "b1", eventId: "e1", cardPosition: 1, segment: "main-card" as const,
    weightClass: "lightweight" as const, scheduledRounds: 3 as const, titleFight: false,
    fighters: {} as DashboardState["event"]["bouts"][number]["fighters"], status: "final" as const,
    ...(result === undefined ? {} : { result }),
    externalRefs: [], provenance: { source: "espn" as const, fetchedAt: "2026-02-01T00:00:00.000Z", synthetic: false },
  };
  return {
    event: { id: "e1", name: "Event", startsAt: "", bouts: [bout], externalRefs: [], provenance: bout.provenance },
    boutViews: {},
  };
}

describe("reconcileEspnEventResults", () => {
  it("repairs a missing result even after the event is archived", () => {
    const db = freshDb();
    db.insert(schema.events).values({ id: "e1", name: "Event", archivedAt: "2026-02-01T00:00:00.000Z" }).run();
    db.insert(schema.bouts).values({ id: "b1", eventId: "e1", status: "final" }).run();

    const reconciled = reconcileEspnEventResults(db, resultState({
      winner: "blue", method: "submission", round: 2, time: "1:23",
    }));

    expect(reconciled.updatedBoutIds).toEqual(["b1"]);
    expect(db.select().from(schema.bouts).get()).toMatchObject({
      resultWinnerCorner: "blue", resultMethod: "submission", resultRound: 2, resultTime: "1:23",
    });
  });

  it("replaces ESPN's placeholder other method with an authoritative method", () => {
    const db = freshDb();
    db.insert(schema.events).values({ id: "e1", name: "Event", archivedAt: "2026-02-01T00:00:00.000Z" }).run();
    db.insert(schema.bouts).values({
      id: "b1", eventId: "e1", status: "final", resultWinnerCorner: "red", resultMethod: "other",
    }).run();

    const reconciled = reconcileEspnEventResults(db, resultState({
      winner: "red", method: "ko-tko", round: 1, time: "0:35",
    }));

    expect(reconciled.updatedBoutIds).toEqual(["b1"]);
    expect(db.select().from(schema.bouts).get()).toMatchObject({ resultMethod: "ko-tko", resultTime: "0:35" });
  });

  it("does not overwrite an already-specific archived result", () => {
    const db = freshDb();
    db.insert(schema.events).values({ id: "e1", name: "Event", archivedAt: "2026-02-01T00:00:00.000Z" }).run();
    db.insert(schema.bouts).values({
      id: "b1", eventId: "e1", status: "final", resultWinnerCorner: "red", resultMethod: "decision-unanimous",
    }).run();

    const reconciled = reconcileEspnEventResults(db, resultState({ winner: "blue", method: "submission" }));

    expect(reconciled.updatedBoutIds).toEqual([]);
    expect(db.select().from(schema.bouts).get()).toMatchObject({ resultWinnerCorner: "red", resultMethod: "decision-unanimous" });
  });
});
