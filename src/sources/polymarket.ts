import rawFixture from "../fixtures/polymarket/raw.json";
import type { Bout, Corner, OddsQuote, OddsSnapshot } from "../schema/types.ts";
import type { OddsSource, SourceConfig } from "./contract.ts";

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
  const quotes = corners.map((corner, index): OddsQuote | null => {
    const tokenId = tokenIds[index];
    if (!tokenId) {
      return null;
    }

    const price = priceForToken(
      market.conditionId,
      tokenId,
      fallbackPrices[index],
    );

    return price === null
      ? null
      : {
          corner,
          native: { kind: "polymarket-price", price },
          impliedProbability: price,
        };
  });

  if (quotes.some((quote) => quote === null)) {
    return null;
  }

  return {
    boutId: bout.id,
    market: "polymarket",
    quotes: quotes as OddsQuote[],
    marketUpdatedAt: market.updatedAt,
    provenance: {
      source: "polymarket",
      fetchedAt: fixture.rawTimestamp,
      synthetic: true,
    },
  };
}

export function createPolymarketSource(config: SourceConfig): OddsSource {
  if (config.mode === "live") {
    throw new Error("polymarket live mode not available yet");
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
  };
}
