/**
 * Kalshi market client. Public market data needs no auth for reads; the
 * RSA-PSS signer in kalshiAuth.ts covers tomorrow's authenticated
 * endpoints. Kalshi lists one YES/NO market per fighter, priced in cents;
 * a bout's red/blue tickers are reconciled through the fixture's
 * boutTickers map (live mode will key off ExternalRefs with source
 * "kalshi" instead). Kalshi data is licensed for personal use only —
 * never redisplayed publicly.
 */

import type { Corner, OddsQuote, OddsSnapshot } from "../schema.ts";
import type {
  MarketSource,
  MarketTick,
  OddsSourceWithHistory,
  SourceConfig,
} from "./contract.ts";
import fixture from "../fixtures/kalshi.json" with { type: "json" };
import ticksFixture from "../fixtures/kalshiTicks.json" with { type: "json" };

interface KalshiMarket {
  ticker: string;
  status: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
}

/** Mid of bid/ask, falling back to last trade when the book is empty. */
function midCents(market: KalshiMarket): number {
  if (market.yes_bid > 0 && market.yes_ask > 0) {
    return (market.yes_bid + market.yes_ask) / 2;
  }
  return market.last_price;
}

function toQuote(market: KalshiMarket, corner: Corner): OddsQuote {
  const yes = midCents(market);
  return {
    corner,
    native: {
      kind: "kalshi-cents",
      yesCents: yes,
      noCents: 100 - yes,
    },
    impliedProbability: yes / 100,
  };
}

const ticks = ticksFixture.ticks as MarketTick[];

export function createKalshiSource(config: SourceConfig): OddsSourceWithHistory {
  if (config.mode === "live") {
    throw new Error("kalshi live mode not available yet");
  }

  const markets = new Map<string, KalshiMarket>(
    fixture.markets_response.markets.map((m) => [m.ticker, m]),
  );
  const boutTickers = fixture.boutTickers as Record<
    string,
    Record<Corner, string> | undefined
  >;

  return {
    async getOddsSnapshot(bout): Promise<OddsSnapshot | null> {
      const tickers = boutTickers[bout.id];
      if (!tickers) return null;
      const red = markets.get(tickers.red);
      const blue = markets.get(tickers.blue);
      if (!red || !blue || red.status !== "active" || blue.status !== "active") {
        return null;
      }
      return {
        boutId: bout.id,
        market: "kalshi",
        quotes: [toQuote(red, "red"), toQuote(blue, "blue")],
        provenance: {
          source: "kalshi",
          fetchedAt: fixture.fetchedAt,
          synthetic: true,
        },
      };
    },

    async getTickHistory(
      boutId: string,
      source?: MarketSource,
    ): Promise<MarketTick[]> {
      if (source !== undefined && source !== "kalshi") return [];
      return ticks.filter((tick) => tick.boutId === boutId);
    },
  };
}
