/**
 * Fixture-mode providers for the upcoming-odds sync.
 *
 * These deliberately run the *real* parsers over provider-native payloads
 * rather than returning pre-normalized markets. If a parser regresses, fixture
 * mode breaks too — which is the only reason a fixture is worth having, given
 * live credentials exist and the live path is the one that matters.
 *
 * The bundled payloads are aligned with the UFC 330 card in
 * `espnFightcenter.json` and cover uneven provider coverage on purpose, so
 * `loaded`, `not_listed` and the unpriced-market path are all reachable
 * without a network.
 */

import fixture from "../../fixtures/upcomingSync.json" with { type: "json" };
import { parseKalshiUpcomingMarkets } from "./kalshiUpcoming.ts";
import { parsePolymarketUpcomingMarkets } from "./polymarketUpcoming.ts";
import {
  parseOddsApiIoUpcomingEvents,
  parseOddsApiIoUpcomingOdds,
  selectPricedEvents,
} from "./oddsApiIoUpcoming.ts";
import { parseTheOddsApiUpcomingMarkets } from "./theOddsApiUpcoming.ts";
import type {
  UpcomingOddsProvider,
  UpcomingProviderMarket,
} from "./types.ts";

/** The ESPN event id the bundled provider fixtures were built against. */
export const FIXTURE_UPCOMING_EVENT_ID = fixture.espnEventId;

function kalshiProvider(): UpcomingOddsProvider {
  return {
    id: "kalshi",
    async listMarkets() {
      return parseKalshiUpcomingMarkets(fixture.kalshiEvents);
    },
  };
}

function polymarketProvider(): UpcomingOddsProvider {
  return {
    id: "polymarket",
    async listMarkets() {
      return parsePolymarketUpcomingMarkets(fixture.polymarketEvents);
    },
  };
}

function oddsApiIoProvider(): UpcomingOddsProvider {
  return {
    id: "odds-api-io",
    async listMarkets() {
      const events = selectPricedEvents(
        parseOddsApiIoUpcomingEvents(fixture.oddsApiIoEvents),
        20,
        /ufc/iu,
      );
      const oddsById = fixture.oddsApiIoOddsByEventId as Record<
        string,
        unknown
      >;
      return events.flatMap((event): UpcomingProviderMarket[] => {
        const raw = oddsById[event.eventId];
        if (raw === undefined) return [];
        const { quotes, marketUpdatedAt } = parseOddsApiIoUpcomingOdds(raw);
        return [
          {
            externalId: event.eventId,
            firstFighter: event.firstFighter,
            secondFighter: event.secondFighter,
            ...(event.startsAt === undefined
              ? {}
              : { startsAt: event.startsAt }),
            ...(event.promotion === undefined
              ? {}
              : { promotion: event.promotion }),
            ...(event.leagueName === undefined
              ? {}
              : { eventName: event.leagueName }),
            ...(marketUpdatedAt === undefined ? {} : { marketUpdatedAt }),
            quotes,
          },
        ];
      });
    },
  };
}

function theOddsApiProvider(): UpcomingOddsProvider {
  return {
    id: "odds-api",
    async listMarkets() {
      return parseTheOddsApiUpcomingMarkets(fixture.theOddsApiOdds);
    },
  };
}

export function createFixtureUpcomingProviders(): UpcomingOddsProvider[] {
  return [
    kalshiProvider(),
    polymarketProvider(),
    oddsApiIoProvider(),
    theOddsApiProvider(),
  ];
}
