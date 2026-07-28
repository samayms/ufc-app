import { describe, expect, it } from "vitest";
import { loadFixtureEvent } from "../src/store/fixtureEvent.ts";
import {
  AMBIGUOUS_MAPPING_STREAM,
  BOUT_MAPPING_OVERRIDE_STREAM,
  BOUT_MAPPING_STREAM,
  createBoutMappingRegistry,
  fuzzyMatchBoutFighters,
  normalizeFighterName,
} from "./mapping.ts";
import { MemoryStorage } from "./storage.ts";

describe("BoutMappingRegistry", () => {
  it("builds fixture mappings with canonical ids and externalRefs", async () => {
    const storage = new MemoryStorage();
    const registry = await createBoutMappingRegistry({
      event: loadFixtureEvent(),
      storage,
    });

    expect(registry.getAll()).toHaveLength(5);
    expect(registry.getMapping("bout-main")).toEqual({
      internalBoutId: "bout-main",
      externalRefs: [
        { source: "espn", id: "401770001" },
        { source: "cito", id: "cito-bout-9001" },
        {
          source: "kalshi",
          id: "KXUFCFIGHT-26JUL25REYVOL-REY",
        },
        {
          source: "kalshi",
          id: "KXUFCFIGHT-26JUL25REYVOL-VOL",
        },
        {
          source: "polymarket",
          id: "0x7b35d24a906ce8173bb6cfda94c80c819b47dd8e153bcc0d2722c3385619e4af",
        },
        {
          source: "polymarket",
          id: "10488201673418507703957484917278688764049206352911886332818699846300512815635",
        },
        {
          source: "polymarket",
          id: "92713044581400595800357835853269232303150605770758104904550685326314229170572",
        },
      ],
      redFighter: "Danilo Reyes",
      blueFighter: "Artem Volkov",
      weightClass: "lightweight",
      scheduledRounds: 5,
      mappingConfidence: 1,
      manuallyVerified: false,
    });
    await expect(storage.read(BOUT_MAPPING_STREAM)).resolves.toHaveLength(5);
  });

  it("looks up external ids and per-bout refs in both directions", async () => {
    const registry = await createBoutMappingRegistry({
      event: loadFixtureEvent(),
      storage: new MemoryStorage(),
    });

    expect(registry.findInternalBoutId("espn", "401770002")).toBe(
      "bout-comain",
    );
    expect(registry.findInternalBoutId("cito", "cito-bout-9002")).toBe(
      "bout-comain",
    );
    expect(registry.findInternalBoutId("espn", "missing")).toBeUndefined();
    expect(registry.getExternalRefs("bout-comain")).toEqual([
      { source: "espn", id: "401770002" },
      { source: "cito", id: "cito-bout-9002" },
    ]);
  });

  it("accepts confident fuzzy discovery below fixture confidence", async () => {
    const registry = await createBoutMappingRegistry({
      event: loadFixtureEvent(),
      storage: new MemoryStorage(),
    });

    const mapping = await registry.matchDiscoveredBout({
      externalRef: {
        source: "polymarket",
        id: "condition-main",
      },
      redFighter: "Artem Volkov",
      blueFighter: "Danilo Reyes",
    });

    expect(mapping).toMatchObject({
      internalBoutId: "bout-main",
      mappingConfidence: 0.95,
      manuallyVerified: false,
    });
    expect(
      registry.findInternalBoutId("polymarket", "condition-main"),
    ).toBe("bout-main");
  });

  it("lets injected manual overrides win over automatic refs", async () => {
    const storage = new MemoryStorage();
    const registry = await createBoutMappingRegistry({
      event: loadFixtureEvent(),
      storage,
      manualOverrides: [
        {
          internalBoutId: "bout-comain",
          externalRef: { source: "espn", id: "401770001" },
        },
      ],
    });

    expect(registry.findInternalBoutId("espn", "401770001")).toBe(
      "bout-comain",
    );
    expect(registry.getExternalRefs("bout-main")).not.toContainEqual({
      source: "espn",
      id: "401770001",
    });
    expect(registry.getMapping("bout-comain")).toMatchObject({
      mappingConfidence: 1,
      manuallyVerified: true,
    });
    await expect(
      storage.read(BOUT_MAPPING_OVERRIDE_STREAM),
    ).resolves.toHaveLength(1);
  });

  it("persists below-threshold discoveries for review", async () => {
    const storage = new MemoryStorage();
    const registry = await createBoutMappingRegistry({
      event: loadFixtureEvent(),
      storage,
    });

    await expect(
      registry.matchDiscoveredBout({
        externalRef: { source: "kalshi", id: "UNKNOWN-TICKER" },
        redFighter: "Unrelated Alpha",
        blueFighter: "Different Beta",
      }),
    ).resolves.toBeUndefined();

    const records = await storage.read(AMBIGUOUS_MAPPING_STREAM);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      version: 1,
      record: {
        discovered: {
          externalRef: {
            source: "kalshi",
            id: "UNKNOWN-TICKER",
          },
        },
        confidenceThreshold: 0.85,
        candidates: expect.any(Array),
      },
    });
    expect(
      registry.findInternalBoutId("kalshi", "UNKNOWN-TICKER"),
    ).toBeUndefined();
  });

  it("restores fuzzy mappings and manual overrides after restart", async () => {
    const storage = new MemoryStorage();
    const first = await createBoutMappingRegistry({
      event: loadFixtureEvent(),
      storage,
    });
    await first.matchDiscoveredBout({
      externalRef: {
        source: "polymarket",
        id: "condition-main",
      },
      redFighter: "Danilo Reyes",
      blueFighter: "Artem Volkov",
    });
    await first.setManualOverride({
      internalBoutId: "bout-comain",
      externalRef: { source: "kalshi", id: "KX-UFC-COMAIN" },
    });

    const restored = await createBoutMappingRegistry({
      event: loadFixtureEvent(),
      storage,
    });

    expect(
      restored.findInternalBoutId("polymarket", "condition-main"),
    ).toBe("bout-main");
    expect(
      restored.findInternalBoutId("kalshi", "KX-UFC-COMAIN"),
    ).toBe("bout-comain");
    expect(restored.getMapping("bout-main")).toMatchObject({
      mappingConfidence: 0.95,
    });
    expect(restored.getMapping("bout-comain")).toMatchObject({
      mappingConfidence: 1,
      manuallyVerified: true,
    });
  });
});

