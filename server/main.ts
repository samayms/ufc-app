/**
 * Production entry point: the one Node process Fly runs.
 *
 * Order matters:
 *   1. run migrations against the SQLite volume
 *   2. hydrate the collector from persisted state (createCollector already
 *      does this from the JSONL append log; SQLite-backed hydration slots
 *      in here as tables gain writers)
 *   3. start the HTTP API + SSE server (createCollector's own server)
 *   4. start the upcoming-sync scheduler (catch-up, then 6a/6p America/New_York)
 *
 * The collector itself already runs in-process (see server/collector.ts) —
 * there is no second Node process to spawn.
 */

import { pathToFileURL } from "node:url";

import { createCollector } from "./collector.ts";
import { closeDb } from "./db/client.ts";
import { runMigrations } from "./db/migrate.ts";
import { materializeKalshiPrivateKey } from "./kalshiKeyMaterializer.ts";
import { UpcomingScheduler } from "./scheduler.ts";

export async function startApp(): Promise<{
  stop: () => Promise<void>;
}> {
  materializeKalshiPrivateKey();

  console.log("Running database migrations…");
  runMigrations();

  console.log("Starting collector (API + SSE + collector)…");
  const collector = await createCollector();
  const port = await collector.start();
  console.log(`UFC app listening on http://127.0.0.1:${port}`);

  const scheduler = new UpcomingScheduler();
  await scheduler.catchUpIfNeeded().catch((error: unknown) => {
    console.error(
      "Startup catch-up sync failed:",
      error instanceof Error ? error.message : error,
    );
  });
  scheduler.start();

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    scheduler.stop();
    await collector.close();
    closeDb();
  };

  return { stop };
}

async function main(): Promise<void> {
  const app = await startApp();

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down…`);
    app
      .stop()
      .then(() => {
        console.log("Shutdown complete.");
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error("Error during shutdown:", error);
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "App failed to start",
    );
    process.exitCode = 1;
  });
}
