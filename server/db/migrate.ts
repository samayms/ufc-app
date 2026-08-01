/**
 * Runs checked-in Drizzle migrations against the shared connection. Called
 * at process startup, before the API/collector/scheduler start — never as
 * a Fly `release_command`, since the release Machine has no Volume
 * attached and would run against an empty, throwaway filesystem.
 */

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { getDb } from "./client.ts";

const MIGRATIONS_FOLDER = new URL("./migrations", import.meta.url).pathname;

export function runMigrations(): void {
  migrate(getDb(), { migrationsFolder: MIGRATIONS_FOLDER });
}
