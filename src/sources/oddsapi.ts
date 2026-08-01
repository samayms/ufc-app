import rawOdds from "../fixtures/oddsapi.json" with { type: "json" };
import rawTicks from "../fixtures/oddsapiTicks.json" with { type: "json" };
import { americanToImpliedProb } from "../lib/oddsMath.ts";
import type {
  Bout,
  Corner,
  OddsQuote,
  OddsSnapshot,
} from "../schema.ts";
import type {
  MarketSource,
  MarketTick,
  OddsSource,
  SourceConfig,
} from "./contract.ts";
import {
  fetchProviderJson,
  type UpcomingFetchOptions,
} from "./upcoming/types.ts";
import {
  buildTheOddsApiUpcomingUrl,
  parseTheOddsApiUpcomingMarkets,
  THE_ODDS_API_SPORT,
} from "./upcoming/theOddsApiUpcoming.ts";

export const THE_ODDS_API_H2H_REQUEST = {
  sport: "mma_mixed_martial_arts",
  region: "us",
  market: "h2h",
} as const;

export interface TheOddsApiH2hRequest {
  sport: typeof THE_ODDS_API_H2H_REQUEST.sport;
  region: typeof THE_ODDS_API_H2H_REQUEST.region;
  market: typeof THE_ODDS_API_H2H_REQUEST.market;
}

export interface TheOddsApiSource extends OddsSource {
  getH2hSnapshot(
    bout: Bout,
    request: TheOddsApiH2hRequest,
  ): Promise<OddsSnapshot | null>;
  getTickHistory(
    boutId: string,
    source?: MarketSource,
  ): Promise<MarketTick[]>;
}

export interface TheOddsApiLiveHook {
  getH2hSnapshot(
    apiKey: string,
    bout: Bout,
    request: TheOddsApiH2hRequest,
  ): Promise<OddsSnapshot | null>;
}

export type TheOddsApiLiveHookOptions = UpcomingFetchOptions;

interface OddsApiOutcome {
  name: string;
  price: number;
}

interface OddsApiMarket {
  key: string;
  last_update: string;
  outcomes: OddsApiOutcome[];
}

interface OddsApiBookmaker {
  key: string;
  last_update: string;
  markets: OddsApiMarket[];
}

export interface OddsApiEvent {
  home_team: string;
  away_team: string;
  bookmakers: OddsApiBookmaker[];
}

const oddsEvents = rawOdds as OddsApiEvent[];
const oddsTicks = rawTicks.ticks as MarketTick[];

function findCorner(bout: Bout, fighterName: string): Corner | null {
  if (bout.fighters.red.name === fighterName) {
    return "red";
  }

  if (bout.fighters.blue.name === fighterName) {
    return "blue";
  }

  return null;
}

function matchesBout(event: OddsApiEvent, bout: Bout): boolean {
  const eventNames = new Set([event.home_team, event.away_team]);
  return (
    eventNames.has(bout.fighters.red.name) &&
    eventNames.has(bout.fighters.blue.name)
  );
}

/**
 * Pure normalization of a `GET /v4/sports/{sport}/odds` array into a snapshot
 * for one bout. Verified live 2026-07-28 against
 * api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds?regions=us&markets=h2h
 * (HTTP 200): the documented shape below — an array of events carrying
 * home_team/away_team and bookmakers[].markets[].outcomes[] with American
 * prices — matched this parser exactly, with no changes required.
 *
 * `synthetic` is the caller's to declare, since the same shape serves both
 * the bundled fixture and a live response.
 */
export function parseTheOddsApiSnapshot(
  events: readonly OddsApiEvent[],
  bout: Bout,
  synthetic: boolean,
): OddsSnapshot | null {
  const event = events.find((candidate) => matchesBout(candidate, bout));
  if (!event) {
    return null;
  }

  const quotes: OddsQuote[] = [];
  const marketUpdates: string[] = [];

  for (const bookmaker of event.bookmakers) {
    const market = bookmaker.markets.find((candidate) => candidate.key === "h2h");
    if (!market) {
      continue;
    }

    marketUpdates.push(market.last_update);

    for (const outcome of market.outcomes) {
      const corner = findCorner(bout, outcome.name);
      if (!corner) {
        continue;
      }

      quotes.push({
        corner,
        native: {
          kind: "american-moneyline",
          moneyline: outcome.price,
          book: bookmaker.key,
        },
        impliedProbability: americanToImpliedProb(outcome.price),
      });
    }
  }

  if (quotes.length === 0) {
    return null;
  }

  const marketUpdatedAt = marketUpdates.sort().at(-1);

  return {
    boutId: bout.id,
    market: "sportsbook",
    quotes,
    marketUpdatedAt,
    provenance: {
      source: "odds-api",
      fetchedAt: marketUpdatedAt ?? event.bookmakers[0]?.last_update ?? "",
      synthetic,
    },
  };
}

