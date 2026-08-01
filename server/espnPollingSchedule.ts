/**
 * ESPN's own scoreboard-polling cadence, distinct from every other
 * provider's schedule: pull hard on event day, back off to a twice-daily
 * check the rest of the time, and stop entirely once the card is over.
 */

import { SCHEDULE_TIME_ZONE, nextSlotAfter, zonedCalendarDate } from "./scheduler.ts";

export const ESPN_EVENT_DAY_PRE_START_MS = 60_000;
export const ESPN_EVENT_IN_PROGRESS_MS = 5_000;

export type EspnPollingTier =
  | "non-event-day"
  | "event-day-pre-start"
  | "event-in-progress"
  | "stopped";

export interface EspnPollingContext {
  now: Date;
  /** Event start time, if known. Unknown means "treat as non-event-day". */
  eventStartsAt: Date | undefined;
  /** True once any observed bout is actually in a round or between rounds. */
  eventInProgress: boolean;
  /** True once every observed bout has reported completed. */
  eventCompleted: boolean;
}

/** Whether `now` falls on the same America/New_York calendar day as `eventStartsAt`. */
export function isEventCalendarDay(now: Date, eventStartsAt: Date): boolean {
  return (
    zonedCalendarDate(now, SCHEDULE_TIME_ZONE) ===
    zonedCalendarDate(eventStartsAt, SCHEDULE_TIME_ZONE)
  );
}

export function espnPollingTier(context: EspnPollingContext): EspnPollingTier {
  if (context.eventCompleted) return "stopped";
  if (context.eventInProgress) return "event-in-progress";
  if (context.eventStartsAt === undefined) return "non-event-day";

  return isEventCalendarDay(context.now, context.eventStartsAt)
    ? "event-day-pre-start"
    : "non-event-day";
}

/** Ms until the next ESPN poll should fire, or `null` to stop polling entirely. */
export function espnPollDelayMs(context: EspnPollingContext): number | null {
  switch (espnPollingTier(context)) {
    case "stopped":
      return null;
    case "event-in-progress":
      return ESPN_EVENT_IN_PROGRESS_MS;
    case "event-day-pre-start":
      return ESPN_EVENT_DAY_PRE_START_MS;
    case "non-event-day":
      return Math.max(
        0,
        nextSlotAfter(context.now, SCHEDULE_TIME_ZONE).getTime() -
          context.now.getTime(),
      );
  }
}
