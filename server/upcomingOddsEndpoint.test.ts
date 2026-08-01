import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCollector, type Collector } from "./collector.ts";
import { MemoryStorage } from "./storage.ts";
import { syncUpcomingOdds } from "./upcomingOdds.ts";
import { writeUpcomingOddsDocument } from "./upcomingOddsStore.ts";
import { createFixtureUpcomingProviders } from "../src/sources/upcoming/fixtureUpcoming.ts";

const collectors: Collector[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(collectors.splice(0).map((collector) => collector.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function startCollector(persistencePath: string): Promise<number> {
  const collector = await createCollector({
    env: {
      DATA_MODE: "fixture",
      COLLECTOR_PORT: "0",
      PERSISTENCE_PATH: persistencePath,
    },
    storage: new MemoryStorage(),
    sse: { heartbeatMs: 50 },
  });
  collectors.push(collector);
  return collector.start();
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ufc-upcoming-api-"));
  directories.push(directory);
  return directory;
}

describe("GET /api/upcoming-odds", () => {
  it("serves the document the sync wrote", async () => {
    const directory = await temporaryDirectory();
    const document = await syncUpcomingOdds({
      cards: [
        {
          espnEventId: "600059185",
          name: "UFC 330",
          startsAt: "2026-08-15T21:00:00.000Z",
          bouts: [
            {
              boutId: "401869336",
              redFighter: "Islam Makhachev",
              blueFighter: "Ian Machado Garry",
              startsAt: "2026-08-15T21:00:00.000Z",
            },
          ],
        },
      ],
      providers: createFixtureUpcomingProviders(),
      synthetic: true,
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    await writeUpcomingOddsDocument(directory, document);

    const port = await startCollector(directory);
    const response = await fetch(
      `http://127.0.0.1:${port}/api/upcoming-odds`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ document });
  });

  it("reports a never-run sync as a null document, not an error", async () => {
    const port = await startCollector(await temporaryDirectory());
    const response = await fetch(
      `http://127.0.0.1:${port}/api/upcoming-odds`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ document: null });
  });

  it("picks up a document written after the collector started", async () => {
    const directory = await temporaryDirectory();
    const port = await startCollector(directory);

    expect(
      await (await fetch(`http://127.0.0.1:${port}/api/upcoming-odds`)).json(),
    ).toEqual({ document: null });

    const document = await syncUpcomingOdds({
      cards: [
        {
          espnEventId: "600059185",
          name: "UFC 330",
          bouts: [
            {
              boutId: "401869336",
              redFighter: "Islam Makhachev",
              blueFighter: "Ian Machado Garry",
              startsAt: "2026-08-15T21:00:00.000Z",
            },
          ],
          startsAt: "2026-08-15T21:00:00.000Z",
        },
      ],
      providers: createFixtureUpcomingProviders(),
      synthetic: true,
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    await writeUpcomingOddsDocument(directory, document);

    const refreshed = (await (
      await fetch(`http://127.0.0.1:${port}/api/upcoming-odds`)
    ).json()) as { document: unknown };
    expect(refreshed.document).toEqual(document);
  });
});
