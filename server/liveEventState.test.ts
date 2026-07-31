import { describe, expect, it } from "vitest";
import { espnCardToDashboardState } from "./liveEventState.ts";
import type { EspnScheduledCard } from "../src/sources/espnSchedule.ts";

function card(): EspnScheduledCard {
  return {
    eventId: "600123456",
    name: "UFC Belgrade: Medic vs. Rodriguez",
    sections: [
      {
        key: "main",
        displayName: "Main Card",
        segment: "main-card",
        fights: [
          {
            competitionId: "comp-1",
            titleFight: false,
            mainEvent: true,
            red: { name: "Uros Medic", record: "12-4-0" },
            blue: { name: "Daniel Rodriguez", record: "18-4-0" },
            status: "upcoming",
          },
          {
            competitionId: "comp-2",
            titleFight: false,
            mainEvent: false,
            red: { name: "Ikram Aliskerov", record: "16-2-0" },
            blue: { name: "Robert Whittaker", record: "25-7-0" },
            status: "upcoming",
          },
        ],
      },
    ],
  };
}

describe("espnCardToDashboardState outlook wiring", () => {
  it("attaches the fixture outlook to the bout it matches by ESPN competition id", () => {
    const outlookByBoutId = new Map([
      ["comp-1", "Medic pressures behind volume; Rodriguez looks to grind it out."],
    ]);

    const state = espnCardToDashboardState(card(), "2026-07-30T00:00:00Z", outlookByBoutId);

    expect(state.event.bouts.find((b) => b.id === "comp-1")?.outlook).toBe(
      "Medic pressures behind volume; Rodriguez looks to grind it out.",
    );
  });

  it("leaves outlook undefined for a bout with no fixture entry", () => {
    const state = espnCardToDashboardState(
      card(),
      "2026-07-30T00:00:00Z",
      new Map(),
    );

    expect(state.event.bouts.find((b) => b.id === "comp-2")?.outlook).toBeUndefined();
  });

  it("defaults to the real fixture file when no map is injected", () => {
    // Real fixture starts empty in this checkout / for a card it hasn't
    // covered, so this just proves the default path doesn't throw and
    // produces no outlook rather than crashing.
    const state = espnCardToDashboardState(card(), "2026-07-30T00:00:00Z");

    expect(state.event.bouts).toHaveLength(2);
  });
});
