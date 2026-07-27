import { averageImpliedProbability } from "../lib/oddsMath.ts";
import type { BoutView, OddsSnapshot } from "../schema/types.ts";
import { fmtPct } from "./format.ts";

function firstUsable(view: BoutView): OddsSnapshot | null {
  return (
    view.latestOdds.kalshi ??
    view.latestOdds.polymarket ??
    view.latestOdds.sportsbook ??
    null
  );
}

export function MarketStrip({
  view,
  onOpen,
}: {
  view: BoutView;
  onOpen: () => void;
}) {
  const snapshot = firstUsable(view);
  const red = snapshot
    ? averageImpliedProbability(snapshot, "red")
    : null;
  const blue = snapshot
    ? averageImpliedProbability(snapshot, "blue")
    : null;

  return (
    <button
      className="market-strip"
      type="button"
      onClick={onOpen}
      aria-label="Open odds comparison"
    >
      <span className="market-strip-side">
        <strong className="num">{red == null ? "—" : fmtPct(red)}</strong>
        <span>{view.bout.fighters.red.name.split(" ").at(-1)}</span>
      </span>
      <span className="market-strip-side market-strip-side-blue">
        <strong className="num">{blue == null ? "—" : fmtPct(blue)}</strong>
        <span>{view.bout.fighters.blue.name.split(" ").at(-1)}</span>
      </span>
    </button>
  );
}