describe("fuzzy fighter matching", () => {
  it("normalizes accents, punctuation, suffixes, and name order", () => {
    expect(normalizeFighterName("José  Aldo, Jr.")).toBe("aldo jose");
    expect(normalizeFighterName("Aldo Jose")).toBe("aldo jose");
  });

  it("matches red/blue pairs independent of corner order", () => {
    const direct = fuzzyMatchBoutFighters(
      { redFighter: "Danilo Reyes", blueFighter: "Artem Volkov" },
      { redFighter: "Danilo Reyes", blueFighter: "Artem Volkov" },
    );
    const reversed = fuzzyMatchBoutFighters(
      { redFighter: "Danilo Reyes", blueFighter: "Artem Volkov" },
      { redFighter: "Artem Volkov", blueFighter: "Danilo Reyes" },
    );
    const misspelled = fuzzyMatchBoutFighters(
      { redFighter: "Danilo Reyes", blueFighter: "Artem Volkov" },
      { redFighter: "Danilo Reyez", blueFighter: "Artem Volkov" },
    );

    expect(direct).toEqual({
      confidence: 0.95,
      cornersReversed: false,
    });
    expect(reversed).toEqual({
      confidence: 0.95,
      cornersReversed: true,
    });
    expect(misspelled.confidence).toBeLessThan(0.95);
    expect(misspelled.confidence).toBeGreaterThan(0.85);
  });
});
