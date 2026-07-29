import type { BoutView, Corner, MarketMove, OddsSnapshot } from "../schema.ts";
import { averageImpliedProbability } from "../lib/oddsMath.ts";
import type { CollectorValueDelivery } from "../store/collectorClient.ts";
import { DeliveryFreshness } from "./DeliveryFreshness.tsx";
import { fmtMoneyline, fmtMove, fmtNative, fmtPct, fmtTime } from "./format.ts";

/**
 * One corner's movement since the prior tick — the market-amber reservation
 * (DESIGN.md's Amber-Is-Money rule) exercised for the first time. Renders an
 * honest "no history yet" dash rather than a fabricated zero when there's no
 * prior tick to compare against. `emptyLabel` lets callers with a different
 * reason for "no delta" (e.g. no opening line to compare against) say so
 * without inventing a second visual language for the same kind of absence.
 */
function MarketMoveTag({
  move,
  emptyLabel = "no history yet",
}: {
  move?: MarketMove;
  emptyLabel?: string;
}) {
  if (!move) {
    return <span className="market-move market-move-empty">{emptyLabel}</span>;
  }
  if (move.direction === "flat") {
    return <span className="market-move market-move-flat">flat</span>;
  }
  const arrow = move.direction === "up" ? "▲" : "▼";
  return (
    <span className={`market-move market-move-${move.direction} num`}>
      {arrow} {fmtMove(move.deltaProbability)}
    </span>
  );
}

/**
 * Movement from the opening line to the current price, in the same
 * MarketMove shape market-tick movement uses — same math (average implied
 * probability per corner, no de-vig), just anchored on the pre-fight
 * snapshot instead of the prior tick. Null — never a fabricated delta —
 * when either side is missing a usable quote for the corner.
 */
function openToNowMove(
  open: OddsSnapshot,
  current: OddsSnapshot,
  corner: Corner,
): MarketMove | null {
  const previousProbability = averageImpliedProbability(open, corner);
  const currentProbability = averageImpliedProbability(current, corner);
  if (previousProbability == null || currentProbability == null) return null;
  const deltaProbability = currentProbability - previousProbability;
  const direction =
    deltaProbability > 0 ? "up" : deltaProbability < 0 ? "down" : "flat";
  return { direction, deltaProbability, previousProbability, currentProbability };
}

/**
 * The opening (pre-fight) line for one market, shown alongside the current
 * price so the owner can actually check pre-fight odds — the dashboard's
 * primary ask. A missing `open` snapshot is rendered as a plain, honest
 * absence (schema.ts's contract: no pre-fight snapshot means no opening
 * line, never the current price standing in for it).
 */
function OpeningLine({
  open,
  current,
  redName,
  blueName,
}: {
  open: OddsSnapshot | null;
  current: OddsSnapshot | null;
  redName: string;
  blueName: string;
}) {
  if (!open) {
    return (
      <div className="market-open">
        <p className="market-note">No opening line captured for this market.</p>
      </div>
    );
  }
  const red = averageImpliedProbability(open, "red");
  const blue = averageImpliedProbability(open, "blue");
  if (red == null || blue == null) {
    return (
      <div className="market-open">
        <p className="market-note">Opening line captured but incomplete.</p>
      </div>
    );
  }
  const singleBook = open.market !== "sportsbook";
  const redQuote = open.quotes.find((q) => q.corner === "red");
  const blueQuote = open.quotes.find((q) => q.corner === "blue");
  const moveRed = current ? openToNowMove(open, current, "red") : null;
  const moveBlue = current ? openToNowMove(open, current, "blue") : null;
  const emptyLabel = current ? "no history yet" : "current price unavailable";

  return (
    <div className="market-open">
      <div className="market-head">
        <span className="freshness">Opening line</span>
        <span className="freshness">
          opened <span className="num">{fmtTime(open.provenance.fetchedAt)}</span>
        </span>
      </div>
      <div className="market-bar">
        <span className="market-side">
          <span className="market-pct num">{fmtPct(red)}</span>
          <span className="market-name">{redName}</span>
          {singleBook && redQuote && (
            <span className="market-native num">{fmtNative(redQuote.native)}</span>
          )}
          <MarketMoveTag move={moveRed ?? undefined} emptyLabel={emptyLabel} />
        </span>
        <span className="market-side market-side-blue">
          <span className="market-pct num">{fmtPct(blue)}</span>
          <span className="market-name">{blueName}</span>
          {singleBook && blueQuote && (
            <span className="market-native num">{fmtNative(blueQuote.native)}</span>
          )}
          <MarketMoveTag move={moveBlue ?? undefined} emptyLabel={emptyLabel} />
        </span>
      </div>
    </div>
  );
}

