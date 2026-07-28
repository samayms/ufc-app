/**
 * Unified data model for the UFC Live Dashboard.
 *
 * Every external source (ESPN, Sherdog, Cito, Kalshi, Polymarket, The Odds
 * API, X embeds) normalizes into these types and nothing downstream of a
 * source client ever sees a source-native payload. The three load-bearing
 * decisions:
 *
 * 1. Canonical internal ids + `externalRefs`. No two sources share an id
 *    scheme for events, bouts, or fighters. Each entity gets a stable
 *    internal id (slug-like, assigned when the entity first enters the
 *    system) and carries the per-source identifiers needed to fetch or
 *    reconcile it.
 *
 * 2. Odds keep their native form alongside a normalized implied
 *    probability. Kalshi prices in cents, Polymarket in 0–1 token prices,
 *    sportsbooks in vigged American moneylines. These are different
 *    markets with different math; the UI must always be able to show the
 *    native number, so normalization is additive, never destructive.
 *    De-vigging and cross-market reconciliation live in a separate
 *    normalization module, not here.
 *
 * 3. Honest freshness. The product updates between rounds by design, so
 *    every fetched datum says when it was fetched and from where. The UI
 *    renders staleness rather than pretending to be live.
 */

/** Where a piece of data came from. One value per client wrapper. */
export type SourceId =
  | "espn"
  | "sherdog"
  | "cito"
  | "kalshi"
  | "polymarket"
  | "odds-api-io"
  | "odds-api"
  | "x-embed"
  | "fixture";

/** A source's own identifier for an entity, kept for fetching and reconciliation. */
export interface ExternalRef {
  source: SourceId;
  /** Source-native id: ESPN event id, Sherdog fighter slug, Kalshi ticker, Polymarket condition id, … */
  id: string;
}

/** Attached to every fetched payload so the UI can render honest staleness. */
export interface Provenance {
  source: SourceId;
  /** ISO 8601. When our client actually retrieved this data. */
  fetchedAt: string;
  /** True while running on synthetic fixture data (no credentials yet). */
  synthetic: boolean;
}

// ---------------------------------------------------------------------------
// Fight structure: Event → Bout → Fighter
// ---------------------------------------------------------------------------

export type WeightClass =
  | "strawweight"
  | "flyweight"
  | "bantamweight"
  | "featherweight"
  | "lightweight"
  | "welterweight"
  | "middleweight"
  | "light-heavyweight"
  | "heavyweight"
  | "womens-strawweight"
  | "womens-flyweight"
  | "womens-bantamweight"
  | "womens-featherweight"
  | "catchweight";

export interface FightRecord {
  wins: number;
  losses: number;
  draws: number;
  noContests: number;
}

/** Cached, rarely-changing fighter profile (fetch once, cache locally). */
export interface Fighter {
  id: string;
  externalRefs: ExternalRef[];
  name: string;
  nickname?: string;
  record: FightRecord;
  /** e.g. "orthodox" | "southpaw" | "switch" — free-form, source vocabularies differ. */
  stance?: string;
  heightCm?: number;
  reachCm?: number;
  age?: number;
  country?: string;
  /** Most recent bouts, newest first. */
  recentBouts?: PastBout[];
  provenance: Provenance;
}

/** A line in a fighter's history, for the record card. */
export interface PastBout {
  opponentName: string;
  result: "win" | "loss" | "draw" | "nc";
  method: FinishMethod;
  round?: number;
  date?: string;
  eventName?: string;
}

export type FinishMethod =
  | "ko-tko"
  | "submission"
  | "decision-unanimous"
  | "decision-split"
  | "decision-majority"
  | "dq"
  | "nc"
  | "other";

/** Red/blue corner. Also the key for per-fighter odds and scores on a bout. */
export type Corner = "red" | "blue";

export type BoutStatus =
  | "upcoming"
  | "in-round"
  | "between-rounds"
  | "final"
  | "canceled"
  | "postponed";

export interface BoutResult {
  winner: Corner | "draw" | "nc";
  method: FinishMethod;
  /** Round the fight ended in (absent for decisions read off the scorecards). */
  round?: number;
  /** Time within that round, "m:ss". */
  time?: string;
}

export interface Bout {
  id: string;
  externalRefs: ExternalRef[];
  eventId: string;
  /** 1 = main event; ascending order walks down the card. */
  cardPosition: number;
  segment: "main-card" | "prelims" | "early-prelims";
  weightClass: WeightClass;
  scheduledRounds: 3 | 5;
  titleFight: boolean;
  fighters: Record<Corner, Fighter>;
  status: BoutStatus;
  /** Current round while live; the round just completed while between rounds. */
  currentRound?: number;
  result?: BoutResult;
  provenance: Provenance;
}

export interface UfcEvent {
  id: string;
  externalRefs: ExternalRef[];
  /** e.g. "UFC 318: Holloway vs. Poirier 3" */
  name: string;
  /** ISO 8601 start of the first scheduled bout. */
  startsAt: string;
  venue?: string;
  city?: string;
  bouts: Bout[];
  provenance: Provenance;
}

// ---------------------------------------------------------------------------
// Round-by-round data (between-rounds granularity, by design)
// ---------------------------------------------------------------------------

/**
 * One completed round of one bout, as one source saw it. Sources disagree
 * (Sherdog's blogger vs ESPN's data feed), so rounds are stored per-source
 * and reconciled in the UI, never merged at ingest.
 */
export interface RoundUpdate {
  boutId: string;
  round: number;
  /** 10-9 style score, when the source scores rounds. */
  score?: Record<Corner, number>;
  /** Prose account of the round (Sherdog live blog text, ESPN recap). */
  summary?: string;
  /** Aggregate stats when the source has them; ESPN has no live strikes. */
  stats?: Partial<Record<Corner, RoundStats>>;
  provenance: Provenance;
}

