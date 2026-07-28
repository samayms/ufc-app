/**
 * Contracts every source client implements. UI and store code depend only
 * on these interfaces; each client ships a fixture-backed implementation
 * tonight and gains a live implementation tomorrow behind the same
 * interface — swapping is a config change, not a rewrite.
 *
 * Client rules (enforced by review, stated here so they live with the code):
 * - No network calls in "fixture" mode, ever. Fixture data loads from
 *   static JSON under src/fixtures/ and is marked `synthetic: true`.
 * - Clients normalize into src/schema.ts shapes at the boundary and
 *   never export source-native payload types.
 * - Clients never throw for "no data yet" — they return null/[] so the
 *   dashboard renders absence instead of crashing mid-event.
 */

import type {
  Bout,
  ExternalRef,
  Fighter,
  OddsSnapshot,
  RoundUpdate,
  ScorecardEmbed,
  UfcEvent,
} from "../schema.ts";

/** How a client resolves data. Live mode arrives with tomorrow's credentials. */
export type SourceMode = "fixture" | "live";

export interface SourceConfig {
  mode: SourceMode;
  /** Present only in live mode, injected from env — never hardcoded. */
  credentials?: Record<string, string>;
}

/** ESPN, Cito: event structure, results, and (post-round) fight state. */
export interface FightDataSource {
  /** The event being watched; null when the source doesn't know it. */
  getEvent(ref: ExternalRef): Promise<UfcEvent | null>;
  /** Completed-round accounts for a bout, ordered by round. */
  getRoundUpdates(bout: Bout): Promise<RoundUpdate[]>;
}

/** Sherdog live blog: prose + round scores only, no event structure. */
export interface RoundCommentarySource {
  getRoundUpdates(bout: Bout): Promise<RoundUpdate[]>;
}

/** Kalshi, Polymarket, The Odds API. */
export interface OddsSource {
  /** Current market reading for a bout; null when no market exists. */
  getOddsSnapshot(bout: Bout): Promise<OddsSnapshot | null>;
}

export type MarketSource =
  | "kalshi"
  | "polymarket"
  | "odds-api-io"
  | "the-odds-api";

/** One normalized source update. History retains every accepted tick. */
export interface MarketTick {
  source: MarketSource;
  boutId: string;
  bookmaker?: string;
  marketType: string;
  outcome: string;
  bid?: number;
  ask?: number;
  lastTrade?: number;
  rawOdds?: number;
  impliedProbability?: number;
  noVigProbability?: number;
  depth?: {
    bids: number[];
    asks: number[];
  };
  volume?: number;
  tickSize?: number;
  status?: string;
  sourceUpdatedAt?: string;
  receivedAt: string;
  stale: boolean;
}

export type MarketBoundaryType = "provisional" | "confirmed";

export interface MarketSnapshotOutcome {
  bookmaker?: string;
  marketType: string;
  outcome: string;
  bid?: number;
  ask?: number;
  midpoint?: number;
  spread?: number;
  lastTrade?: number;
  rawOdds?: number;
  impliedProbability?: number;
  noVigProbability?: number;
  depth?: {
    bids: number[];
    asks: number[];
  };
  volume?: number;
  tickSize?: number;
  status?: string;
  sourceUpdatedAt?: string;
  receivedAt: string;
  stale: boolean;
}

/** Keyed by (boutId, round, source, boundaryType). */
export interface MarketSnapshot {
  source: MarketSource;
  boutId: string;
  round: number;
  boundaryType: MarketBoundaryType;
  takenAt: string;
  fresh: boolean;
  outcomes: MarketSnapshotOutcome[];
}

/**
 * Historical companion to OddsSource. Existing current-snapshot clients do
 * not need to implement it.
 */
export interface TickHistorySource {
  getTickHistory(
    boutId: string,
    source?: MarketSource,
  ): Promise<MarketTick[]>;
  getRoundBoundarySnapshots(
    boutId: string,
    round?: number,
  ): Promise<MarketSnapshot[]>;
}

/** ESPN/Cito fighter profiles — fetch once, cache, don't re-poll. */
export interface FighterRecordSource {
  getFighter(ref: ExternalRef): Promise<Fighter | null>;
}

/** X embeds for the known journalist accounts. */
export interface ScorecardSource {
  getScorecardEmbeds(bout: Bout): Promise<ScorecardEmbed[]>;
}