/**
 * Two-sided implied-probability bar. Red fills from the left, blue from the
 * right, 2px surface gap between them (dataviz spacer rule). Probabilities
 * may not sum to 1 (vig, spread) — the gap position uses the red share of
 * the red+blue total, and the raw numbers are always printed beside it.
 */
function SplitBar({
  red,
  blue,
  redName,
  blueName,
}: {
  red: number;
  blue: number;
  redName: string;
  blueName: string;
}) {
  const total = red + blue;
  const redShare = total > 0 ? (red / total) * 100 : 50;
  return (
    <div
      className="split"
      role="img"
      aria-label={`${redName} ${fmtPct(red)}, ${blueName} ${fmtPct(blue)}`}
    >
      <span className="split-red" style={{ width: `calc(${redShare}% - 1px)` }} />
      <span className="split-blue" style={{ width: `calc(${100 - redShare}% - 1px)` }} />
    </div>
  );
}

/**
 * Market slots render amber (`--market`) by default, matching the live
 * panel's existing look. `accent` lets a caller opt a slot into its
 * reserved color instead — used by the future-fight preview to keep
 * Kalshi/Polymarket/Sportsbooks visually distinct even before real data
 * exists for any of them. Kalshi intentionally has no accent value: it
 * keeps the existing default amber, per product direction.
 */
export function MarketBlock({
  title,
  accent,
  snapshot,
  emptyText,
  delivery,
  moves,
  preFight,
  redName,
  blueName,
  children,
}: {
  title: string;
  accent?: "polymarket" | "sportsbook";
  snapshot: OddsSnapshot | null;
  emptyText: string;
  delivery?: CollectorValueDelivery;
  moves?: Partial<Record<Corner, MarketMove>>;
  preFight: OddsSnapshot | null;
  redName: string;
  blueName: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="market" data-market-accent={accent} aria-label={`${title} odds`}>
      <div className="market-head">
        <h3>{title}</h3>
        {snapshot &&
          (delivery ? (
            <DeliveryFreshness delivery={delivery} />
          ) : (
            <span className="freshness">
              as of <span className="num">{fmtTime(snapshot.provenance.fetchedAt)}</span>
            </span>
          ))}
      </div>
      {snapshot ? (
        <>
          <MarketBar snapshot={snapshot} moves={moves} redName={redName} blueName={blueName} />
          {children}
        </>
      ) : (
        <p className="empty">{emptyText}</p>
      )}
      <OpeningLine open={preFight} current={snapshot} redName={redName} blueName={blueName} />
    </section>
  );
}

function MarketBar({
  snapshot,
  moves,
  redName,
  blueName,
}: {
  snapshot: OddsSnapshot;
  moves?: Partial<Record<Corner, MarketMove>>;
  redName: string;
  blueName: string;
}) {
  const red = averageImpliedProbability(snapshot, "red");
  const blue = averageImpliedProbability(snapshot, "blue");
  if (red == null || blue == null) return <p className="empty">Incomplete quotes.</p>;
  const singleBook = snapshot.market !== "sportsbook";
  const redQuote = snapshot.quotes.find((q) => q.corner === "red");
  const blueQuote = snapshot.quotes.find((q) => q.corner === "blue");
  return (
    <div className="market-bar">
      <span className="market-side">
        <span className="market-pct num">{fmtPct(red)}</span>
        <span className="market-name">{redName}</span>
        {singleBook && redQuote && (
          <span className="market-native num">{fmtNative(redQuote.native)}</span>
        )}
        <MarketMoveTag move={moves?.red} />
      </span>
      <SplitBar red={red} blue={blue} redName={redName} blueName={blueName} />
      <span className="market-side market-side-blue">
        <span className="market-pct num">{fmtPct(blue)}</span>
        <span className="market-name">{blueName}</span>
        {singleBook && blueQuote && (
          <span className="market-native num">{fmtNative(blueQuote.native)}</span>
        )}
        <MarketMoveTag move={moves?.blue} />
      </span>
    </div>
  );
}

