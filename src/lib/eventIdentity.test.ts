import { describe, expect, it } from "vitest";
import { hasEventStarted, isEventDay, sameEvent } from "./eventIdentity.ts";

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
