/**
 * Reads a permanently-archived event back out of SQLite in the same
 * DashboardState shape the live collector serves from memory, so the
 * client's existing bout-view rendering works unmodified against either
 * source. See server/collector.ts's getBootstrap() for the live analog.
 */
import { desc, eq, isNotNull } from "drizzle-orm";

import type { AppDatabase } from "./db/client.ts";
import { bouts, events, fighters, roundStats } from "./db/schema.ts";
import type {
  BoutStatus,
  BoutView,
  Corner,
  DashboardState,
  Fighter,
  FinishMethod,
  RoundStats,
  RoundUpdate,
  WeightClass,
} from "../src/schema.ts";

export interface ArchivedEventSummary {
  id: string;
  name: string;
  startsAt: string;
  archivedAt: string;
}

export async function listArchivedEvents(
  db: AppDatabase,
): Promise<ArchivedEventSummary[]> {
  return db
    .select({
      id: events.id,
      name: events.name,
      startsAt: events.startTime,
      archivedAt: events.archivedAt,
    })
    .from(events)
    .where(isNotNull(events.archivedAt))
    .orderBy(desc(events.archivedAt))
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      startsAt: row.startsAt ?? "",
      archivedAt: row.archivedAt as string,
    }));
}

function toFighter(row: typeof fighters.$inferSelect, name: string): Fighter {
  return {
    id: row.personId,
    externalRefs: [],
    name,
    ...(row.nickname ? { nickname: row.nickname } : {}),
    record: { wins: row.wins, losses: row.losses, draws: row.draws, noContests: row.noContests },
    ...(row.stance ? { stance: row.stance } : {}),
    ...(row.heightCm !== null ? { heightCm: row.heightCm } : {}),
    ...(row.reachCm !== null ? { reachCm: row.reachCm } : {}),
    ...(row.country ? { country: row.country } : {}),
    ...(row.ranking ? { ranking: row.ranking } : {}),
    provenance: { source: "espn", fetchedAt: row.updatedAt, synthetic: false },
  };
}

export async function loadArchivedEvent(
  db: AppDatabase,
  eventId: string,
): Promise<DashboardState | undefined> {
  const eventRow = db.select().from(events).where(eq(events.id, eventId)).get();
  if (!eventRow?.archivedAt) return undefined;

  const boutRows = db.select().from(bouts).where(eq(bouts.eventId, eventId)).all();
  const boutViews: Record<string, BoutView> = {};
  const boutsOut: DashboardState["event"]["bouts"] = [];

  for (const boutRow of boutRows) {
    const fighterRows = db.select().from(fighters).where(eq(fighters.boutId, boutRow.id)).all();
    const redRow = fighterRows.find((row) => row.corner === "red");
    const blueRow = fighterRows.find((row) => row.corner === "blue");
    if (!redRow || !blueRow) continue;

    const bout = {
      id: boutRow.id,
      externalRefs: [],
      eventId,
      cardPosition: boutRow.cardPosition ?? 0,
      segment: "main-card" as const,
      weightClass: (boutRow.weightClass ?? "catchweight") as WeightClass,
      scheduledRounds: (boutRow.scheduledRounds ?? 3) as 3 | 5,
      titleFight: false,
      fighters: {
        red: toFighter(redRow, redRow.personId),
        blue: toFighter(blueRow, blueRow.personId),
      },
      status: (boutRow.status as BoutStatus) ?? "final",
      ...(boutRow.resultWinnerCorner
        ? {
            result: {
              winner: boutRow.resultWinnerCorner as Corner | "draw" | "nc",
              method: (boutRow.resultMethod as FinishMethod) ?? "other",
              ...(boutRow.resultRound !== null ? { round: boutRow.resultRound } : {}),
              ...(boutRow.resultTime ? { time: boutRow.resultTime } : {}),
            },
          }
        : {}),
      provenance: { source: "espn" as const, fetchedAt: boutRow.updatedAt, synthetic: false },
    };
    boutsOut.push(bout);

    const statRows = db.select().from(roundStats).where(eq(roundStats.boutId, boutRow.id)).all();
    const roundsBySource: Record<string, Map<number, RoundUpdate>> = {};
    for (const statRow of statRows) {
      const bySource = (roundsBySource[statRow.source] ??= new Map());
      const roundUpdate = bySource.get(statRow.round) ?? {
        boutId: boutRow.id,
        round: statRow.round,
        stats: {},
        provenance: { source: statRow.source as DashboardState["event"]["provenance"]["source"], fetchedAt: statRow.fetchedAt, synthetic: false },
      };
      const corner = statRow.corner as Corner;
      roundUpdate.stats = roundUpdate.stats ?? {};
      roundUpdate.stats[corner] = {
        ...(roundUpdate.stats[corner] ?? {}),
        [statRow.statName]: statRow.statValue,
      } as RoundStats;
      bySource.set(statRow.round, roundUpdate);
    }
    const rounds: BoutView["rounds"] = {};
    for (const [source, map] of Object.entries(roundsBySource)) {
      rounds[source as keyof BoutView["rounds"]] = [...map.values()].sort((a, b) => a.round - b.round);
    }

    boutViews[boutRow.id] = {
      bout,
      rounds,
      latestOdds: {},
      oddsHistory: {},
      marketMoves: {},
      preFightOdds: {},
    };
  }

  return {
    event: {
      id: eventRow.id,
      externalRefs: [],
      name: eventRow.name,
      startsAt: eventRow.startTime ?? "",
      ...(eventRow.venue ? { venue: eventRow.venue } : {}),
      ...(eventRow.city ? { city: eventRow.city } : {}),
      bouts: boutsOut,
      provenance: { source: "espn", fetchedAt: eventRow.updatedAt, synthetic: false },
    },
    boutViews,
  };
}
