import { describe, expect, it } from "vitest";
import type { UpcomingOddsDocument } from "../src/lib/upcomingOdds.ts";
import eventFixture from "../src/fixtures/event.json" with { type: "json" };
import type { UfcEvent } from "../src/schema.ts";
import { MemoryStorage } from "./storage.ts";
import { currentEventDecisionSubscriptions } from "./upcomingDecisionMappingBridge.ts";

function documentWithDecision(
  decision: UpcomingOddsDocument["events"][number]["bouts"][number]["decision"],
): UpcomingOddsDocument {
  return {
    version: 1,
    generatedAt: "2026-08-09T00:00:00Z",
    synthetic: false,
    events: [{
      espnEventId: "600051234",
      name: "UFC Fight Night: Reyes vs. Volkov",
      bouts: [{
        boutId: "bout-main",
        espnEventId: "600051234",
        redFighter: "Danilo Reyes",
        blueFighter: "Artem Volkov",
        providers: {},
        decision,
      }],
    }],
    unmatchedMarkets: [],
    providerRuns: {},
  };
}

describe("currentEventDecisionSubscriptions", () => {
  const fixture = eventFixture as unknown as {
    event: Omit<UfcEvent, "bouts">;
    bouts: UfcEvent["bouts"];
  };
  const event = { ...fixture.event, bouts: fixture.bouts } as UfcEvent;

  it("bootstraps a legacy Kalshi decision ticker from the current document", async () => {
    const subscriptions = await currentEventDecisionSubscriptions({
      event,
      storage: new MemoryStorage(),
      document: documentWithDecision({
        state: "loaded",
        source: "kalshi",
        decisionProbability: 0.39,
        finishProbability: 0.61,
        fetchedAt: "2026-08-09T00:00:00Z",
        synthetic: false,
        externalId: "KXUFCDISTANCE-TEST-DIST",
      }),
    });

    expect(subscriptions).toEqual([{
      source: "kalshi",
      boutId: "bout-main",
      externalId: "KXUFCDISTANCE-TEST-DIST",
      marketType: "fight-distance",
      outcome: "Decision",
    }]);
  });

  it("does not guess Polymarket token ids from a condition id", async () => {
    const subscriptions = await currentEventDecisionSubscriptions({
      event,
      storage: new MemoryStorage(),
      document: documentWithDecision({
        state: "loaded",
        source: "polymarket",
        decisionProbability: 0.39,
        finishProbability: 0.61,
        fetchedAt: "2026-08-09T00:00:00Z",
        synthetic: false,
        externalId: "condition-id",
      }),
    });

    expect(subscriptions).toEqual([]);
  });
});
