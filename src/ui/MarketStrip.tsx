import { marketProbabilities } from "../lib/oddsMath.ts";
import { pickPriorityMarket } from "../lib/marketPriority.ts";
import type { BoutView } from "../schema.ts";
import { fmtPct } from "./format.ts";

type LatestOdds = BoutView["latestOdds"];

/**
 * The at-a-glance win-probability bar shown directly under the fighters in
 * BoutHeader. Takes just the odds map (not a whole BoutView) so the exact
 * same component renders for both a live bout and a not-yet-started
 * ScheduledFightPreview (which passes `{}` — no market pipeline exists for
 * future fights yet, so every side falls back to "—"). One component, one
 * set of edits, both call sites.
 */
export function MarketStrip({
  latestOdds,
  preFightOdds,
  onOpen,
}: {
  latestOdds: LatestOdds;
  preFightOdds: LatestOdds;
  onOpen: () => void;
}) {
  const snapshot = pickPriorityMarket(latestOdds);
  // De-vigged, not the raw implied probability — sportsbook lines otherwise
  // sum to >100% (the book's overround) instead of a clean 100%.
  const probs = snapshot ? marketProbabilities(snapshot) : null;
  const red = probs?.red ?? null;
  const blue = probs?.blue ?? null;
  const hasData = red != null && blue != null;
  const total = (red ?? 0) + (blue ?? 0);
  const redShare = hasData && total > 0 ? ((red as number) / total) * 100 : 50;

  const preFightSnapshot = pickPriorityMarket(preFightOdds);
  const preFightProbs = preFightSnapshot
    ? marketProbabilities(preFightSnapshot)
    : null;
  const preFightRed = preFightProbs?.red ?? null;
  const preFightBlue = preFightProbs?.blue ?? null;

  return (
    <button
      className="market-strip"
      type="button"
      onClick={onOpen}
      aria-label="Open odds comparison"
    >
      <span className="market-strip-side">
        <strong className="num" data-odds-source={snapshot?.market}>
          {red == null ? "—" : fmtPct(red)}
        </strong>
        <span className="market-strip-prefight">
          Prefight odds: <span className="num">{preFightRed == null ? "—" : fmtPct(preFightRed)}</span>
        </span>
      </span>
      <span className="market-strip-odds-bar" aria-hidden="true">
        <span
          className={hasData ? "market-strip-odds-red" : "market-strip-odds-neutral"}
          style={{ width: `calc(${redShare}% - 1px)` }}
        />
        <span
          className={hasData ? "market-strip-odds-blue" : "market-strip-odds-neutral"}
          style={{ width: `calc(${100 - redShare}% - 1px)` }}
        />
      </span>
      <span className="market-strip-side">
        <strong className="num" data-odds-source={snapshot?.market}>
          {blue == null ? "—" : fmtPct(blue)}
        </strong>
        <span className="market-strip-prefight">
          Prefight odds: <span className="num">{preFightBlue == null ? "—" : fmtPct(preFightBlue)}</span>
        </span>
      </span>
    </button>
  );
}
