// server/db/schema.test.ts
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";

import * as schema from "./schema.ts";

const MIGRATIONS_FOLDER = new URL("./migrations", import.meta.url).pathname;

function freshDbPath(): string {
  return join(
    tmpdir(),
    `ufc-schema-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

describe("fighters table is bout-scoped", () => {
  let dbPath: string | undefined;

  afterEach(() => {
    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      dbPath = undefined;
    }
  });

  it("allows the same person to have multiple rows across different bouts", () => {
    dbPath = freshDbPath();
    const connection = new Database(dbPath);
    const db = drizzle(connection, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    db.insert(schema.people).values({ id: "jon-jones", name: "Jon Jones" }).run();
    db.insert(schema.events)
      .values({ id: "ufc-300", name: "UFC 300" })
      .run();
    db.insert(schema.bouts)
      .values([
        { id: "bout-1", eventId: "ufc-300", status: "final" },
        { id: "bout-2", eventId: "ufc-300", status: "upcoming" },
      ])
      .run();

    db.insert(schema.fighters)
      .values([
        {
          boutId: "bout-1",
          personId: "jon-jones",
          corner: "red",
          wins: 27,
          losses: 1,
          ranking: "#1 Heavyweight",
        },
        {
          boutId: "bout-2",
          personId: "jon-jones",
          corner: "red",
          wins: 28,
          losses: 1,
          ranking: "Heavyweight Champion",
        },
      ])
      .run();

    const rows = db
      .select()
      .from(schema.fighters)
      .all()
      .filter((row) => row.personId === "jon-jones");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.wins).sort()).toEqual([27, 28]);

    connection.close();
  });

  it("rejects a duplicate (boutId, personId) row", () => {
    dbPath = freshDbPath();
    const connection = new Database(dbPath);
    const db = drizzle(connection, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    db.insert(schema.people).values({ id: "f1", name: "Fighter One" }).run();
    db.insert(schema.events).values({ id: "e1", name: "Event One" }).run();
    db.insert(schema.bouts).values({ id: "b1", eventId: "e1" }).run();
    db.insert(schema.fighters)
      .values({ boutId: "b1", personId: "f1", corner: "red" })
      .run();

    expect(() =>
      db
        .insert(schema.fighters)
        .values({ boutId: "b1", personId: "f1", corner: "red" })
        .run(),
    ).toThrow();

    connection.close();
  });
});
