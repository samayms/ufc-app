import { describe, expect, it } from "vitest";
import {
  OUTLOOK_WINDOW_LEAD_MS,
  hasEventStarted,
  isOutlookWindowOpen,
  msUntilOutlookWindowOpens,
} from "./sherdogOutlookSchedule.ts";

const startsAt = "2026-08-01T17:00:00.000Z";

describe("Sherdog outlook watcher scheduling", () => {
  it("computes ms until the window opens, 3 days before the event", () => {
    const fourDaysBefore = "2026-07-28T17:00:00.000Z";
    expect(msUntilOutlookWindowOpens(new Date(fourDaysBefore), startsAt)).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(OUTLOOK_WINDOW_LEAD_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it("reports the window closed before it opens", () => {
    expect(isOutlookWindowOpen(new Date("2026-07-28T17:00:00.000Z"), startsAt)).toBe(
      false,
    );
  });

  it("reports the window open once inside 3 days of the event", () => {
    expect(isOutlookWindowOpen(new Date("2026-07-30T00:00:00.000Z"), startsAt)).toBe(
      true,
    );
  });

  it("reports the window open exactly at the event start", () => {
    expect(isOutlookWindowOpen(new Date(startsAt), startsAt)).toBe(true);
  });

  it("reports the event has not started while still before startsAt", () => {
    expect(hasEventStarted(new Date("2026-07-31T00:00:00.000Z"), startsAt)).toBe(
      false,
    );
  });

  it("reports the event has started at or after startsAt", () => {
    expect(hasEventStarted(new Date(startsAt), startsAt)).toBe(true);
    expect(
      hasEventStarted(new Date("2026-08-01T18:00:00.000Z"), startsAt),
    ).toBe(true);
  });
});
