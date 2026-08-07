/**
 * Production entry point: the one Node process Fly runs.
 *
 * Order matters:
 *   1. run migrations against the SQLite volume
 *   2. hydrate the collector from persisted state (createCollector already
 *      does this from the JSONL append log; SQLite-backed hydration slots
 *      in here as tables gain writers)
 *   3. start the HTTP API + SSE server (createCollector's own server)
 *   4. in live mode, supervise ESPN event changes and rebuild the collector
 *
 * The collector itself already runs in-process (see server/collector.ts) —
 * there is no second Node process to spawn.
 */

import { pathToFileURL } from "node:url";

import { createCollector } from "./collector.ts";
import { loadConfig } from "./config.ts";
import { closeDb, getDb } from "./db/client.ts";
import { runMigrations } from "./db/migrate.ts";
import { EventArchiver } from "./eventArchiver.ts";
import {
  EVENT_ROTATION_STORAGE_STREAM,
  EventRotationSupervisor,
} from "./eventRotationSupervisor.ts";
import { materializeKalshiPrivateKey } from "./kalshiKeyMaterializer.ts";
import { loadLiveEventState } from "./liveEventState.ts";
import { JsonlStorage } from "./storage.ts";
import {
  createEspnScheduleSource,
  eventWithinReviewWindow,
} from "../src/sources/espnSchedule.ts";
import { nextUpcomingEventId } from "../src/lib/eventIdentity.ts";
import { readUpcomingOddsDocument } from "./upcomingOddsStore.ts";

export const EVENT_ROTATION_INTERVAL_MS = 15 * 60 * 1_000;

export async function startApp(): Promise<{
  stop: () => Promise<void>;
}> {
  materializeKalshiPrivateKey();
  const config = loadConfig(process.env);
  const storage = new JsonlStorage(config.persistencePath);

  console.log("Running database migrations…");
  runMigrations();

  console.log("Starting collector (API + SSE + collector)…");
  const scheduleSource = createEspnScheduleSource();
  const nowMs = Date.now();
  const preferredEventIds: string[] = [];
  if (config.dataMode === "live") {
    const upcoming = await readUpcomingOddsDocument(config.persistencePath);
    preferredEventIds.push(
      ...(upcoming?.events ?? [])
        .filter((event) => {
          if (event.startsAt === undefined) return false;
          return eventWithinReviewWindow(event.startsAt, new Date(nowMs));
        })
        .sort(
          (left, right) =>
            Date.parse(right.startsAt ?? "") - Date.parse(left.startsAt ?? ""),
        )
        .map((event) => event.espnEventId),
    );
    const persistedEventId = (await storage.read<Record<string, unknown>>(
      EVENT_ROTATION_STORAGE_STREAM,
    )).flatMap((entry) =>
      typeof entry.eventId === "string" ? [entry.eventId] : []
    ).at(-1);
    if (persistedEventId !== undefined) preferredEventIds.push(persistedEventId);
  }
  // Bind every interface in production so Fly's proxy can reach the
  // Machine; local dev tooling still gets collector.ts's 127.0.0.1 default.
  const collectorOptions = {
    host: process.env.HOST ?? "0.0.0.0",
    storage,
    ...(config.dataMode === "live"
      ? {
          stateLoader: () => loadLiveEventState({
            scheduleSource,
            preferredEventIds: [...new Set(preferredEventIds)],
          }),
        }
      : {}),
  } as const;
  let collector = await createCollector(collectorOptions);
  const port = await collector.start();
  console.log(`UFC app listening on http://127.0.0.1:${port}`);

  const eventArchiver = new EventArchiver({ db: getDb() });
  eventArchiver.start();

  let activeEventId = collector.getBootstrap().state?.event.id;
  const rotation =
    config.dataMode === "live"
      ? new EventRotationSupervisor({
          storage,
          ...(activeEventId === undefined
            ? {}
            : { initialEventId: activeEventId }),
          intervalMs: EVENT_ROTATION_INTERVAL_MS,
          resolveEventId: async () => {
            const activeStartsAt = collector.getBootstrap().state?.event.startsAt;
            if (activeEventId !== undefined && activeStartsAt !== undefined) {
              if (eventWithinReviewWindow(activeStartsAt, new Date())) {
                return activeEventId;
              }
            }
            return nextUpcomingEventId(
              await scheduleSource.listUpcomingEvents(),
            );
          },
          rotate: async (eventId) => {
            if (eventId === activeEventId) return;
            console.log(`ESPN event changed to ${eventId}; rotating collector…`);
            const nextState = await loadLiveEventState({});
            if (nextState.event.id !== eventId) {
              throw new Error(
                `ESPN event changed during rotation (${eventId} -> ${nextState.event.id})`,
              );
            }
            const nextCollector = await createCollector({
              ...collectorOptions,
              stateLoader: async () => nextState,
            });
            await collector.close();
            try {
              const nextPort = await nextCollector.start();
              collector = nextCollector;
              activeEventId = eventId;
              console.log(
                `Collector rotated to ${eventId} on http://127.0.0.1:${nextPort}`,
              );
            } catch (error) {
              await nextCollector.close().catch(() => undefined);
              throw error;
            }
          },
          onError: (error) => {
            console.error(
              "Event rotation check failed:",
              error instanceof Error ? error.message : error,
            );
          },
        })
      : undefined;
  await rotation?.start();

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    eventArchiver.stop();
    await rotation?.close();
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
