import rawOdds from "../fixtures/oddsapi.json" with { type: "json" };
import { americanToImpliedProb } from "../lib/oddsMath.ts";
import type {
  Bout,
  Corner,
  OddsQuote,
  OddsSnapshot,
} from "../schema.ts";
import type { OddsSource, SourceConfig } from "./contract.ts";

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

interface OddsApiEvent {
  home_team: string;
  away_team: string;
  bookmakers: OddsApiBookmaker[];
}

const oddsEvents = rawOdds as OddsApiEvent[];

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

function parseSnapshot(bout: Bout): OddsSnapshot | null {
  const event = oddsEvents.find((candidate) => matchesBout(candidate, bout));
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
      synthetic: true,
    },
  };
}

export function createOddsApiSource(config: SourceConfig): OddsSource {
  if (config.mode === "live") {
    throw new Error("odds-api live mode not available yet");
  }

  return {
    async getOddsSnapshot(bout: Bout): Promise<OddsSnapshot | null> {
      return parseSnapshot(bout);
    },
  };
}
