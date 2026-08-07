/**
 * Permanently freezes events 24h after their last bout goes final. Modeled
 * on UpcomingScheduler (server/scheduler.ts) — same injectable clock/db,
 * same "one sweep is idempotent, safe to retry" contract.
 */
import { eq, isNull } from "drizzle-orm";

import { getDb, type AppDatabase } from "./db/client.ts";
import { bouts, events } from "./db/schema.ts";

export const ARCHIVE_DELAY_MS = 24 * 60 * 60 * 1000;
const FINAL_STATUSES = new Set(["final", "canceled", "postponed"]);

export interface EventArchiverOptions {
  db?: AppDatabase;
  now?: () => Date;
  onLog?: (message: string) => void;
}

export class EventArchiver {
  private readonly db: AppDatabase;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: EventArchiverOptions = {}) {
    this.db = options.db ?? getDb();
    this.now = options.now ?? (() => new Date());
    this.log = options.onLog ?? ((message) => console.log(`[archiver] ${message}`));
  }

  async sweepOnce(): Promise<{ archived: string[] }> {
    const archived: string[] = [];
    const candidates = this.db
      .select({ id: events.id })
      .from(events)
      .where(isNull(events.archivedAt))
      .all();

    for (const candidate of candidates) {
      const eventBouts = this.db
        .select({ status: bouts.status, updatedAt: bouts.updatedAt })
        .from(bouts)
        .where(eq(bouts.eventId, candidate.id))
        .all();

      if (eventBouts.length === 0) continue;
      if (!eventBouts.every((bout) => FINAL_STATUSES.has(bout.status))) continue;

      const lastUpdatedAt = Math.max(...eventBouts.map((bout) => Date.parse(bout.updatedAt)));
      if (this.now().getTime() - lastUpdatedAt < ARCHIVE_DELAY_MS) continue;

      this.db
        .update(events)
        .set({ archivedAt: this.now().toISOString() })
        .where(eq(events.id, candidate.id))
        .run();
      archived.push(candidate.id);
      this.log(`archived event ${candidate.id}`);
    }

    return { archived };
  }

  start(intervalMs: number = 60 * 60 * 1000): void {
    this.timer = setInterval(() => {
      void this.sweepOnce().catch((error) => this.log(`sweep failed: ${String(error)}`));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
