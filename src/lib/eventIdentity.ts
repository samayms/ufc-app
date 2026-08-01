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
