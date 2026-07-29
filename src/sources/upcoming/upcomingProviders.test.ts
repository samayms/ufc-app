import { describe, expect, it } from "vitest";

import fixture from "../../fixtures/upcomingProvidersLive.json" with {
  type: "json",
};
import {
  kalshiMarketTickers,
  parseKalshiUpcomingMarkets,
} from "./kalshiUpcoming.ts";
import {
  parsePolymarketUpcomingMarkets,
  polymarketOutcomeTokens,
  polymarketTitleWeightClass,
} from "./polymarketUpcoming.ts";
import {
  oddsApiIoPromotion,
  parseOddsApiIoUpcomingEvents,
  parseOddsApiIoUpcomingOdds,
  selectPricedEvents,
  type OddsApiIoUpcomingEvent,
} from "./oddsApiIoUpcoming.ts";
import { parseTheOddsApiUpcomingMarkets } from "./theOddsApiUpcoming.ts";
import { createTheOddsApiUpcomingProvider } from "./theOddsApiUpcoming.ts";
import { redactUrl, UpcomingProviderError } from "./types.ts";

describe("kalshi upcoming discovery", () => {
  it("reduces each event to one fight with two priced sides", () => {
    const markets = parseKalshiUpcomingMarkets(fixture.kalshiEvents);

    expect(markets.length).toBeGreaterThan(0);
    const first = markets[0];
    expect(first?.externalId).toMatch(/^KXUFCFIGHT-/);
    expect(first?.firstFighter.length).toBeGreaterThan(0);
    expect(first?.secondFighter.length).toBeGreaterThan(0);
    expect(first?.promotion).toBe("ufc");
    expect(first?.quotes.map((quote) => quote.side)).toEqual([
      "first",
      "second",
    ]);
    for (const quote of first?.quotes ?? []) {
      expect(quote.native.kind).toBe("kalshi-cents");
      expect(quote.impliedProbability).toBeGreaterThan(0);
      expect(quote.impliedProbability).toBeLessThan(1);
    }
  });

  it("carries the per-fighter market tickers the live socket needs", () => {
    const tickers = kalshiMarketTickers(fixture.kalshiEvents);
    const markets = parseKalshiUpcomingMarkets(fixture.kalshiEvents);
    const first = markets[0];
    expect(first).toBeDefined();
    expect(tickers.get(first?.externalId ?? "")).toHaveLength(2);
  });

  it("drops an event that does not list exactly two fighters", () => {
    expect(
      parseKalshiUpcomingMarkets({
        events: [
          {
            event_ticker: "KXUFCFIGHT-ODD",
            markets: [
              { ticker: "A", yes_sub_title: "Only One", yes_bid_dollars: "0.5" },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("returns no markets rather than throwing on an empty envelope", () => {
    expect(parseKalshiUpcomingMarkets({})).toEqual([]);
  });
});

describe("polymarket upcoming discovery", () => {
  it("picks the fight-winner market and ignores the prop markets", () => {
    const markets = parsePolymarketUpcomingMarkets(fixture.polymarketEvents);

    expect(markets.length).toBeGreaterThan(0);
    for (const market of markets) {
      expect(market.externalId).toMatch(/^0x/);
      expect(market.firstFighter.toLowerCase()).not.toBe("yes");
      expect(market.secondFighter.toLowerCase()).not.toBe("yes");
      for (const quote of market.quotes) {
        expect(quote.native.kind).toBe("polymarket-price");
      }
    }
  });

  it("reads the weight class out of the event title", () => {
    expect(
      polymarketTitleWeightClass(
        "UFC Fight Night: A vs. B (Welterweight, Main Card)",
      ),
    ).toBe("Welterweight");
    expect(polymarketTitleWeightClass("UFC Fight Night: A vs. B")).toBeUndefined();
  });

  it("exposes the two CLOB outcome tokens per condition id", () => {
    const tokens = polymarketOutcomeTokens(fixture.polymarketEvents);
    const markets = parsePolymarketUpcomingMarkets(fixture.polymarketEvents);
    expect(tokens.get(markets[0]?.externalId ?? "")).toHaveLength(2);
  });

  it("skips closed events", () => {
    expect(
      parsePolymarketUpcomingMarkets([
        {
          title: "UFC: A vs. B",
          closed: true,
          markets: [
            {
              conditionId: "0xdead",
              outcomes: '["A","B"]',
              outcomePrices: '["0.5","0.5"]',
            },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("emits no quote for an empty book rather than a fabricated certainty", () => {
    const markets = parsePolymarketUpcomingMarkets([
      {
        title: "UFC: A vs. B",
        markets: [
          {
            conditionId: "0xbeef",
            outcomes: '["A","B"]',
            outcomePrices: '["0","1"]',
            bestBid: 0,
            bestAsk: 1,
          },
        ],
      },
    ]);
    expect(markets).toHaveLength(1);
    expect(markets[0]?.quotes).toEqual([]);
  });
});

describe("odds-api.io upcoming discovery", () => {
  it("normalizes the flat events array into bouts", () => {
    const events = parseOddsApiIoUpcomingEvents(fixture.oddsApiIoEvents);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.promotion).toBe("ufc");
    expect(events[0]?.firstFighter).toContain(",");
  });

  it("derives the promotion from the league name", () => {
    expect(oddsApiIoPromotion("UFC - UFC Fight Night: Medic vs. Rodriguez")).toBe(
      "ufc",
    );
    expect(oddsApiIoPromotion("PFL - PFL New York")).toBe("pfl");
    expect(oddsApiIoPromotion(undefined)).toBeUndefined();
  });

  it("normalizes the positional home/away decimal odds", () => {
    const { quotes } = parseOddsApiIoUpcomingOdds(fixture.oddsApiIoEventOdds);
    expect(quotes).toHaveLength(2);
    expect(quotes[0]?.side).toBe("first");
    expect(quotes[1]?.side).toBe("second");
    for (const quote of quotes) {
      expect(quote.native.kind).toBe("american-moneyline");
      expect(quote.impliedProbability).toBeGreaterThan(0);
      expect(quote.impliedProbability).toBeLessThan(1);
    }
  });

  it("caps priced events and prefers the nearest card", () => {
    const events: OddsApiIoUpcomingEvent[] = [
      {
        eventId: "3",
        firstFighter: "C",
        secondFighter: "D",
        startsAt: "2026-09-01T00:00:00Z",
        leagueName: "UFC - UFC 999",
      },
      {
        eventId: "1",
        firstFighter: "A",
        secondFighter: "B",
        startsAt: "2026-08-01T00:00:00Z",
        leagueName: "UFC - UFC Fight Night",
      },
      {
        eventId: "2",
        firstFighter: "E",
        secondFighter: "F",
        startsAt: "2026-08-02T00:00:00Z",
        leagueName: "PFL - PFL 5",
      },
    ];

    expect(selectPricedEvents(events, 5, /ufc/iu).map((e) => e.eventId)).toEqual([
      "1",
      "3",
    ]);
    expect(selectPricedEvents(events, 1, /ufc/iu).map((e) => e.eventId)).toEqual([
      "1",
    ]);
  });
});

describe("the odds api upcoming discovery", () => {
  it("normalizes every book's h2h outcome onto the two listed fighters", () => {
    const markets = parseTheOddsApiUpcomingMarkets(fixture.theOddsApiOdds);
    expect(markets.length).toBeGreaterThan(0);
    const priced = markets.find((market) => market.quotes.length > 0);
    expect(priced).toBeDefined();
    expect(new Set(priced?.quotes.map((quote) => quote.side))).toEqual(
      new Set(["first", "second"]),
    );
  });

  it("drops an outcome that names neither fighter", () => {
    const markets = parseTheOddsApiUpcomingMarkets([
      {
        id: "evt",
        home_team: "A",
        away_team: "B",
        bookmakers: [
          {
            key: "book",
            markets: [
              {
                key: "h2h",
                last_update: "2026-07-29T00:00:00Z",
                outcomes: [
                  { name: "A", price: -150 },
                  { name: "Draw", price: 1200 },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(markets[0]?.quotes).toHaveLength(1);
  });

  it("records remaining quota and never leaks the key in an error", async () => {
    const provider = createTheOddsApiUpcomingProvider({
      apiKey: "super-secret-key",
      fetchImpl: (async () =>
        new Response("nope", {
          status: 429,
          headers: { "x-requests-remaining": "0", "x-requests-used": "500" },
        })) as unknown as typeof fetch,
    });

    await expect(provider.listMarkets()).rejects.toThrow(UpcomingProviderError);
    await provider.listMarkets().catch((error: unknown) => {
      expect(String(error)).not.toContain("super-secret-key");
    });
    expect(provider.lastQuota()).toEqual({ remaining: 0, used: 500 });
  });
});

describe("redactUrl", () => {
  it("replaces every query value", () => {
    expect(redactUrl("https://example.com/v3/odds?apiKey=abc&eventId=7")).toBe(
      "https://example.com/v3/odds?apiKey=%E2%80%A6&eventId=%E2%80%A6",
    );
  });
});
