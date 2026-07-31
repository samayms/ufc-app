/**
 * The single point of SQLite access for the whole process. Providers and
 * pipelines must import `getDb()` / `getRawDb()` from here rather than
 * constructing their own `better-sqlite3` connection — that's how the
 * WAL/foreign-key/busy-timeout pragmas below stay guaranteed for every
 * query anyone issues.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.ts";

export const DEFAULT_LOCAL_DB_PATH = "./data/ufc.db";

export function resolveDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.DB_PATH?.trim() || DEFAULT_LOCAL_DB_PATH;
}

export type AppDatabase = BetterSQLite3Database<typeof schema>;

let sharedConnection: Database.Database | undefined;
let sharedDb: AppDatabase | undefined;

function applyPragmas(connection: Database.Database): void {
  connection.pragma("journal_mode = WAL");
  connection.pragma("foreign_keys = ON");
  connection.pragma("busy_timeout = 5000");
  connection.pragma("synchronous = NORMAL");
}

/** Opens a fresh connection with the standard pragmas applied. Callers own its lifecycle. */
export function openConnection(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const connection = new Database(dbPath);
  applyPragmas(connection);
  return connection;
}

/** The process-wide singleton connection, created lazily on first use. */
export function getRawDb(): Database.Database {
  if (!sharedConnection) {
    sharedConnection = openConnection(resolveDbPath());
  }
  return sharedConnection;
}

export function getDb(): AppDatabase {
  if (!sharedDb) {
    sharedDb = drizzle(getRawDb(), { schema });
  }
  return sharedDb;
}

/** Closes the shared connection. Safe to call when none was ever opened. */
export function closeDb(): void {
  sharedConnection?.close();
  sharedConnection = undefined;
  sharedDb = undefined;
}

/**
 * Test/tooling escape hatch: point the singleton at a specific connection
 * (e.g. an in-memory database) instead of lazily opening `resolveDbPath()`.
 */
export function setDbForTesting(connection: Database.Database): AppDatabase {
  sharedConnection = connection;
  sharedDb = drizzle(connection, { schema });
  return sharedDb;
}

export { schema };
