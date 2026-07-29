/**
 * The upcoming-odds document: the contract between the twice-daily sync that
 * writes it and the dashboard that reads it.
 *
 * Both halves import these types, so a change to what the sync persists is a
 * type error in the UI rather than a silently empty panel. The document is a
 * whole-file snapshot rather than an event stream — it is regenerated twice a
 * day, it is small, and being able to open it and read the current state of
 * every provider is worth more here than incremental updates.
 *
 * The five per-provider states are deliberately distinguishable, because they
 * mean genuinely different things to someone deciding whether to trust a
 * number:
 *
 *   loaded         — a real price from that provider for this exact bout
 *   not_listed     — the provider answered, and simply does not offer this fight
 *   unmatched      — the provider lists something plausible, but the matcher
 *                    would not commit; odds exist and are deliberately withheld
 *   provider_error — the request failed; nothing is known either way
 *   stale          — derived at render time from the age of a `loaded` price
 *
 * `stale` is not stored. Staleness is a function of the clock, and a stored
 * boolean would be wrong the moment the file was written.
 */

import type { OddsSnapshot } from "../schema.ts";
import type {
  UpcomingMarketMetadata,
  UpcomingProviderId,
} from "../sources/upcoming/types.ts";

export type { UpcomingProviderId };

/** Stored provider states. `stale` is derived, never persisted. */
export type UpcomingProviderStatus =
  | "loaded"
  | "not_listed"
  | "unmatched"
  | "provider_error";

/** What the UI renders, including the derived state. */
export type UpcomingProviderDisplayStatus =
  | UpcomingProviderStatus
  | "stale";

/** A `loaded` price older than this renders as `stale`. */
export const UPCOMING_STALE_AFTER_MS = 14 * 60 * 60 * 1_000;

export interface UpcomingProviderEntry {
  status: UpcomingProviderStatus;
  /** When this sync last talked to the provider about this bout. */
  fetchedAt: string;
  /** When the price itself was last observed. Only set for `loaded`. */
  updatedAt?: string;
  /** Provider-native market id, kept so a mapping is reviewable. */
  externalId?: string;
  /** Matcher confidence that produced this attachment. */
  confidence?: number;
  /** True when the matcher had to swap the provider's fighter order. */
  cornersReversed?: boolean;
  /**
   * True when this entry is a retained earlier snapshot because the latest
   * request failed or came back empty. The price is real, just not fresh.
   */
  preserved?: boolean;
  /** Operator-facing detail for `unmatched` and `provider_error`. */
  message?: string;
  /** Optional metadata for the provider's existing win market. */
  metadata?: UpcomingMarketMetadata;
  snapshot?: OddsSnapshot;
}

export type UpcomingDecisionSource = Exclude<
  UpcomingProviderId,
  "odds-api"
>;

/** The resolved fight-level decision-vs-finish market for one bout. */
export interface UpcomingDecisionOdds {
  state: UpcomingProviderStatus;
  decisionProbability?: number;
  finishProbability?: number;
  source?: UpcomingDecisionSource;
  fetchedAt: string;
  synthetic: boolean;
  updatedAt?: string;
  externalId?: string;
  preserved?: boolean;
  message?: string;
}

export interface UpcomingBoutOdds {
  /** ESPN competition id — the id every provider is matched onto. */
  boutId: string;
  espnEventId: string;
  redFighter: string;
  blueFighter: string;
  weightClassLabel?: string;
  startsAt?: string;
  titleFight?: boolean;
  providers: Partial<Record<UpcomingProviderId, UpcomingProviderEntry>>;
  decision: UpcomingDecisionOdds;
}

export interface UpcomingEventOdds {
  espnEventId: string;
  name: string;
  startsAt?: string;
  bouts: UpcomingBoutOdds[];
}

export interface UpcomingProviderRun {
  status: "ok" | "error";
  fetchedAt: string;
  /** Markets the provider listed, before matching. */
  marketCount: number;
  /** Markets that matched an ESPN bout on this card. */
  matchedCount: number;
  message?: string;
}

/** A provider market the matcher refused to attach, kept for review. */
export interface UpcomingUnmatchedMarket {
  provider: UpcomingProviderId;
  externalId: string;
  firstFighter: string;
  secondFighter: string;
  startsAt?: string;
  reason: "ambiguous" | "no-candidate";
  bestConfidence?: number;
  candidateBoutIds?: string[];
}

export interface UpcomingOddsDocument {
  version: 1;
  generatedAt: string;
  /** True when the sync ran against bundled fixtures rather than live APIs. */
  synthetic: boolean;
  events: UpcomingEventOdds[];
  providerRuns: Partial<Record<UpcomingProviderId, UpcomingProviderRun>>;
  unmatchedMarkets: UpcomingUnmatchedMarket[];
}

export function emptyUpcomingOddsDocument(
  generatedAt: string,
  synthetic: boolean,
): UpcomingOddsDocument {
  return {
    version: 1,
    generatedAt,
    synthetic,
    events: [],
    providerRuns: {},
    unmatchedMarkets: [],
  };
}

/**
 * The state to render for one provider on one bout.
 *
 * A missing entry is `not_listed`, not an error: it means the sync ran and
 * this provider had nothing for this fight. An absent *sync* is handled a
 * level up, by the loader, so this never has to invent a "no data yet" state.
 */
export function upcomingProviderDisplayStatus(
  entry: UpcomingProviderEntry | undefined,
  nowMs: number,
  staleAfterMs: number = UPCOMING_STALE_AFTER_MS,
): UpcomingProviderDisplayStatus {
  if (entry === undefined) return "not_listed";
  if (entry.status !== "loaded") return entry.status;

  const observed = Date.parse(entry.updatedAt ?? entry.fetchedAt);
  if (!Number.isFinite(observed)) return "loaded";
  return nowMs - observed > staleAfterMs ? "stale" : "loaded";
}

export function upcomingDecisionDisplayStatus(
  decision: UpcomingDecisionOdds | undefined,
  nowMs: number,
  staleAfterMs: number = UPCOMING_STALE_AFTER_MS,
): UpcomingProviderDisplayStatus {
  if (decision === undefined) return "not_listed";
  if (decision.state !== "loaded") return decision.state;

  const observed = Date.parse(decision.updatedAt ?? decision.fetchedAt);
  if (!Number.isFinite(observed)) return "loaded";
  return nowMs - observed > staleAfterMs ? "stale" : "loaded";
}

export function findUpcomingBout(
  document: UpcomingOddsDocument | null,
  boutId: string,
): UpcomingBoutOdds | undefined {
  if (document === null) return undefined;
  for (const event of document.events) {
    const bout = event.bouts.find((candidate) => candidate.boutId === boutId);
    if (bout !== undefined) return bout;
  }
  return undefined;
}
