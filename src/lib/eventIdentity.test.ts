import { describe, expect, it } from "vitest";
import { hasEventStarted, sameEvent } from "./eventIdentity.ts";

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
