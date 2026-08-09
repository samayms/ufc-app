/**
 * Permanently freezes events after their card is complete or a newer event
 * has superseded them. Modeled on UpcomingScheduler (server/scheduler.ts) —
 * same injectable clock/db, same "one sweep is idempotent, safe to retry"
 * contract.
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

export interface ArchiveSweepOptions {
  /** Current live card is never frozen by a rotation/backfill sweep. */
  excludeEventId?: string;
  /** Rotation has superseded the card, so the normal review delay is unnecessary. */
  immediate?: boolean;
  /** Archive older cards superseded by the current event even if their final
   * ESPN bout statuses were never refreshed after rotation. */
  supersededBefore?: string;
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

  async sweepOnce(options: ArchiveSweepOptions = {}): Promise<{ archived: string[] }> {
    const archived: string[] = [];
    const candidates = this.db
      .select({ id: events.id, startTime: events.startTime })
      .from(events)
      .where(isNull(events.archivedAt))
      .all();

    for (const candidate of candidates) {
      if (candidate.id === options.excludeEventId) continue;
      const eventBouts = this.db
        .select({
          status: bouts.status,
          resultWinnerCorner: bouts.resultWinnerCorner,
          updatedAt: bouts.updatedAt,
        })
        .from(bouts)
        .where(eq(bouts.eventId, candidate.id))
        .all();

      if (eventBouts.length === 0) continue;
      // A winner, draw, or no-contest is the minimum durable evidence needed
      // for every fought bout. This also permits a stale lifecycle label to
      // be archived once its results are known, without turning an unknown
      // result into a permanent fake final.
      if (!eventBouts.every((bout) =>
        bout.status === "canceled" ||
        bout.status === "postponed" ||
        bout.resultWinnerCorner !== null
      )) continue;
      const superseded = options.supersededBefore !== undefined &&
        candidate.startTime !== null &&
        Date.parse(candidate.startTime) < Date.parse(options.supersededBefore);
      if (superseded) {
        this.db.update(events).set({ archivedAt: this.now().toISOString() })
          .where(eq(events.id, candidate.id)).run();
        archived.push(candidate.id);
        this.log(`archived superseded event ${candidate.id}`);
        continue;
      }
      if (!eventBouts.every((bout) => FINAL_STATUSES.has(bout.status))) continue;
      // "final" without a winner/draw/no-contest is an ESPN intermediate
      // payload, not immutable review data. In particular, rotation used to
      // freeze exactly that incomplete state and the archive guard then made
      // the real result impossible to persist.
      if (!eventBouts.every((bout) =>
        bout.status !== "final" || bout.resultWinnerCorner !== null
      )) continue;

      const lastUpdatedAt = Math.max(...eventBouts.map((bout) => Date.parse(bout.updatedAt)));
      if (!options.immediate && this.now().getTime() - lastUpdatedAt < ARCHIVE_DELAY_MS) continue;

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
