import type { BoutStatus } from "../schema.ts";

const EVENT_STOP_WORDS = new Set([
  "ufc",
  "fight",
  "night",
  "event",
  "the",
  "ultimate",
  "championship",
  "versus",
  "vs",
]);

function eventTokens(name: string): Set<string> {
  return new Set(
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/gu, "")
      .toLocaleLowerCase("en-US")
      .replace(/[^a-z0-9]+/gu, " ")
      .trim()
      .split(/\s+/u)
      .filter((token) => token.length > 1 && !EVENT_STOP_WORDS.has(token)),
  );
}

/** True when two schedule entries represent the same card, even when ESPN
 * uses a short title in one endpoint and full fighter names in another. */
export function sameEvent(
  left: { id: string; name: string },
  right: { id: string; name: string },
): boolean {
  if (left.id === right.id) return true;
  const leftTokens = eventTokens(left.name);
  const rightTokens = eventTokens(right.name);
  if (leftTokens.size < 2 || rightTokens.size < 2) return false;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap >= 2;
}

export function hasEventStarted(
  startsAt: string,
  now: number = Date.now(),
): boolean {
  const startsAtMs = Date.parse(startsAt);
  return Number.isFinite(startsAtMs) && now >= startsAtMs;
}

const TERMINAL_BOUT_STATUSES = new Set<BoutStatus>([
  "final",
  "canceled",
  "postponed",
]);

/** A card is complete only when ESPN has resolved every scheduled bout. */
export function hasEventCompleted(
  bouts: readonly { status: BoutStatus }[],
): boolean {
  return bouts.length > 0 && bouts.every((bout) =>
    TERMINAL_BOUT_STATUSES.has(bout.status)
  );
}

/**
 * The nearest non-completed event's id out of `listUpcomingEvents()`'s
 * result — which spans a wide past+future window (see espnSchedule.ts's
 * SCHEDULE_LOOKBACK_DAYS, kept for the Past events tab) sorted ascending by
 * start date, so an old completed card can sort before the real
 * current/upcoming one. `undefined` when nothing on the schedule is
 * upcoming or live.
 */
export function nextUpcomingEventId(
  events: readonly { eventId: string; status: "upcoming" | "live" | "completed" }[],
): string | undefined {
  return events.find((event) => event.status !== "completed")?.eventId;
}

const LIVE_BOUT_STATUSES = new Set<BoutStatus>(["in-round", "between-rounds"]);

/**
 * Which bout the bottom nav's Fight tab should jump to: whichever bout is
 * live right now (in-round or between-rounds) if one exists, else whichever
 * finished most recently. The card airs from the highest `cardPosition` down
 * to the main event (`cardPosition` 1), so among either group the lowest
 * `cardPosition` is the one currently airing or the last one to finish.
 * `undefined` when nothing on the card has started yet — the caller keeps
 * showing whatever it already had.
 */
export function selectFightTabBoutId(
  bouts: readonly { id: string; cardPosition: number; status: BoutStatus }[],
): string | undefined {
  const live = bouts
    .filter((bout) => LIVE_BOUT_STATUSES.has(bout.status))
    .sort((a, b) => a.cardPosition - b.cardPosition)[0];
  if (live) return live.id;

  const mostRecentlyFinished = bouts
    .filter((bout) => bout.status === "final")
    .sort((a, b) => a.cardPosition - b.cardPosition)[0];
  return mostRecentlyFinished?.id;
}

/** True when `startsAt` falls on the same calendar day as `now`, in the
 * viewer's local time zone. Used to gate same-day-only display rules (e.g.
 * hiding a provider that only misbehaves on the day of the event) — distinct
 * from `hasEventStarted`, which cares about the instant, not the date. */
export function isEventDay(startsAt: string, now: number = Date.now()): boolean {
  const startsAtMs = Date.parse(startsAt);
  if (!Number.isFinite(startsAtMs)) return false;
  const eventDate = new Date(startsAtMs);
  const nowDate = new Date(now);
  return (
    eventDate.getUTCFullYear() === nowDate.getUTCFullYear() &&
    eventDate.getUTCMonth() === nowDate.getUTCMonth() &&
    eventDate.getUTCDate() === nowDate.getUTCDate()
  );
}
