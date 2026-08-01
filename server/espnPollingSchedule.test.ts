import { describe, expect, it } from "vitest";

import {
  ESPN_EVENT_DAY_PRE_START_MS,
  ESPN_EVENT_IN_PROGRESS_MS,
  espnPollDelayMs,
  espnPollingTier,
} from "./espnPollingSchedule.ts";

describe("espnPollingTier", () => {
  it("is 'stopped' once the event is completed, regardless of anything else", () => {
    expect(
      espnPollingTier({
        now: new Date("2026-03-15T22:00:00.000Z"),
        eventStartsAt: new Date("2026-03-15T22:00:00.000Z"),
        eventInProgress: true,
        eventCompleted: true,
      }),
    ).toBe("stopped");
  });

  it("is 'event-in-progress' whenever any bout is live", () => {
    expect(
      espnPollingTier({
        now: new Date("2026-03-15T23:00:00.000Z"),
        eventStartsAt: new Date("2026-03-15T22:00:00.000Z"),
        eventInProgress: true,
        eventCompleted: false,
      }),
    ).toBe("event-in-progress");
  });

  it("is 'non-event-day' when eventStartsAt is unknown", () => {
    expect(
      espnPollingTier({
        now: new Date("2026-03-15T12:00:00.000Z"),
        eventStartsAt: undefined,
        eventInProgress: false,
        eventCompleted: false,
      }),
    ).toBe("non-event-day");
  });

  it("is 'event-day-pre-start' on the event's calendar day (ET) before it goes live", () => {
    // 2026-03-15 12:00 UTC is 2026-03-15 08:00 America/New_York (EDT, UTC-4).
    expect(
      espnPollingTier({
        now: new Date("2026-03-15T12:00:00.000Z"),
        eventStartsAt: new Date("2026-03-15T22:00:00.000Z"),
        eventInProgress: false,
        eventCompleted: false,
      }),
    ).toBe("event-day-pre-start");
  });

  it("is 'non-event-day' the day before the event, even close to midnight ET", () => {
    // 2026-03-15 03:00 UTC is 2026-03-14 23:00 America/New_York — still the day before.
    expect(
      espnPollingTier({
        now: new Date("2026-03-15T03:00:00.000Z"),
        eventStartsAt: new Date("2026-03-15T22:00:00.000Z"),
        eventInProgress: false,
        eventCompleted: false,
      }),
    ).toBe("non-event-day");
  });
});

describe("espnPollDelayMs", () => {
  it("returns null (stop polling) once completed", () => {
    expect(
      espnPollDelayMs({
        now: new Date(),
        eventStartsAt: undefined,
        eventInProgress: false,
        eventCompleted: true,
      }),
    ).toBeNull();
  });

  it("returns the 5s tier while in progress", () => {
    expect(
      espnPollDelayMs({
        now: new Date(),
        eventStartsAt: new Date(),
        eventInProgress: true,
        eventCompleted: false,
      }),
    ).toBe(ESPN_EVENT_IN_PROGRESS_MS);
  });

  it("returns the 60s tier on event day before start", () => {
    expect(
      espnPollDelayMs({
        now: new Date("2026-03-15T12:00:00.000Z"),
        eventStartsAt: new Date("2026-03-15T22:00:00.000Z"),
        eventInProgress: false,
        eventCompleted: false,
      }),
    ).toBe(ESPN_EVENT_DAY_PRE_START_MS);
  });

  it("returns time until the next 6a/6p ET slot on non-event days", () => {
    // 2026-03-15 12:00 UTC = 08:00 ET; next slot is 6:00pm ET = 22:00 UTC → 10h away.
    const delay = espnPollDelayMs({
      now: new Date("2026-03-15T12:00:00.000Z"),
      eventStartsAt: undefined,
      eventInProgress: false,
      eventCompleted: false,
    });
    expect(delay).toBe(10 * 60 * 60 * 1000);
  });
});
