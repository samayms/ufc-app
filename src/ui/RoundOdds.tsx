import type { CollectorUnifiedRound } from "../store/collectorClient.ts";
import { averageImpliedProbability } from "../lib/oddsMath.ts";
import type { OddsSnapshot } from "../schema.ts";
import type { MarketSnapshot, MarketSnapshotOutcome } from "../sources/contract.ts";
import { fmtPct } from "./format.ts";

type RoundMarket = "kalshi" | "polymarket" | "sportsbook";

interface MarketChoice {
  market: RoundMarket;
  snapshot?: MarketSnapshot;
  red: number;
  blue: number;
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findOutcome(
  outcomes: MarketSnapshotOutcome[],
  fighterName: string,
): MarketSnapshotOutcome | undefined {
  const full = normalizedName(fighterName);
  const surname = normalizedName(fighterName.split(/\s+/).at(-1) ?? fighterName);
  return outcomes.find((outcome) => normalizedName(outcome.outcome) === full) ??
    outcomes.find((outcome) => normalizedName(outcome.outcome).includes(surname));
}

function probability(outcome: MarketSnapshotOutcome | undefined): number | null {
  const value = outcome?.noVigProbability ?? outcome?.impliedProbability;
  return value != null && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function candidate(
  market: RoundMarket,
  snapshot: MarketSnapshot | undefined,
  redName: string,
  blueName: string,
): MarketChoice | null {
  if (snapshot === undefined) return null;
  const redOutcome = findOutcome(snapshot.outcomes, redName);
  const blueOutcome = findOutcome(snapshot.outcomes, blueName);
  const red = probability(redOutcome);
  const blue = probability(blueOutcome);
  if (red == null || blue == null || redOutcome === undefined || blueOutcome === undefined) {
    return null;
  }
  return {
    market,
    snapshot,
    red,
    blue,
  };
}

function choiceFromOddsSnapshot(snapshot: OddsSnapshot | undefined): MarketChoice | null {
  if (snapshot === undefined) return null;
  const redQuote = snapshot.quotes.find((quote) => quote.corner === "red");
  const blueQuote = snapshot.quotes.find((quote) => quote.corner === "blue");
  const red = averageImpliedProbability(snapshot, "red");
  const blue = averageImpliedProbability(snapshot, "blue");
  if (red == null || blue == null || redQuote === undefined || blueQuote === undefined) {
    return null;
  }
  return {
    market: snapshot.market,
    red,
    blue,
  };
}

/** Picks the first complete market in the product's explicit priority order. */
function chooseMarket(
  record: CollectorUnifiedRound,
  redName: string,
  blueName: string,
): MarketChoice | null {
  return (
    candidate("kalshi", record.marketAtEnd.kalshi, redName, blueName) ??
    candidate("polymarket", record.marketAtEnd.polymarket, redName, blueName) ??
    candidate("sportsbook", record.marketAtEnd.oddsApiIo, redName, blueName) ??
    candidate("sportsbook", record.marketAtEnd.theOddsApi, redName, blueName)
  );
}

function chooseLatestMarket(
  latestOdds: Partial<Record<OddsSnapshot["market"], OddsSnapshot>> | undefined,
): MarketChoice | null {
  return (
    choiceFromOddsSnapshot(latestOdds?.kalshi) ??
    choiceFromOddsSnapshot(latestOdds?.polymarket) ??
    choiceFromOddsSnapshot(latestOdds?.sportsbook)
  );
}

function latestRoundRecord(
  records: readonly CollectorUnifiedRound[],
  boutId: string,
  selection: number | "total",
): CollectorUnifiedRound | undefined {
  const matching = records
    .filter((record) => record.boutId === boutId)
    .filter((record) => selection === "total" || record.round === selection)
    .sort((left, right) => right.round - left.round);
  return matching[0];
}

export function RoundOdds({
  boutId,
  redName,
  blueName,
  selection,
  records = [],
  latestOdds,
}: {
  boutId: string;
  redName: string;
  blueName: string;
  selection: number | "total";
  records?: readonly CollectorUnifiedRound[];
  latestOdds?: Partial<Record<OddsSnapshot["market"], OddsSnapshot>>;
}) {
  const record = latestRoundRecord(records, boutId, selection);
  const choice =
    (record === undefined ? null : chooseMarket(record, redName, blueName)) ??
    chooseLatestMarket(latestOdds);
  const selectionLabel =
    record === undefined
      ? selection === "total"
        ? "Odds after the latest round"
        : `Odds after Round ${selection}`
      : `Odds after Round ${record.round}`;

  if (choice === null) {
    return (
      <div className="compact-stat round-odds round-odds-empty" aria-label={selectionLabel}>
        <div className="compact-stat-values">
          <span className="num">—</span>
          <span>Odds</span>
          <span className="num">—</span>
        </div>
      </div>
    );
  }

  const total = Math.max(choice.red + choice.blue, 0.0001);
  const redShare = (choice.red / total) * 100;

  return (
    <div className="compact-stat round-odds" data-market-accent={choice.market} aria-label={selectionLabel}>
      <div className="compact-stat-values">
        <span className="num corner-red">{fmtPct(choice.red)}</span>
        <span>Odds</span>
        <span className="num corner-blue">{fmtPct(choice.blue)}</span>
      </div>
      <div className="compact-stat-bars" aria-hidden="true">
        <span>
          <i className="compact-bar-red" style={{ width: `${redShare}%` }} />
        </span>
        <span>
          <i className="compact-bar-blue" style={{ width: `${100 - redShare}%` }} />
        </span>
      </div>
    </div>
  );
}
