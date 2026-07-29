import rawFixture from "../fixtures/polymarket.json" with { type: "json" };
import rawTicksFixture from "../fixtures/polymarketTicks.json" with { type: "json" };
import type { Bout, Corner, OddsQuote, OddsSnapshot } from "../schema.ts";
import type {
  MarketSource,
  MarketTick,
  OddsSourceWithHistory,
  SourceConfig,
} from "./contract.ts";

interface GammaMarket {
  conditionId: string;
  outcomes: string;
  outcomePrices: string;
  clobTokenIds: string;
  updatedAt: string;
}

interface ClobPriceResponse {
  condition_id: string;
  token_id: string;
  buy: { price: string };
  sell: { price: string };
}

const fixture = rawFixture as {
  rawTimestamp: string;
  conditionIdByBoutId: Record<string, string>;
  gamma: { markets: GammaMarket[] };
  clob: { priceResponses: ClobPriceResponse[] };
};

function parseJsonArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    return [];
  }

  return parsed;
}

function priceForToken(
  conditionId: string,
  tokenId: string,
  fallbackPrice: string | undefined,
): number | null {
  const response = fixture.clob.priceResponses.find(
    (candidate) =>
      candidate.condition_id === conditionId && candidate.token_id === tokenId,
  );
  const buy = response ? Number(response.buy.price) : Number.NaN;
  const sell = response ? Number(response.sell.price) : Number.NaN;
  const price =
    Number.isFinite(buy) && Number.isFinite(sell)
      ? (buy + sell) / 2
      : Number(fallbackPrice);

  return Number.isFinite(price) && price > 0 && price < 1 ? price : null;
}

function parseMarket(bout: Bout, market: GammaMarket): OddsSnapshot | null {
  const outcomes = parseJsonArray(market.outcomes);
  const tokenIds = parseJsonArray(market.clobTokenIds);
  const fallbackPrices = parseJsonArray(market.outcomePrices);

  if (outcomes.length < 2 || tokenIds.length < 2) {
    return null;
  }

  const corners: Corner[] = ["red", "blue"];
  const quotes: OddsQuote[] = [];

  for (const [index, corner] of corners.entries()) {
    const tokenId = tokenIds[index];
    if (!tokenId) {
      return null;
    }

    const price = priceForToken(
      market.conditionId,
      tokenId,
      fallbackPrices[index],
    );
    if (price === null) {
      return null;
    }

    quotes.push({
      corner,
      native: { kind: "polymarket-price", price },
      impliedProbability: price,
    });
  }

  return {
    boutId: bout.id,
    market: "polymarket",
    quotes,
    marketUpdatedAt: market.updatedAt,
    provenance: {
      source: "polymarket",
      fetchedAt: fixture.rawTimestamp,
      synthetic: true,
    },
  };
}

const ticks = rawTicksFixture.ticks as MarketTick[];

export function createPolymarketSource(
  config: SourceConfig,
): OddsSourceWithHistory {
  if (config.mode === "live") {
    return {
      async getOddsSnapshot() {
        return null;
      },
      async getTickHistory() {
        return [];
      },
    };
  }

  return {
    async getOddsSnapshot(bout) {
      const externalConditionId = bout.externalRefs.find(
        (ref) => ref.source === "polymarket",
      )?.id;
      // Fixture-only bridge: raw.json maps canonical bout ids to Gamma condition ids.
      const conditionId =
        externalConditionId ?? fixture.conditionIdByBoutId[bout.id];
      const market = fixture.gamma.markets.find(
        (candidate) => candidate.conditionId === conditionId,
      );

      return market ? parseMarket(bout, market) : null;
    },

    async getTickHistory(
      boutId: string,
      source?: MarketSource,
    ): Promise<MarketTick[]> {
      if (source !== undefined && source !== "polymarket") return [];
      return ticks.filter((tick) => tick.boutId === boutId);
    },
  };
}
