/**
 * Drizzle schema for the SQLite-backed persistence layer.
 *
 * This is the *only* place table shapes are defined. Providers and
 * pipelines import from `./client.ts`, never open their own connection,
 * and never issue raw DDL outside checked-in migrations.
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// People / fighters
// ---------------------------------------------------------------------------

export const people = sqliteTable("people", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(current_timestamp)`),
});

export const fighters = sqliteTable("fighters", {
  personId: text("person_id")
    .primaryKey()
    .references(() => people.id, { onDelete: "cascade" }),
  nickname: text("nickname"),
  stance: text("stance"),
  heightCm: real("height_cm"),
  reachCm: real("reach_cm"),
  country: text("country"),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  draws: integer("draws").notNull().default(0),
  noContests: integer("no_contests").notNull().default(0),
  ranking: text("ranking"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(current_timestamp)`),
});

export const aliases = sqliteTable(
  "aliases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    source: text("source"),
  },
  (table) => [
    unique("aliases_person_alias_unique").on(table.personId, table.alias),
    index("aliases_person_id_idx").on(table.personId),
  ],
);

// ---------------------------------------------------------------------------
// External identifiers / media
// ---------------------------------------------------------------------------

export const externalRefs = sqliteTable(
  "external_refs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityType: text("entity_type").notNull(), // 'person' | 'event' | 'bout'
    entityId: text("entity_id").notNull(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
  },
  (table) => [
    unique("external_refs_source_external_id_unique").on(
      table.entityType,
      table.source,
      table.externalId,
    ),
    index("external_refs_entity_idx").on(table.entityType, table.entityId),
  ],
);

/** Pointers to external media only — never image bytes. */
export const mediaAssets = sqliteTable(
  "media_assets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    kind: text("kind").notNull(), // 'headshot' | 'poster' | ...
    url: text("url").notNull(),
    source: text("source"),
    fetchedAt: text("fetched_at").notNull(),
  },
  (table) => [
    unique("media_assets_entity_kind_unique").on(
      table.entityType,
      table.entityId,
      table.kind,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Events / bouts
// ---------------------------------------------------------------------------

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  startTime: text("start_time"),
  venue: text("venue"),
  city: text("city"),
  country: text("country"),
  status: text("status"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(current_timestamp)`),
});

export const bouts = sqliteTable(
  "bouts",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    cardPosition: integer("card_position"),
    weightClass: text("weight_class"),
    status: text("status").notNull().default("upcoming"),
    resultWinnerCorner: text("result_winner_corner"),
    resultMethod: text("result_method"),
    resultRound: integer("result_round"),
    resultTime: text("result_time"),
    scheduledRounds: integer("scheduled_rounds"),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [index("bouts_event_id_idx").on(table.eventId)],
);

export const boutParticipants = sqliteTable(
  "bout_participants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    boutId: text("bout_id")
      .notNull()
      .references(() => bouts.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    corner: text("corner").notNull(), // 'red' | 'blue'
  },
  (table) => [
    unique("bout_participants_bout_corner_unique").on(
      table.boutId,
      table.corner,
    ),
    index("bout_participants_person_id_idx").on(table.personId),
  ],
);

// ---------------------------------------------------------------------------
// Provider markets / mappings / freshness
// ---------------------------------------------------------------------------

export const providerMarkets = sqliteTable(
  "provider_markets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(),
    marketId: text("market_id").notNull(), // provider-native id
    boutId: text("bout_id").references(() => bouts.id, {
      onDelete: "set null",
    }),
    corner: text("corner"),
    kind: text("kind"), // 'moneyline' | ...
    volumeUsd: real("volume_usd"),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    unique("provider_markets_source_market_unique").on(
      table.source,
      table.marketId,
    ),
    index("provider_markets_bout_id_idx").on(table.boutId),
  ],
);

/** Provider-native bout key -> our canonical (ESPN-rooted) bout id. */
export const boutMappings = sqliteTable(
  "bout_mappings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(),
    providerBoutKey: text("provider_bout_key").notNull(),
    espnBoutId: text("espn_bout_id")
      .notNull()
      .references(() => bouts.id, { onDelete: "cascade" }),
    confidence: real("confidence"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    unique("bout_mappings_source_key_unique").on(
      table.source,
      table.providerBoutKey,
    ),
    index("bout_mappings_espn_bout_id_idx").on(table.espnBoutId),
  ],
);

export const providerState = sqliteTable("provider_state", {
  source: text("source").primaryKey(),
  status: text("status").notNull(), // 'ok' | 'degraded' | 'down'
  lastSuccessAt: text("last_success_at"),
  lastErrorAt: text("last_error_at"),
  lastError: text("last_error"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(current_timestamp)`),
});

