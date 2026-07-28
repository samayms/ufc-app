import { describe, expect, it } from "vitest";
import type { Bout, Fighter, Provenance } from "../schema.ts";
import { createSherdogSource } from "./sherdog.ts";

const fixtureProvenance: Provenance = {
  source: "fixture",
  fetchedAt: "2026-07-26T02:41:00Z",
  synthetic: true,
};

const fighter = (id: string, name: string): Fighter => ({
  id,
  externalRefs: [],
  name,
  record: { wins: 0, losses: 0, draws: 0, noContests: 0 },
  provenance: fixtureProvenance,
});

const mainBout: Bout = {
  id: "bout-main",
  externalRefs: [],
  eventId: "evt-fixture-001",
  cardPosition: 1,
  segment: "main-card",
  weightClass: "lightweight",
  scheduledRounds: 5,
  titleFight: false,
  fighters: {
    red: fighter("ftr-reyes", "Danilo Reyes"),
    blue: fighter("ftr-volkov", "Artem Volkov"),
  },
  status: "between-rounds",
  currentRound: 2,
  provenance: fixtureProvenance,
};

describe("createSherdogSource", () => {
  it("parses ordered round summaries and maps scores to fighter corners", async () => {
    const source = createSherdogSource({ mode: "fixture" });

    const updates = await source.getRoundUpdates(mainBout);

    expect(updates.map((update) => update.round)).toEqual([1, 2]);
    expect(updates.map((update) => update.score)).toEqual([
      { red: 10, blue: 9 },
      { red: 9, blue: 10 },
    ]);

    for (const update of updates) {
      expect(update.summary).toBeTruthy();
      expect(update.summary).not.toMatch(/<[^>]+>/);
    }
  });

  it("returns no updates for an unknown bout", async () => {
    const source = createSherdogSource({ mode: "fixture" });

    await expect(
      source.getRoundUpdates({ ...mainBout, id: "bout-unknown" }),
    ).resolves.toEqual([]);
  });
});
