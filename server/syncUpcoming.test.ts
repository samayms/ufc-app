import { describe, expect, it } from "vitest";
import { loadLiveCards } from "./syncUpcoming.ts";
import type {
  EspnScheduledCard,
  EspnScheduledEventSummary,
  EspnScheduleSource,
} from "../src/sources/espnSchedule.ts";

function card(eventId: string): EspnScheduledCard {
  return {
    eventId,
    name: `Card ${eventId}`,
    sections: [
      {
        key: "main",
        displayName: "Main Card",
        segment: "main-card",
        fights: [
          {
            competitionId: `${eventId}-comp-1`,
            titleFight: false,
            mainEvent: true,
            red: { name: "Red Fighter", record: "1-0-0" },
            blue: { name: "Blue Fighter", record: "1-0-0" },
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

describe("loadLiveCards", () => {
  it("skips old completed events even when the schedule query returns them first", async () => {
    const events: EspnScheduledEventSummary[] = [
      {
        eventId: "old-completed",
        name: "UFC Fight Night: Old vs. Stale",
        startsAt: "2025-10-11T20:00:00.000Z",
        status: "completed",
      },
      {
        eventId: "next-up",
        name: "UFC Fight Night: Gamrot vs. Salkilld",
        startsAt: "2026-08-08T18:00:00.000Z",
        status: "upcoming",
      },
    ];
    const source = fakeScheduleSource(events, {
      "old-completed": card("old-completed"),
      "next-up": card("next-up"),
    });

    const cards = await loadLiveCards(2, source);

    expect(cards.map((c) => c.espnEventId)).toEqual(["next-up"]);
  });
});
