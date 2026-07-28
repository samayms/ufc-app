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

/** ESPN/Cito fighter profiles — fetch once, cache, don't re-poll. */
export interface FighterRecordSource {
  getFighter(ref: ExternalRef): Promise<Fighter | null>;
}

/** X embeds for the known journalist accounts. */
export interface ScorecardSource {
  getScorecardEmbeds(bout: Bout): Promise<ScorecardEmbed[]>;
}
