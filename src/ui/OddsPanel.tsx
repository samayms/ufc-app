import type { BoutView, OddsQuote, OddsSnapshot } from "../schema/types.ts";
import { consensus } from "../lib/oddsMath.ts";
import { fmtMoneyline, fmtNative, fmtPct, fmtTime } from "./format.ts";

/**
 * Two-sided implied-probability bar. Red fills from the left, blue from the
 * right, 2px surface gap between them (dataviz spacer rule). Probabilities
 * may not sum to 1 (vig, spread) — the gap position uses the red share of
 * the red+blue total, and the raw numbers are always printed beside it.
 */
function SplitBar({ red, blue }: { red: number; blue: number }) {
  const total = red + blue;
  const redShare = total > 0 ? (red / total) * 100 : 50;
  return (
    <div className="split" role="img" aria-label={`Red ${fmtPct(red)}, blue ${fmtPct(blue)}`}>
      <span className="split-red" style={{ width: `calc(${redShare}% - 1px)` }} />
      <span className="split-blue" style={{ width: `calc(${100 - redShare}% - 1px)` }} />
    </div>
  );
}

function cornerProb(quotes: OddsQuote[], corner: "red" | "blue"): number | null {
  const q = quotes.filter((x) => x.corner === corner);
  if (q.length === 0) return null;
  return q.reduce((s, x) => s + x.impliedProbability, 0) / q.length;
}

function MarketBlock({
  title,
  note,
  snapshot,
  emptyText,
  children,
}: {
  title: string;
  note?: string;
  snapshot: OddsSnapshot | null;
  emptyText: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="market" aria-label={`${title} odds`}>
      <div className="market-head">
        <h3>{title}</h3>
        {snapshot && (
          <span className="freshness">
            as of <span className="num">{fmtTime(snapshot.provenance.fetchedAt)}</span>
          </span>
        )}
      </div>
      {snapshot ? (
        <>
          <MarketBar snapshot={snapshot} />
          {note && <p className="market-note">{note}</p>}
          {children}
        </>
      ) : (
        <p className="empty">{emptyText}</p>
      )}
    </section>
  );
}

function MarketBar({ snapshot }: { snapshot: OddsSnapshot }) {
  const red = cornerProb(snapshot.quotes, "red");
  const blue = cornerProb(snapshot.quotes, "blue");
  if (red == null || blue == null) return <p className="empty">Incomplete quotes.</p>;
  const singleBook = snapshot.market !== "sportsbook";
  const redQuote = snapshot.quotes.find((q) => q.corner === "red");
  const blueQuote = snapshot.quotes.find((q) => q.corner === "blue");
  return (
    <div className="market-bar">
      <span className="market-side">
        <span className="market-pct num">{fmtPct(red)}</span>
        {singleBook && redQuote && (
          <span className="market-native num">{fmtNative(redQuote.native)}</span>
        )}
      </span>
      <SplitBar red={red} blue={blue} />
      <span className="market-side market-side-blue">
        <span className="market-pct num">{fmtPct(blue)}</span>
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

function BookRows({ snapshot }: { snapshot: OddsSnapshot }) {
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
            Red
          </th>
          <th scope="col" className="num">
            Blue
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

export function OddsPanel({ view }: { view: BoutView }) {
  const { latestOdds, bout } = view;
  const finalText =
    bout.status === "final" ? "Market settled — bout is final." : "No market for this bout yet.";
  const agg = consensus(Object.values(latestOdds));
  return (
    <section className="panel" aria-label="Odds comparison">
      <div className="panel-head">
        <h2>Markets</h2>
        <span className="freshness">implied win probability, red vs blue</span>
      </div>
      {agg && agg.markets > 1 && (
        <div className="consensus">
          <span className="market-side">
            <span className="market-pct num">{fmtPct(agg.red)}</span>
            <span className="market-native num">
              {fmtPct(agg.spread.red[0])}–{fmtPct(agg.spread.red[1])}
            </span>
          </span>
          <SplitBar red={agg.red} blue={agg.blue} />
          <span className="market-side market-side-blue">
            <span className="market-pct num">{fmtPct(agg.blue)}</span>
            <span className="market-native num">
              {fmtPct(agg.spread.blue[0])}–{fmtPct(agg.spread.blue[1])}
            </span>
          </span>
          <p className="market-note consensus-note">
            Vig-free consensus across {agg.markets} markets · range shown below each side
          </p>
        </div>
      )}
      <MarketBlock
        title="Kalshi"
        note="Mid of bid/ask, in contract cents."
        snapshot={latestOdds.kalshi ?? null}
        emptyText={finalText}
      />
      <MarketBlock
        title="Polymarket"
        snapshot={latestOdds.polymarket ?? null}
        emptyText={finalText}
      />
      <MarketBlock
        title="Sportsbooks"
        note="Averaged across books; vig included, so sides sum past 100%."
        snapshot={latestOdds.sportsbook ?? null}
        emptyText={finalText}
      >
        <BookRows snapshot={latestOdds.sportsbook!} />
      </MarketBlock>
    </section>
  );
}