const BOOK_LABEL: Record<string, string> = {
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  betmgm: "BetMGM",
  caesars: "Caesars",
  williamhill_us: "William Hill",
};

function BookRows({
  snapshot,
  redName,
  blueName,
}: {
  snapshot: OddsSnapshot;
  redName: string;
  blueName: string;
}) {
  const books = new Map<string, { red?: number; blue?: number }>();
  for (const q of snapshot.quotes) {
    if (q.native.kind !== "american-moneyline") continue;
    const entry = books.get(q.native.book) ?? {};
    entry[q.corner] = q.native.moneyline;
    books.set(q.native.book, entry);
  }
  if (books.size === 0) return null;
  return (
    <table className="book-table">
      <thead>
        <tr>
          <th scope="col">Book</th>
          <th scope="col" className="num">
            {redName}
          </th>
          <th scope="col" className="num">
            {blueName}
          </th>
        </tr>
      </thead>
      <tbody>
        {[...books.entries()].map(([book, lines]) => (
          <tr key={book}>
            <th scope="row">{BOOK_LABEL[book] ?? book}</th>
            <td className="num">{lines.red != null ? fmtMoneyline(lines.red) : "—"}</td>
            <td className="num">{lines.blue != null ? fmtMoneyline(lines.blue) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function OddsPanel({
  view,
  deliveries,
}: {
  view: BoutView;
  deliveries?: Partial<Record<OddsSnapshot["market"], CollectorValueDelivery>>;
}) {
  const { latestOdds, marketMoves, preFightOdds, bout } = view;
  const finalText =
    bout.status === "final"
      ? "Market settled — bout is final."
      : bout.status === "canceled" || bout.status === "postponed"
        ? `Market unavailable — bout ${bout.status}.`
        : "No market for this bout yet.";
  const sportsbook = latestOdds.sportsbook ?? null;
  const redName = bout.fighters.red.name.split(" ").at(-1) ?? bout.fighters.red.name;
  const blueName = bout.fighters.blue.name.split(" ").at(-1) ?? bout.fighters.blue.name;
  return (
    <section className="panel" aria-label="Odds comparison">
      <div className="panel-head">
        <h2>Markets</h2>
        <span className="freshness">
          implied win probability, {redName} vs {blueName}
        </span>
      </div>
      <MarketBlock
        title="Kalshi"
        snapshot={latestOdds.kalshi ?? null}
        emptyText={finalText}
        delivery={deliveries?.kalshi}
        moves={marketMoves.kalshi}
        preFight={preFightOdds.kalshi ?? null}
        redName={redName}
        blueName={blueName}
      />
      <MarketBlock
        title="Polymarket"
        snapshot={latestOdds.polymarket ?? null}
        emptyText={finalText}
        delivery={deliveries?.polymarket}
        moves={marketMoves.polymarket}
        preFight={preFightOdds.polymarket ?? null}
        redName={redName}
        blueName={blueName}
      />
      <MarketBlock
        title="Sportsbooks"
        snapshot={sportsbook}
        emptyText={finalText}
        delivery={deliveries?.sportsbook}
        moves={marketMoves.sportsbook}
        preFight={preFightOdds.sportsbook ?? null}
        redName={redName}
        blueName={blueName}
      >
        {sportsbook && <BookRows snapshot={sportsbook} redName={redName} blueName={blueName} />}
      </MarketBlock>
    </section>
  );
}
