import { describe, expect, it } from "vitest";

import { loadFixtureEvent } from "../src/store/fixtureEvent.ts";
import {
  BOUT_MAPPING_OVERRIDE_STREAM,
  BOUT_MAPPING_STREAM,
  createBoutMappingRegistry,
} from "./mapping.ts";
import { importCurrentEventUpcomingMappings } from "./upcomingMappingBridge.ts";
import { UPCOMING_MAPPING_STREAM } from "./upcomingOddsStore.ts";
import { MemoryStorage } from "./storage.ts";

function upcomingRecord(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    recordedAt: "2026-08-01T12:00:00.000Z",
    espnEventId: "600051234",
    boutId: "bout-main",
    provider: "polymarket",
    externalId: "new-polymarket-condition",
    streamIds: ["new-token-blue", "new-token-red"],
    confidence: 0.91,
    cornersReversed: true,
    ...overrides,
  };
}

describe("importCurrentEventUpcomingMappings", () => {
  it("imports matching current-event provider refs as automatic persisted mappings", async () => {
    const storage = new MemoryStorage();
    const event = loadFixtureEvent();
    const registry = await createBoutMappingRegistry({ event, storage });
    await storage.append(UPCOMING_MAPPING_STREAM, upcomingRecord());

    await expect(
      importCurrentEventUpcomingMappings({ event, registry, storage }),
    ).resolves.toEqual({ imported: 1, alreadyPresent: 0, rejected: 0 });

    expect(
      registry.findInternalBoutId("polymarket", "new-polymarket-condition"),
    ).toBeUndefined();
    expect(registry.getExternalRefs("bout-main")).toEqual(
      expect.arrayContaining([
        // The provider listed blue first; cornersReversed restores canonical
        // red, blue order for resolveMarketSubscriptions.
        { source: "polymarket", id: "new-token-red" },
        { source: "polymarket", id: "new-token-blue" },
      ]),
    );
    expect(registry.getMapping("bout-main")).toMatchObject({
      mappingConfidence: 0.91,
      manuallyVerified: false,
    });
    await expect(storage.read(BOUT_MAPPING_OVERRIDE_STREAM)).resolves.toEqual([]);
    await expect(storage.read(BOUT_MAPPING_STREAM)).resolves.toHaveLength(7);
  });

  it("rejects malformed, other-event, stale-bout, and conflicting references", async () => {
    const storage = new MemoryStorage();
    const event = loadFixtureEvent();
    const registry = await createBoutMappingRegistry({ event, storage });
    await storage.append(UPCOMING_MAPPING_STREAM, upcomingRecord({ espnEventId: "other-event" }));
    await storage.append(UPCOMING_MAPPING_STREAM, upcomingRecord({ boutId: "removed-bout" }));
    await storage.append(UPCOMING_MAPPING_STREAM, upcomingRecord({ externalId: "" }));
    await storage.append(
      UPCOMING_MAPPING_STREAM,
      upcomingRecord({
        boutId: "bout-comain",
        provider: "kalshi",
        externalId: "KXUFCFIGHT-26JUL25REYVOL-REY",
        streamIds: undefined,
      }),
    );

    await expect(
      importCurrentEventUpcomingMappings({ event, registry, storage }),
    ).resolves.toEqual({ imported: 0, alreadyPresent: 0, rejected: 4 });
    expect(registry.getExternalRefs("bout-comain")).not.toContainEqual({
      source: "kalshi",
      id: "KXUFCFIGHT-26JUL25REYVOL-REY",
    });
  });

  it("is idempotent when the bridge runs again after a restart", async () => {
    const storage = new MemoryStorage();
    const event = loadFixtureEvent();
    await storage.append(UPCOMING_MAPPING_STREAM, upcomingRecord());
    const first = await createBoutMappingRegistry({ event, storage });

    await importCurrentEventUpcomingMappings({ event, registry: first, storage });
    const restored = await createBoutMappingRegistry({ event, storage });

    await expect(
      importCurrentEventUpcomingMappings({ event, registry: restored, storage }),
    ).resolves.toEqual({ imported: 0, alreadyPresent: 1, rejected: 0 });
    await expect(storage.read(BOUT_MAPPING_STREAM)).resolves.toHaveLength(7);
  });

  it("imports Kalshi fighter tickers but never its non-streamable event ticker", async () => {
    const storage = new MemoryStorage();
    const event = loadFixtureEvent();
    const registry = await createBoutMappingRegistry({ event, storage });
    await storage.append(
      UPCOMING_MAPPING_STREAM,
      upcomingRecord({
        provider: "kalshi",
        externalId: "KXUFCFIGHT-26AUG15REDBLU",
        streamIds: ["KXUFCFIGHT-26AUG15REDBLU-BLU", "KXUFCFIGHT-26AUG15REDBLU-RED"],
      }),
    );

    await importCurrentEventUpcomingMappings({ event, registry, storage });

    expect(registry.getExternalRefs("bout-main")).toEqual(
      expect.arrayContaining([
        { source: "kalshi", id: "KXUFCFIGHT-26AUG15REDBLU-RED" },
        { source: "kalshi", id: "KXUFCFIGHT-26AUG15REDBLU-BLU" },
      ]),
    );
    expect(registry.findInternalBoutId("kalshi", "KXUFCFIGHT-26AUG15REDBLU")).toBeUndefined();
  });
});
