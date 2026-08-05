import { describe, expect, it } from "vitest";
import {
  hasEventCompleted,
  hasEventStarted,
  isEventDay,
  nextUpcomingEventId,
  sameEvent,
  selectFightTabBoutId,
} from "./eventIdentity.ts";

describe("sameEvent", () => {
  it("matches the current card when ESPN titles use different fighter detail", () => {
    expect(
      sameEvent(
        { id: "live-card", name: "UFC Fight Night: Medic vs. Rodriguez" },
        {
          id: "schedule-card",
          name: "UFC - UFC Fight Night: Daniel Rodriguez vs. Uroš Medic",
        },
      ),
    ).toBe(true);
  });

  it("does not merge a different card that shares the UFC prefix", () => {
    expect(
      sameEvent(
        { id: "one", name: "UFC Fight Night: Medic vs. Rodriguez" },
        { id: "two", name: "UFC Fight Night: Reyes vs. Volkov" },
      ),
    ).toBe(false);
  });

  it("uses the scheduled start time to classify an event", () => {
    expect(hasEventStarted("2026-07-29T12:00:00Z", Date.parse("2026-07-29T11:59:59Z"))).toBe(false);
    expect(hasEventStarted("2026-07-29T12:00:00Z", Date.parse("2026-07-29T12:00:00Z"))).toBe(true);
  });
});

describe("hasEventCompleted", () => {
  it("requires every bout to have a terminal fight status", () => {
    expect(hasEventCompleted([
      { status: "final" },
      { status: "canceled" },
      { status: "postponed" },
    ])).toBe(true);
    expect(hasEventCompleted([
      { status: "final" },
      { status: "between-rounds" },
    ])).toBe(false);
    expect(hasEventCompleted([{ status: "upcoming" }])).toBe(false);
    expect(hasEventCompleted([])).toBe(false);
  });
});

describe("selectFightTabBoutId", () => {
  it("prefers a fight currently in progress over any finished one", () => {
    expect(
      selectFightTabBoutId([
        { id: "prelim-1", cardPosition: 3, status: "final" },
        { id: "co-main", cardPosition: 2, status: "in-round" },
        { id: "main", cardPosition: 1, status: "upcoming" },
      ]),
    ).toBe("co-main");
  });

  it("prefers a fight between rounds over any finished one", () => {
    expect(
      selectFightTabBoutId([
        { id: "prelim-1", cardPosition: 3, status: "final" },
        { id: "co-main", cardPosition: 2, status: "between-rounds" },
        { id: "main", cardPosition: 1, status: "upcoming" },
      ]),
    ).toBe("co-main");
  });

  it("falls back to the most recently finished fight — lowest card position — when nothing is live", () => {
    expect(
      selectFightTabBoutId([
        { id: "prelim-1", cardPosition: 3, status: "final" },
        { id: "co-main", cardPosition: 2, status: "final" },
        { id: "main", cardPosition: 1, status: "upcoming" },
      ]),
    ).toBe("co-main");
  });

  it("returns undefined when nothing has started", () => {
    expect(
      selectFightTabBoutId([
        { id: "co-main", cardPosition: 2, status: "upcoming" },
        { id: "main", cardPosition: 1, status: "upcoming" },
      ]),
    ).toBeUndefined();
  });
});

describe("nextUpcomingEventId", () => {
  it("skips an old completed event that sorts before the real upcoming one", () => {
    expect(
      nextUpcomingEventId([
        { eventId: "old-completed", status: "completed" },
        { eventId: "next-up", status: "upcoming" },
      ]),
    ).toBe("next-up");
  });

  it("returns a live event ahead of a not-yet-started one", () => {
    expect(
      nextUpcomingEventId([
        { eventId: "old-completed", status: "completed" },
        { eventId: "tonight", status: "live" },
        { eventId: "next-week", status: "upcoming" },
      ]),
    ).toBe("tonight");
  });

  it("returns undefined when the whole schedule window is completed events", () => {
    expect(
      nextUpcomingEventId([
        { eventId: "old-1", status: "completed" },
        { eventId: "old-2", status: "completed" },
      ]),
    ).toBeUndefined();
  });
});

describe("isEventDay", () => {
  it("is true for any moment on the same calendar day as the event, before or after it starts", () => {
    expect(isEventDay("2026-07-29T22:00:00Z", Date.parse("2026-07-29T08:00:00Z"))).toBe(true);
    expect(isEventDay("2026-07-29T22:00:00Z", Date.parse("2026-07-29T23:59:00Z"))).toBe(true);
  });

  it("is false for a different calendar day", () => {
    expect(isEventDay("2026-07-29T22:00:00Z", Date.parse("2026-07-28T23:59:00Z"))).toBe(false);
    expect(isEventDay("2026-07-29T22:00:00Z", Date.parse("2026-07-30T00:00:01Z"))).toBe(false);
  });

  it("is false for an unparsable date", () => {
    expect(isEventDay("not-a-date", Date.parse("2026-07-29T08:00:00Z"))).toBe(false);
  });
});