function parseSnapshot(bout: Bout): OddsSnapshot | null {
  return parseTheOddsApiSnapshot(oddsEvents, bout, true);
}

function sameFighterPair(
  first: string,
  second: string,
  bout: Bout,
): boolean {
  const names = new Set([bout.fighters.red.name, bout.fighters.blue.name]);
  return names.has(first) && names.has(second);
}

export function createTheOddsApiLiveHook(
  options: TheOddsApiLiveHookOptions = {},
): TheOddsApiLiveHook {
  return {
    async getH2hSnapshot(
      apiKey: string,
      bout: Bout,
      request: TheOddsApiH2hRequest,
    ): Promise<OddsSnapshot | null> {
      if (
        apiKey.trim().length === 0 ||
        request.sport !== THE_ODDS_API_SPORT ||
        request.region !== "us" ||
        request.market !== "h2h"
      ) {
        return null;
      }

      try {
        const markets = parseTheOddsApiUpcomingMarkets(
          await fetchProviderJson(
            "odds-api",
            buildTheOddsApiUpcomingUrl(apiKey, "us"),
            options,
          ),
        );
        const market = markets.find((candidate) =>
          sameFighterPair(candidate.firstFighter, candidate.secondFighter, bout),
        );
        if (market === undefined || market.quotes.length === 0) return null;

        const quotes = market.quotes.flatMap((quote) => {
          const corner =
            quote.side === "first"
              ? bout.fighters.red.name === market.firstFighter
                ? "red"
                : "blue"
              : bout.fighters.red.name === market.secondFighter
                ? "red"
                : "blue";
          return [{
            corner,
            native: quote.native,
            impliedProbability: quote.impliedProbability,
          } satisfies OddsQuote];
        });
        if (quotes.length === 0) return null;

        const fetchedAt = new Date().toISOString();
        return {
          boutId: bout.id,
          market: "sportsbook",
          quotes,
          ...(market.marketUpdatedAt === undefined
            ? {}
            : { marketUpdatedAt: market.marketUpdatedAt }),
          provenance: {
            source: "odds-api",
            fetchedAt,
            synthetic: false,
          },
        };
      } catch {
        // This source is a broad comparison only; a failed request is omitted
        // and the round job deliberately has no retry policy.
        return null;
      }
    },
  };
}

export function createOddsApiSource(
  config: SourceConfig,
  liveHook?: TheOddsApiLiveHook,
): TheOddsApiSource {
  if (config.mode === "live") {
    const apiKey = config.credentials?.THE_ODDS_API_KEY?.trim();
    const failClosed = (): never => {
      throw new Error("The Odds API live source is not installed");
    };
    if (liveHook !== undefined && apiKey !== undefined && apiKey.length > 0) {
      return {
        async getH2hSnapshot(
          bout: Bout,
          request: TheOddsApiH2hRequest,
        ): Promise<OddsSnapshot | null> {
          return liveHook.getH2hSnapshot(apiKey, bout, request);
        },
        async getOddsSnapshot(bout: Bout): Promise<OddsSnapshot | null> {
          return liveHook.getH2hSnapshot(
            apiKey,
            bout,
            THE_ODDS_API_H2H_REQUEST,
          );
        },
        async getTickHistory() {
          return failClosed();
        },
      };
    }
    return {
      async getH2hSnapshot() {
        return failClosed();
      },
      async getOddsSnapshot() {
        return failClosed();
      },
      async getTickHistory() {
        return failClosed();
      },
    };
  }

  const getH2hSnapshot = async (
    bout: Bout,
    request: TheOddsApiH2hRequest,
  ): Promise<OddsSnapshot | null> => {
    if (
      request.sport !== THE_ODDS_API_H2H_REQUEST.sport ||
      request.region !== THE_ODDS_API_H2H_REQUEST.region ||
      request.market !== THE_ODDS_API_H2H_REQUEST.market
    ) {
      return null;
    }
    return parseSnapshot(bout);
  };
  return {
    getH2hSnapshot,
    async getOddsSnapshot(bout: Bout): Promise<OddsSnapshot | null> {
      return getH2hSnapshot(bout, THE_ODDS_API_H2H_REQUEST);
    },
    async getTickHistory(
      boutId: string,
      source?: MarketSource,
    ): Promise<MarketTick[]> {
      if (source !== undefined && source !== "the-odds-api") return [];
      return oddsTicks.filter((tick) => tick.boutId === boutId);
    },
  };
}