export interface RoundStats {
  significantStrikes?: number;
  totalStrikes?: number;
  takedowns?: number;
  takedownsAttempted?: number;
  controlTimeSeconds?: number;
  knockdowns?: number;
}

export interface SherdogScorerCard {
  scorer: string;
  winner?: string;
  roundScore?: string;
  cumulativeScore?: string;
}

/** One validated, plain-text observation from the permitted live blog. */
export interface SherdogRoundObservation {
  boutId: string;
  round: number;
  commentary: string;
  scorerCards: SherdogScorerCard[];
  sourceUrl: string;
  publishedAt?: string;
  fetchedAt: string;
  parserVersion: string;
  payloadHash: string;
}

export interface ExpertConsensusValue {
  source: "sherdog" | "x";
  redVotes: number;
  blueVotes: number;
  drawVotes: number;
  total: number;
  leader?: Corner | "draw";
}

/** Source-specific expert reads. These values are deliberately never merged. */
export interface ExpertConsensus {
  sherdog?: ExpertConsensusValue;
  x?: ExpertConsensusValue;
}

// ---------------------------------------------------------------------------
// Odds — three market kinds, deliberately kept distinguishable
// ---------------------------------------------------------------------------

/**
 * The number a market actually publishes, verbatim. Exactly one of these
 * shapes per snapshot; the UI shows the native form next to the normalized
 * probability.
 */
export type NativePrice =
  | {
      kind: "kalshi-cents";
      /** YES price in cents, 1–99. */
      yesCents: number;
      noCents: number;
    }
  | {
      kind: "polymarket-price";
      /** Outcome token price, 0–1. */
      price: number;
    }
  | {
      kind: "american-moneyline";
      /** e.g. -210 or +175. Vigged; de-vigging happens in the normalization module. */
      moneyline: number;
      /** Which sportsbook, e.g. "draftkings", "fanduel". */
      book: string;
    };

/** One fighter's price on one market at one moment. */
export interface OddsQuote {
  corner: Corner;
  native: NativePrice;
  /**
   * Implied probability in [0,1], converted mechanically from the native
   * price (still includes vig for sportsbook lines). The normalization
   * module derives vig-free probabilities across a bout's pair of quotes.
   */
  impliedProbability: number;
}

/**
 * A point-in-time reading of one market for one bout. Snapshots are
 * append-only; the odds timeline is just the ordered list of snapshots.
 */
export interface OddsSnapshot {
  boutId: string;
  /** Discriminates the three market kinds at the collection level. */
  market: "kalshi" | "polymarket" | "sportsbook";
  quotes: OddsQuote[];
  /** When the market itself says it was last updated, if it says. */
  marketUpdatedAt?: string;
  provenance: Provenance;
}

// ---------------------------------------------------------------------------
// Market movement — deltas between ticks, not a new market kind
// ---------------------------------------------------------------------------

export type MarketMoveDirection = "up" | "down" | "flat";

/**
 * Movement between the two most recent ticks a market client has for one
 * outcome, expressed in implied-probability terms so Kalshi cents,
 * Polymarket prices, and sportsbook moneylines are comparable on the same
 * scale. Absent — never a zero-valued object — when there isn't a prior
 * tick to compare against; the UI renders that absence as an honest
 * neutral state instead of a fabricated delta.
 */
export interface MarketMove {
  direction: MarketMoveDirection;
  deltaProbability: number;
  previousProbability: number;
  currentProbability: number;
}

// ---------------------------------------------------------------------------
// Journalist scorecards (X embeds, not paid API search)
// ---------------------------------------------------------------------------

/** A known journalist/outlet account whose scorecards we embed. */
export interface ScorecardAccount {
  /** X handle without the @. */
  handle: string;
  displayName: string;
  /** Set false once an account proves inactive; UI drops it quietly. */
  active: boolean;
}

/**
 * A pointer to one embeddable post (round score or fight commentary).
 * We store only the reference; rendering uses X's embed widget.
 */
export interface ScorecardEmbed {
  boutId: string;
  handle: string;
  /** X post id, enough to render the official embed. */
  postId: string;
  /** Round the post scores, when parseable; absent for general commentary. */
  round?: number;
  provenance: Provenance;
}

// ---------------------------------------------------------------------------
// Dashboard aggregate — what the UI actually consumes
// ---------------------------------------------------------------------------

/** Everything the dashboard needs for one bout, assembled by the store. */
export interface BoutView {
  bout: Bout;
  /** Per-source round accounts, keyed by source, each ordered by round. */
  rounds: Partial<Record<SourceId, RoundUpdate[]>>;
  /** Latest snapshot per market kind. */
  latestOdds: Partial<Record<OddsSnapshot["market"], OddsSnapshot>>;
  /** Full append-only history per market kind, for the odds timeline. */
  oddsHistory: Partial<Record<OddsSnapshot["market"], OddsSnapshot[]>>;
  /** Per-corner movement since the prior tick, per market kind. Missing entries mean no prior tick, not zero movement. */
  marketMoves: Partial<Record<OddsSnapshot["market"], Partial<Record<Corner, MarketMove>>>>;
  /**
   * The opening line per market kind, captured once when the card started.
   * A missing entry means no pre-fight snapshot was taken for that market —
   * render absence, never substitute the current price as if it were opening.
   */
  preFightOdds: Partial<Record<OddsSnapshot["market"], OddsSnapshot>>;
  scorecards: ScorecardEmbed[];
}

export interface DashboardState {
  event: UfcEvent;
  /** BoutView per bout id. */
  boutViews: Record<string, BoutView>;
  scorecardAccounts: ScorecardAccount[];
}
