import { describe, expect, it } from "vitest";
import { espnCardToDashboardState, loadLiveEventState } from "./liveEventState.ts";
import type {
  EspnScheduledCard,
  EspnScheduledEventSummary,
  EspnScheduleSource,
} from "../src/sources/espnSchedule.ts";

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

function fakeScheduleSource(
  events: EspnScheduledEventSummary[],
  cardsByEventId: Record<string, EspnScheduledCard>,
): EspnScheduleSource {
  return {
    async listUpcomingEvents() {
      return events;
    },
    async getCard(eventId: string) {
      return cardsByEventId[eventId] ?? null;
    },
  };
}

describe("loadLiveEventState event selection", () => {
  it("skips a completed event even when the schedule query returns it before the upcoming one", async () => {
    const completedCard = card();
    completedCard.eventId = "600000001";
    const upcomingCard = card();
    upcomingCard.eventId = "600000002";

    // `listUpcomingEvents()` now looks 300 days into the past (for the Past
    // events tab), so its result is sorted ascending by start date with old,
    // already-completed events first — the live-state loader must skip those
    // rather than latch onto whichever card happens to sort first.
    const events: EspnScheduledEventSummary[] = [
      {
        eventId: "600000001",
        name: "UFC Fight Night: Old vs. Stale",
        startsAt: "2025-10-11T20:00:00.000Z",
        status: "completed",
      },
      {
        eventId: "600000002",
        name: "UFC Fight Night: Gamrot vs. Salkilld",
        startsAt: "2026-08-08T18:00:00.000Z",
        status: "upcoming",
      },
    ];

    const source = fakeScheduleSource(events, {
      "600000001": completedCard,
      "600000002": upcomingCard,
    });

    const state = await loadLiveEventState({
      scheduleSource: source,
      now: () => new Date("2026-08-03T12:00:00Z"),
    });

    expect(state.event.id).toBe("600000002");
  });
});

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
