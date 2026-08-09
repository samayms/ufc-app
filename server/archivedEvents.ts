/**
 * Reads a permanently-archived event back out of SQLite in the same
 * DashboardState shape the live collector serves from memory, so the
 * client's existing bout-view rendering works unmodified against either
 * source. See server/collector.ts's getBootstrap() for the live analog.
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";

import type { AppDatabase } from "./db/client.ts";
import { bouts, events, externalRefs, fighters, people, roundStats } from "./db/schema.ts";
import type { Storage } from "./storage.ts";
import {
  UNIFIED_ROUNDS_STORAGE_STREAM,
  type UnifiedRoundRecord,
} from "./roundStats.ts";
import { MARKET_SNAPSHOTS_STORAGE_STREAM } from "./tickStore.ts";
import type { MarketSnapshot } from "../src/sources/contract.ts";
import type {
  BoutStatus,
  BoutView,
  Corner,
  DashboardState,
  ExternalRef,
  Fighter,
  FinishMethod,
  RoundStats,
  RoundUpdate,
  SourceId,
  WeightClass,
} from "../src/schema.ts";

export interface ArchivedEventSummary {
  id: string;
  name: string;
  startsAt: string;
  archivedAt: string;
}

export interface ArchivedEventSnapshot extends DashboardState {
  unifiedRounds: UnifiedRoundRecord[];
  marketSnapshots: MarketSnapshot[];
}

const COLLECTOR_STATE_STREAM = "collector-state";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function persistedDashboardState(value: unknown): DashboardState | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.state)) {
    return undefined;
  }
  const state = value.state;
  return isRecord(state.event) &&
      typeof state.event.id === "string" &&
      Array.isArray(state.event.bouts) &&
      isRecord(state.boutViews)
    ? state as unknown as DashboardState
    : undefined;
}

function persistedUnifiedRound(value: unknown): UnifiedRoundRecord | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.record)) {
    return undefined;
  }
  const record = value.record;
  return typeof record.boutId === "string" &&
      Number.isSafeInteger(record.round) &&
      isRecord(record.marketAtEnd)
    ? record as unknown as UnifiedRoundRecord
    : undefined;
}

const MARKET_SOURCES = new Set([
  "kalshi", "polymarket", "odds-api-io", "the-odds-api",
]);

function persistedPreFightMarketSnapshot(
  value: unknown,
): MarketSnapshot | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.snapshot)) {
    return undefined;
  }
  const snapshot = value.snapshot;
  if (
    !MARKET_SOURCES.has(String(snapshot.source)) ||
    typeof snapshot.boutId !== "string" ||
    snapshot.round !== 0 ||
    snapshot.boundaryType !== "pre-fight" ||
    typeof snapshot.takenAt !== "string" ||
    typeof snapshot.fresh !== "boolean" ||
    !Array.isArray(snapshot.outcomes) ||
    !snapshot.outcomes.every((outcome) =>
      isRecord(outcome) &&
      typeof outcome.marketType === "string" &&
      typeof outcome.outcome === "string" &&
      typeof outcome.receivedAt === "string" &&
      typeof outcome.stale === "boolean"
    )
  ) {
    return undefined;
  }
  return snapshot as unknown as MarketSnapshot;
}

function terminalArchiveStatus(status: BoutStatus): BoutStatus {
  return status === "canceled" || status === "postponed" ? status : "final";
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

const ARCHIVED_REF_SOURCES: ReadonlySet<string> = new Set([
  "espn", "kalshi", "polymarket", "odds-api-io", "odds-api", "cito", "sherdog",
]);

function refsFor(
  db: AppDatabase,
  entityType: "event" | "bout" | "person",
  entityId: string,
): ExternalRef[] {
  return db.select({ source: externalRefs.source, id: externalRefs.externalId })
    .from(externalRefs)
    .where(and(
      eq(externalRefs.entityType, entityType),
      eq(externalRefs.entityId, entityId),
    ))
    .all()
    .flatMap((ref) =>
      ref.id.length > 0 && ARCHIVED_REF_SOURCES.has(ref.source)
        ? [{ source: ref.source as SourceId, id: ref.id }]
        : [],
    );
}

function toFighter(row: typeof fighters.$inferSelect, name: string, refs: Fighter["externalRefs"]): Fighter {
  return {
    id: row.personId,
    externalRefs: refs,
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
    const redPerson = db.select({ name: people.name }).from(people)
      .where(eq(people.id, redRow.personId)).get();
    const bluePerson = db.select({ name: people.name }).from(people)
      .where(eq(people.id, blueRow.personId)).get();

    const bout = {
      id: boutRow.id,
      externalRefs: refsFor(db, "bout", boutRow.id),
      eventId,
      cardPosition: boutRow.cardPosition ?? 0,
      segment: "main-card" as const,
      weightClass: (boutRow.weightClass ?? "catchweight") as WeightClass,
      scheduledRounds: (boutRow.scheduledRounds ?? 3) as 3 | 5,
      titleFight: false,
      fighters: {
        red: toFighter(redRow, redPerson?.name ?? redRow.personId, refsFor(db, "person", redRow.personId)),
        blue: toFighter(blueRow, bluePerson?.name ?? blueRow.personId, refsFor(db, "person", blueRow.personId)),
      },
      // An archived event is immutable review data. ESPN can leave stale
      // `upcoming`/`between-rounds` rows behind when rotation happens, but
      // replaying those statuses hides the Fight/Stats review UI.
      status: terminalArchiveStatus(boutRow.status as BoutStatus),
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
      externalRefs: refsFor(db, "event", eventRow.id),
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

/**
 * Combines SQLite's immutable archive marker/results with the last rich
 * collector snapshot and its finalized round records. SQLite remains the
 * authority for whether an event is archived; the JSONL streams restore the
 * fields that deliberately do not fit its normalized tables (recent form,
 * outlook, round summaries, and market-at-end snapshots).
 */
