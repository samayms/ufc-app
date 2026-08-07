/**
 * Writes the collector's in-memory DashboardState through to SQLite so it
 * survives process restarts and outlives the live in-memory view. Called
 * periodically while a live event is being collected (see
 * server/collector.ts's persistence tick) — nothing wrote to these tables
 * before this module existed.
 */
import { and, eq } from "drizzle-orm";

import type { AppDatabase } from "./db/client.ts";
import { bouts, boutParticipants, commentary, events, roundStats } from "./db/schema.ts";
import { EventArchivedError, assertEventNotArchived } from "./eventArchiveGuard.ts";
import { ensurePersonExists, recordFighterSnapshot } from "./fighterSnapshots.ts";
import type { Corner, DashboardState } from "../src/schema.ts";

function upsertEvent(db: AppDatabase, state: DashboardState, now: () => Date): void {
  const { event } = state;
  const existing = db.select({ id: events.id }).from(events).where(eq(events.id, event.id)).get();
  const values = {
    id: event.id,
    name: event.name,
    startTime: event.startsAt,
    venue: event.venue ?? null,
    city: event.city ?? null,
    updatedAt: now().toISOString(),
  };
  if (existing) {
    db.update(events).set(values).where(eq(events.id, event.id)).run();
  } else {
    db.insert(events).values(values).run();
  }
}

function upsertBout(db: AppDatabase, eventId: string, bout: DashboardState["event"]["bouts"][number], now: () => Date): void {
  const existing = db.select({ id: bouts.id }).from(bouts).where(eq(bouts.id, bout.id)).get();
  const values = {
    id: bout.id,
    eventId,
    cardPosition: bout.cardPosition,
    weightClass: bout.weightClass,
    status: bout.status,
    resultWinnerCorner: bout.result?.winner ?? null,
    resultMethod: bout.result?.method ?? null,
    resultRound: bout.result?.round ?? null,
    resultTime: bout.result?.time ?? null,
    scheduledRounds: bout.scheduledRounds,
    updatedAt: now().toISOString(),
  };
  if (existing) {
    db.update(bouts).set(values).where(eq(bouts.id, bout.id)).run();
  } else {
    db.insert(bouts).values(values).run();
  }
}

async function upsertParticipants(
  db: AppDatabase,
  bout: DashboardState["event"]["bouts"][number],
): Promise<void> {
  for (const corner of ["red", "blue"] as Corner[]) {
    const fighter = bout.fighters[corner];
    await ensurePersonExists(db, fighter);
    const existing = db
      .select({ id: boutParticipants.id })
      .from(boutParticipants)
      .where(and(eq(boutParticipants.boutId, bout.id), eq(boutParticipants.corner, corner)))
      .get();
    if (!existing) {
      db.insert(boutParticipants)
        .values({ boutId: bout.id, personId: fighter.id, corner })
        .run();
    }
  }
}

function upsertRoundStats(db: AppDatabase, boutId: string, state: DashboardState, now: () => Date): void {
  const view = state.boutViews[boutId];
  if (!view) return;
  for (const [source, updates] of Object.entries(view.rounds)) {
    for (const update of updates ?? []) {
      for (const corner of ["red", "blue"] as Corner[]) {
        const stats = update.stats?.[corner];
        if (!stats) continue;
        for (const [statName, statValue] of Object.entries(stats)) {
          if (statValue === undefined) continue;
          const existing = db
            .select({ id: roundStats.id })
            .from(roundStats)
            .where(
              and(
                eq(roundStats.boutId, boutId),
                eq(roundStats.round, update.round),
                eq(roundStats.corner, corner),
                eq(roundStats.statName, statName),
                eq(roundStats.source, source),
              ),
            )
            .get();
          const values = {
            boutId,
            round: update.round,
            corner,
            statName,
            statValue,
            source,
            fetchedAt: update.provenance.fetchedAt,
          };
          if (existing) {
            db.update(roundStats).set(values).where(eq(roundStats.id, existing.id)).run();
          } else {
            db.insert(roundStats).values(values).run();
          }
        }
      }
    }
  }
  void now;
}

export async function persistDashboardState(
  db: AppDatabase,
  state: DashboardState,
  now: () => Date = () => new Date(),
): Promise<void> {
  try {
    await assertEventNotArchived(db, state.event.id);
  } catch (error) {
    if (error instanceof EventArchivedError) {
      console.warn(`[eventPersistence] skipping archived event ${state.event.id}`);
      return;
    }
    throw error;
  }

  upsertEvent(db, state, now);

  for (const bout of state.event.bouts) {
    upsertBout(db, state.event.id, bout, now);
    await upsertParticipants(db, bout);
    for (const corner of ["red", "blue"] as Corner[]) {
      await recordFighterSnapshot(db, {
        eventId: state.event.id,
        boutId: bout.id,
        corner,
        fighter: bout.fighters[corner],
        boutIsUpcoming: bout.status === "upcoming",
        now,
      });
    }
    upsertRoundStats(db, bout.id, state, now);
  }
  void commentary; // commentary persistence follows the same upsert pattern; wired in Task 5 once the collector's commentary events are threaded through.
}
