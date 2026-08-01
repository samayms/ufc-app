import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { OddsSnapshot } from "../schema.ts";
import { MarketStrip } from "./MarketStrip.tsx";

function snapshot(market: OddsSnapshot["market"], volume?: number): OddsSnapshot {
  return {
    boutId: "bout-1",
    market,
    quotes: [
      {
        corner: "red",
        native:
          market === "kalshi"
            ? { kind: "kalshi-cents", yesCents: 37, noCents: 63 }
            : market === "polymarket"
              ? { kind: "polymarket-price", price: 0.37 }
              : { kind: "american-moneyline", moneyline: 170, book: "book" },
        impliedProbability: 0.37,
      },
      {
        corner: "blue",
        native:
          market === "kalshi"
            ? { kind: "kalshi-cents", yesCents: 63, noCents: 37 }
            : market === "polymarket"
              ? { kind: "polymarket-price", price: 0.63 }
              : { kind: "american-moneyline", moneyline: -170, book: "book" },
        impliedProbability: 0.63,
      },
    ],
    ...(volume === undefined ? {} : { volume }),
    provenance: {
      source: market === "sportsbook" ? "odds-api" : market,
      fetchedAt: "2026-08-14T12:00:00.000Z",
      synthetic: false,
    },
  };
}

function renderMarket(market: OddsSnapshot["market"]): string {
  return renderToStaticMarkup(
    <MarketStrip
      latestOdds={{ [market]: snapshot(market) }}
      preFightOdds={{}}
      onOpen={() => undefined}
    />,
  );
}

describe("MarketStrip odds source", () => {
  it("shows a settled winner as 100% without mutating the supplied market", () => {
    const latest = { kalshi: snapshot("kalshi") };
    const html = renderToStaticMarkup(
      <MarketStrip
        latestOdds={latest}
        preFightOdds={{}}
        resultWinner="blue"
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain(">0%<");
    expect(html).toContain(">100%<");
    expect(latest.kalshi.quotes[0]?.impliedProbability).toBe(0.37);
  });

  it.each(["kalshi", "polymarket", "sportsbook"] as const)(
    "puts %s on both large percentages",
    (market) => {
      const html = renderMarket(market);

      expect(html.match(new RegExp(`data-odds-source="${market}"`, "g")))
        .toHaveLength(2);
    },
  );

  it("leaves the source absent when there is no snapshot", () => {
    const html = renderToStaticMarkup(
      <MarketStrip
        latestOdds={{}}
        preFightOdds={{}}
        onOpen={() => undefined}
      />,
    );

    expect(html).not.toContain("data-odds-source");
    expect(html.match(/—/g)).toHaveLength(4);
  });

  it("renders the proportional red/blue odds bar in the center", () => {
    const html = renderMarket("kalshi");

    expect(html).toContain('class="market-strip-odds-bar"');
    expect(html).toContain('class="market-strip-odds-red"');
    expect(html).toContain('class="market-strip-odds-blue"');
  });
});

describe("MarketStrip volume gate", () => {
  it("prefers Kalshi over sportsbook once Kalshi volume clears $1000", () => {
    const html = renderToStaticMarkup(
      <MarketStrip
        latestOdds={{
          kalshi: snapshot("kalshi", 1000),
          sportsbook: snapshot("sportsbook"),
        }}
        preFightOdds={{}}
        onOpen={() => undefined}
      />,
    );
    expect(html.match(/data-odds-source="kalshi"/g)).toHaveLength(2);
  });

  it("falls back to sportsbook when Kalshi volume is under $1000", () => {
    const html = renderToStaticMarkup(
      <MarketStrip
        latestOdds={{
          kalshi: snapshot("kalshi", 999),
          sportsbook: snapshot("sportsbook"),
        }}
        preFightOdds={{}}
        onOpen={() => undefined}
      />,
    );
    expect(html.match(/data-odds-source="sportsbook"/g)).toHaveLength(2);
  });

  it("falls back to sportsbook when Kalshi has no reported volume", () => {
    const html = renderToStaticMarkup(
      <MarketStrip
        latestOdds={{
          kalshi: snapshot("kalshi"),
          sportsbook: snapshot("sportsbook"),
        }}
        preFightOdds={{}}
        onOpen={() => undefined}
      />,
    );
    expect(html.match(/data-odds-source="sportsbook"/g)).toHaveLength(2);
  });

  it("falls back to Kalshi under threshold when sportsbook odds are unavailable", () => {
    const html = renderToStaticMarkup(
      <MarketStrip
        latestOdds={{ kalshi: snapshot("kalshi", 5) }}
        preFightOdds={{}}
        onOpen={() => undefined}
      />,
    );
    expect(html.match(/data-odds-source="kalshi"/g)).toHaveLength(2);
  });
});
