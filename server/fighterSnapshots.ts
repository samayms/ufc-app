/**
 * Persists a fighter's record/rank/bio exactly as they stood going into one
 * specific bout. One row per (bout, person) — the same fighter has a
 * different row for every bout they've fought, by design (see
 * docs/superpowers/specs/2026-08-07-immutable-event-archive-design.md).
 *
 * The row is written freely while the bout is still upcoming (so a late
 * ESPN correction before fight night is reflected), then locked forever the
 * first time the caller reports the bout is no longer upcoming. Once
 * locked, this module refuses to touch the row again — that's the whole
 * point.
 */
import { and, eq } from "drizzle-orm";

import type { AppDatabase } from "./db/client.ts";
import { fighters, people } from "./db/schema.ts";
import { assertEventNotArchived } from "./eventArchiveGuard.ts";
import type { Corner, Fighter } from "../src/schema.ts";

export async function ensurePersonExists(
  db: AppDatabase,
  fighter: Fighter,
): Promise<void> {
  const existing = db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.id, fighter.id))
    .get();
  if (existing) {
    db.update(people)
      .set({ name: fighter.name, updatedAt: new Date().toISOString() })
      .where(eq(people.id, fighter.id))
      .run();
    return;
  }
  db.insert(people).values({ id: fighter.id, name: fighter.name }).run();
}

export async function recordFighterSnapshot(
  db: AppDatabase,
  params: {
    eventId: string;
    boutId: string;
    corner: Corner;
    fighter: Fighter;
    boutIsUpcoming: boolean;
    now?: () => Date;
  },
): Promise<void> {
  const now = params.now ?? (() => new Date());
  await assertEventNotArchived(db, params.eventId);

  const existing = db
    .select()
    .from(fighters)
    .where(
      and(eq(fighters.boutId, params.boutId), eq(fighters.personId, params.fighter.id)),
    )
    .get();
  if (existing?.lockedAt) return;

  await ensurePersonExists(db, params.fighter);

  const values = {
    boutId: params.boutId,
    personId: params.fighter.id,
    corner: params.corner,
    nickname: params.fighter.nickname ?? null,
    stance: params.fighter.stance ?? null,
    heightCm: params.fighter.heightCm ?? null,
    reachCm: params.fighter.reachCm ?? null,
    country: params.fighter.country ?? null,
    wins: params.fighter.record.wins,
    losses: params.fighter.record.losses,
    draws: params.fighter.record.draws,
    noContests: params.fighter.record.noContests,
    ranking: params.fighter.ranking ?? null,
    lockedAt: params.boutIsUpcoming ? null : now().toISOString(),
    updatedAt: now().toISOString(),
  };

  if (existing) {
    db.update(fighters).set(values).where(eq(fighters.id, existing.id)).run();
  } else {
    db.insert(fighters).values(values).run();
  }
}
