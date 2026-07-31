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
    `ufc-migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

describe("runMigrations", () => {
  let dbPath: string | undefined;

  afterEach(() => {
    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      dbPath = undefined;
    }
  });

  it("creates every table on a brand-new empty database", () => {
    dbPath = freshDbPath();
    const connection = new Database(dbPath);
    const db = drizzle(connection, { schema });

    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const tables = connection
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);

    for (const expected of [
      "people",
      "fighters",
      "aliases",
      "external_refs",
      "media_assets",
      "events",
      "bouts",
      "bout_participants",
      "provider_markets",
      "bout_mappings",
      "provider_state",
      "latest_market_state",
      "upcoming_odds_snapshots",
      "round_stats",
      "commentary",
      "sync_runs",
      "lifecycle_events",
    ]) {
      expect(tables).toContain(expected);
    }

    connection.close();
  });

  it("is idempotent — running twice against the same file does not throw", () => {
    dbPath = freshDbPath();
    const first = new Database(dbPath);
    migrate(drizzle(first, { schema }), {
      migrationsFolder: MIGRATIONS_FOLDER,
    });
    first.close();

    const second = new Database(dbPath);
    expect(() =>
      migrate(drizzle(second, { schema }), {
        migrationsFolder: MIGRATIONS_FOLDER,
      }),
    ).not.toThrow();
    second.close();
  });

  it("applies the required pragmas when opened through the shared client", async () => {
    dbPath = freshDbPath();
    const { openConnection } = await import("./client.ts");
    const connection = openConnection(dbPath);

    expect(connection.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(connection.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(connection.pragma("synchronous", { simple: true })).toBe(1);

    connection.close();
  });
});