/** Latest known price per (bout, corner, source) — overwritten in place. */
export const latestMarketState = sqliteTable(
  "latest_market_state",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    boutId: text("bout_id")
      .notNull()
      .references(() => bouts.id, { onDelete: "cascade" }),
    corner: text("corner").notNull(),
    source: text("source").notNull(),
    americanOdds: integer("american_odds"),
    impliedProbability: real("implied_probability"),
    devigProbability: real("devig_probability"),
    volumeUsd: real("volume_usd"),
    synthetic: integer("synthetic", { mode: "boolean" })
      .notNull()
      .default(false),
    fetchedAt: text("fetched_at").notNull(),
  },
  (table) => [
    unique("latest_market_state_bout_corner_source_unique").on(
      table.boutId,
      table.corner,
      table.source,
    ),
    index("latest_market_state_bout_id_idx").on(table.boutId),
  ],
);

/** One row per upcoming-sync run; payload is the full merged document. */
export const upcomingOddsSnapshots = sqliteTable(
  "upcoming_odds_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    syncRunId: integer("sync_run_id").references(() => syncRuns.id, {
      onDelete: "set null",
    }),
    eventId: text("event_id"),
    payload: text("payload").notNull(), // JSON
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [index("upcoming_odds_snapshots_event_id_idx").on(table.eventId)],
);

// ---------------------------------------------------------------------------
// Round stats / commentary
// ---------------------------------------------------------------------------

export const roundStats = sqliteTable(
  "round_stats",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    boutId: text("bout_id")
      .notNull()
      .references(() => bouts.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    corner: text("corner").notNull(),
    statName: text("stat_name").notNull(),
    statValue: real("stat_value"),
    source: text("source").notNull(),
    fetchedAt: text("fetched_at").notNull(),
  },
  (table) => [
    unique("round_stats_unique").on(
      table.boutId,
      table.round,
      table.corner,
      table.statName,
      table.source,
    ),
    index("round_stats_bout_id_idx").on(table.boutId),
  ],
);

export const commentary = sqliteTable(
  "commentary",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    boutId: text("bout_id").references(() => bouts.id, {
      onDelete: "cascade",
    }),
    round: integer("round"),
    source: text("source").notNull(),
    author: text("author"),
    body: text("body").notNull(),
    postId: text("post_id"),
    postedAt: text("posted_at"),
  },
  (table) => [
    unique("commentary_source_post_unique").on(table.source, table.postId),
    index("commentary_bout_id_idx").on(table.boutId),
  ],
);

// ---------------------------------------------------------------------------
// Sync runs / lifecycle events
// ---------------------------------------------------------------------------

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(), // 'scheduled' | 'catchup' | 'manual'
    status: text("status").notNull(), // 'running' | 'success' | 'failure'
    scheduledFor: text("scheduled_for"), // ISO slot this run corresponds to, if any
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    error: text("error"),
  },
  (table) => [index("sync_runs_started_at_idx").on(table.startedAt)],
);

export const lifecycleEvents = sqliteTable(
  "lifecycle_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: text("event_id"),
    boutId: text("bout_id"),
    type: text("type").notNull(),
    payload: text("payload"), // JSON
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [
    index("lifecycle_events_bout_id_idx").on(table.boutId),
    index("lifecycle_events_event_id_idx").on(table.eventId),
  ],
);