export async function loadArchivedEventSnapshot(
  db: AppDatabase,
  eventId: string,
  storage: Storage,
): Promise<ArchivedEventSnapshot | undefined> {
  const databaseState = await loadArchivedEvent(db, eventId);
  if (databaseState === undefined) return undefined;

  const [stateRecords, roundRecords, marketRecords] = await Promise.all([
    storage.read<unknown>(COLLECTOR_STATE_STREAM),
    storage.read<unknown>(UNIFIED_ROUNDS_STORAGE_STREAM),
    storage.read<unknown>(MARKET_SNAPSHOTS_STORAGE_STREAM),
  ]);
  const persistedState = stateRecords
    .map(persistedDashboardState)
    .filter((state): state is DashboardState => state?.event.id === eventId)
    .at(-1);

  const databaseBouts = new Map(
    databaseState.event.bouts.map((bout) => [bout.id, bout]),
  );
  const sourceState = persistedState ?? databaseState;
  const archivedBouts = sourceState.event.bouts.map((bout) => {
    const databaseBout = databaseBouts.get(bout.id);
    return {
      ...bout,
      status: terminalArchiveStatus(databaseBout?.status ?? bout.status),
      ...(databaseBout?.result === undefined
        ? {}
        : { result: databaseBout.result }),
    };
  });
  const sourceBoutIds = new Set(archivedBouts.map((bout) => bout.id));
  archivedBouts.push(
    ...databaseState.event.bouts.filter((bout) => !sourceBoutIds.has(bout.id)),
  );
  const archivedBoutIds = new Set(archivedBouts.map((bout) => bout.id));
  const boutViews: DashboardState["boutViews"] = {};
  for (const bout of archivedBouts) {
    const persistedView = sourceState.boutViews[bout.id];
    const databaseView = databaseState.boutViews[bout.id];
    const view = persistedView ?? databaseView;
    if (view === undefined) continue;
    boutViews[bout.id] = {
      ...(databaseView ?? view),
      ...view,
      bout,
      rounds: {
        ...(databaseView?.rounds ?? {}),
        ...view.rounds,
      },
    };
  }

  // The stream is append-only and can contain revisions. Map assignment
  // keeps the newest valid record for each bout/round pair.
  const latestRounds = new Map<string, UnifiedRoundRecord>();
  for (const persisted of roundRecords) {
    const record = persistedUnifiedRound(persisted);
    if (record === undefined || !archivedBoutIds.has(record.boutId)) continue;
    latestRounds.set(`${record.boutId}:${record.round}`, record);
  }
  const latestMarkets = new Map<string, MarketSnapshot>();
  for (const persisted of marketRecords) {
    const snapshot = persistedPreFightMarketSnapshot(persisted);
    if (snapshot === undefined || !archivedBoutIds.has(snapshot.boutId)) continue;
    latestMarkets.set(`${snapshot.boutId}:${snapshot.round}:${snapshot.source}:${snapshot.boundaryType}`, snapshot);
  }

  return {
    ...sourceState,
    event: {
      ...sourceState.event,
      id: databaseState.event.id,
      name: databaseState.event.name,
      startsAt: databaseState.event.startsAt,
      bouts: archivedBouts,
      externalRefs: sourceState.event.externalRefs.length > 0
        ? sourceState.event.externalRefs
        : databaseState.event.externalRefs,
    },
    boutViews,
    unifiedRounds: [...latestRounds.values()].sort(
      (left, right) =>
        left.boutId.localeCompare(right.boutId) || left.round - right.round,
    ),
    marketSnapshots: [...latestMarkets.values()],
  };
}
