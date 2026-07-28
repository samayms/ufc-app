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

/**
 * The market shape the live API actually returns, captured 2026-07-28 from
 * api.elections.kalshi.com/trade-api/v2/markets (HTTP 200). Prices arrive as
 * dollar-denominated *strings* ("0.6300"); the integer-cent fields this
 * client was written against (`yes_bid`, `yes_ask`, `last_price`) are absent
 * from the current API entirely. Everything below normalizes back to cents so
 * the rest of the client — and the `kalshi-cents` native odds kind — is
 * unchanged.
 */
interface KalshiLiveMarket {
  ticker?: unknown;
  status?: unknown;
  yes_bid_dollars?: unknown;
  yes_ask_dollars?: unknown;
  no_bid_dollars?: unknown;
  no_ask_dollars?: unknown;
  last_price_dollars?: unknown;
}

/** "0.6300" -> 63. Returns 0 for absent or unparseable prices. */
function dollarsToCents(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100 * 1e6) / 1e6;
}

/**
 * Normalizes one live market into the internal cents shape. Returns null when
 * the payload carries no usable ticker, so callers render absence instead of
 * crashing mid-event.
 */
export function parseKalshiLiveMarket(raw: unknown): KalshiMarket | null {
  if (typeof raw !== "object" || raw === null) return null;
  const market = raw as KalshiLiveMarket;
  if (typeof market.ticker !== "string" || market.ticker.length === 0) {
    return null;
  }

  return {
    ticker: market.ticker,
    status: typeof market.status === "string" ? market.status : "",
    yes_bid: dollarsToCents(market.yes_bid_dollars),
    yes_ask: dollarsToCents(market.yes_ask_dollars),
    no_bid: dollarsToCents(market.no_bid_dollars),
    no_ask: dollarsToCents(market.no_ask_dollars),
    last_price: dollarsToCents(market.last_price_dollars),
  };
}

/**
 * Normalizes a `GET /trade-api/v2/markets` response. The live envelope is
 * `{ cursor, markets }` at the top level; the bundled fixture nests the same
 * array under `markets_response`, so both are accepted.
 */
export function parseKalshiMarketsResponse(payload: unknown): KalshiMarket[] {
  if (typeof payload !== "object" || payload === null) {
    throw new TypeError("Kalshi markets response was not a JSON object");
  }

  const envelope = payload as {
    markets?: unknown;
    markets_response?: { markets?: unknown };
  };
  const markets = Array.isArray(envelope.markets)
    ? envelope.markets
    : Array.isArray(envelope.markets_response?.markets)
      ? envelope.markets_response.markets
      : [];

  return markets.flatMap((market) => {
    const parsed = parseKalshiLiveMarket(market);
    return parsed === null ? [] : [parsed];
  });
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
