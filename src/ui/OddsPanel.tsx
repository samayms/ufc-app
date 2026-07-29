import type { OddsSnapshot } from "../schema.ts";
import { averageImpliedProbability } from "../lib/oddsMath.ts";
import type { CollectorValueDelivery } from "../store/collectorClient.ts";
import { DeliveryFreshness } from "./DeliveryFreshness.tsx";
import { fmtMoneyline, fmtNative, fmtPct, fmtTime } from "./format.ts";

/**
 * The opening (pre-fight) line for one market, shown alongside the current
 * price so the owner can actually check pre-fight odds — the dashboard's
 * primary ask. Missing pieces (no snapshot at all, or a snapshot with an
 * incomplete quote) render the same bar layout as a populated line, with
 * "—" standing in for any number that isn't known.
 */
function OpeningLine({
  open,
  redName,
  blueName,
}: {
  open: OddsSnapshot | null;
  redName: string;
  blueName: string;
}) {
  const red = open ? averageImpliedProbability(open, "red") : null;
  const blue = open ? averageImpliedProbability(open, "blue") : null;
  const singleBook = open ? open.market !== "sportsbook" : false;
  const redQuote = open?.quotes.find((q) => q.corner === "red");
  const blueQuote = open?.quotes.find((q) => q.corner === "blue");

  return (
    <div className="market-open">
      <div className="market-head">
        <span className="freshness">Opening line</span>
        {open && (
          <span className="freshness">
            opened <span className="num">{fmtTime(open.provenance.fetchedAt)}</span>
          </span>
        )}
      </div>
      <div className="market-bar">
        <span className="market-side">
          <span className="market-pct num">{red == null ? "—" : fmtPct(red)}</span>
          <span className="market-name">{redName}</span>
          {singleBook && redQuote && (
            <span className="market-native num">{fmtNative(redQuote.native)}</span>
          )}
        </span>
        <span className="market-side market-side-blue">
          <span className="market-pct num">{blue == null ? "—" : fmtPct(blue)}</span>
          <span className="market-name">{blueName}</span>
          {singleBook && blueQuote && (
            <span className="market-native num">{fmtNative(blueQuote.native)}</span>
          )}
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
 * Either side may be `null` (no usable quote) — the bar then renders a
 * neutral, uncolored 50/50 split rather than fabricating a lean.
 */
function SplitBar({
  red,
  blue,
  redName,
  blueName,
}: {
  red: number | null;
  blue: number | null;
  redName: string;
  blueName: string;
}) {
  const hasData = red != null && blue != null;
  const total = (red ?? 0) + (blue ?? 0);
  const redShare = hasData && total > 0 ? ((red as number) / total) * 100 : 50;
  const label = hasData
    ? `${redName} ${fmtPct(red as number)}, ${blueName} ${fmtPct(blue as number)}`
    : `${redName} vs ${blueName}, odds unavailable`;
  return (
    <div className="split" role="img" aria-label={label}>
      <span
        className={hasData ? "split-red" : "split-neutral"}
        style={{ width: `calc(${redShare}% - 1px)` }}
      />
      <span
        className={hasData ? "split-blue" : "split-neutral"}
        style={{ width: `calc(${100 - redShare}% - 1px)` }}
      />
    </div>
  );
}

/**
 * Market slots render amber (`--market`) by default, matching the live
 * panel's existing look. `accent` lets a caller opt a slot into its own
 * reserved color instead — Kalshi, Polymarket, and Sportsbooks each get a
 * distinct accent (see `--market-color-*` in index.css and the
 * `data-market-accent` rules in dashboard.css) so the three blocks stay
 * visually distinct whether a fight is live or still upcoming.
 */
export function MarketBlock({
  title,
  accent,
  snapshot,
  emptyText,
  delivery,
  preFight,
  redName,
  blueName,
  children,
}: {
  title: string;
  accent?: "kalshi" | "polymarket" | "sportsbook";
  snapshot: OddsSnapshot | null;
  emptyText?: string;
  delivery?: CollectorValueDelivery;
  preFight: OddsSnapshot | null;
  redName: string;
  blueName: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="market" data-market-accent={accent} aria-label={`${title} odds`}>
      <div className="market-head">
        <h3>{title}</h3>
        {snapshot ? (
          delivery ? (
            <DeliveryFreshness delivery={delivery} />
          ) : (
            <span className="freshness">
              as of <span className="num">{fmtTime(snapshot.provenance.fetchedAt)}</span>
            </span>
          )
        ) : (
          emptyText && <span className="freshness">{emptyText}</span>
        )}
      </div>
      <MarketBar snapshot={snapshot} redName={redName} blueName={blueName} />
      {children}
      <OpeningLine open={preFight} redName={redName} blueName={blueName} />
    </section>
  );
}

function MarketBar({
  snapshot,
  redName,
  blueName,
}: {
  snapshot: OddsSnapshot | null;
  redName: string;
  blueName: string;
}) {
  const red = snapshot ? averageImpliedProbability(snapshot, "red") : null;
  const blue = snapshot ? averageImpliedProbability(snapshot, "blue") : null;
  const singleBook = snapshot ? snapshot.market !== "sportsbook" : false;
  const redQuote = snapshot?.quotes.find((q) => q.corner === "red");
  const blueQuote = snapshot?.quotes.find((q) => q.corner === "blue");
  return (
    <div className="market-bar">
      <span className="market-side">
        <span className="market-pct num">{red == null ? "—" : fmtPct(red)}</span>
        <span className="market-name">{redName}</span>
        {singleBook && redQuote && (
          <span className="market-native num">{fmtNative(redQuote.native)}</span>
        )}
      </span>
      <SplitBar red={red} blue={blue} redName={redName} blueName={blueName} />
      <span className="market-side market-side-blue">
        <span className="market-pct num">{blue == null ? "—" : fmtPct(blue)}</span>
        <span className="market-name">{blueName}</span>
        {singleBook && blueQuote && (
          <span className="market-native num">{fmtNative(blueQuote.native)}</span>
        )}
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
  redName,
  blueName,
  latestOdds,
  preFightOdds,
  emptyText,
  deliveries,
}: {
  redName: string;
  blueName: string;
  latestOdds: Partial<Record<OddsSnapshot["market"], OddsSnapshot>>;
  preFightOdds: Partial<Record<OddsSnapshot["market"], OddsSnapshot>>;
  emptyText?: string;
  deliveries?: Partial<Record<OddsSnapshot["market"], CollectorValueDelivery>>;
}) {
  const sportsbook = latestOdds.sportsbook ?? null;
  return (
    <section className="panel" aria-label="Odds comparison">
      <div className="panel-head">
        <h2>Markets</h2>
      </div>
      <MarketBlock
        title="Kalshi"
        accent="kalshi"
        snapshot={latestOdds.kalshi ?? null}
        emptyText={emptyText}
        delivery={deliveries?.kalshi}
        preFight={preFightOdds.kalshi ?? null}
        redName={redName}
        blueName={blueName}
      />
      <MarketBlock
        title="Polymarket"
        accent="polymarket"
        snapshot={latestOdds.polymarket ?? null}
        emptyText={emptyText}
        delivery={deliveries?.polymarket}
        preFight={preFightOdds.polymarket ?? null}
        redName={redName}
        blueName={blueName}
      />
      <MarketBlock
        title="Sportsbooks"
        accent="sportsbook"
        snapshot={sportsbook}
        emptyText={emptyText}
        delivery={deliveries?.sportsbook}
        preFight={preFightOdds.sportsbook ?? null}
        redName={redName}
        blueName={blueName}
      >
        {sportsbook && <BookRows snapshot={sportsbook} redName={redName} blueName={blueName} />}
      </MarketBlock>
    </section>
  );
}
