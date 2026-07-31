import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "ufc-main-startup-"));
  process.env.DB_PATH = join(scratchDir, "ufc.db");
  process.env.PERSISTENCE_PATH = join(scratchDir, "data");
  process.env.COLLECTOR_PORT = "0"; // ephemeral port, avoids clashing with a dev server
  delete process.env.DATA_MODE; // fixture mode: no network, no credentials
});

afterEach(() => {
  delete process.env.DB_PATH;
  delete process.env.PERSISTENCE_PATH;
  delete process.env.COLLECTOR_PORT;
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("startApp", () => {
  it("runs migrations, starts the collector, and shuts down cleanly on stop()", async () => {
    const { startApp } = await import("./main.ts");
    const { closeDb, getRawDb } = await import("./db/client.ts");

    const app = await startApp();

    // Migrations ran against DB_PATH before the collector started.
    const tables = getRawDb()
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toContain("sync_runs");

    await expect(app.stop()).resolves.toBeUndefined();

    // stop() closes the shared connection; a second close() must be a no-op.
    expect(() => closeDb()).not.toThrow();
  }, 20_000);
});
