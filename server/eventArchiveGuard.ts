/**
 * The single enforcement point for "once an event is archived, nothing
 * about it changes again." Every write path that touches `bouts`,
 * `fighters`, `round_stats`, or `commentary` for a given event must call
 * this first — trusting each call site to remember on its own is how this
 * kind of guarantee quietly rots.
 */
import { eq } from "drizzle-orm";

import type { AppDatabase } from "./db/client.ts";
import { events } from "./db/schema.ts";

export class EventArchivedError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`event "${eventId}" is archived and can no longer be written to`);
    this.name = "EventArchivedError";
    this.eventId = eventId;
  }
}

export async function assertEventNotArchived(
  db: AppDatabase,
  eventId: string,
): Promise<void> {
  const row = db
    .select({ archivedAt: events.archivedAt })
    .from(events)
    .where(eq(events.id, eventId))
    .get();
  if (row?.archivedAt) {
    throw new EventArchivedError(eventId);
  }
}
