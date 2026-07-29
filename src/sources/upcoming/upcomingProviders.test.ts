import { describe, expect, it } from "vitest";

import fixture from "../../fixtures/upcomingProvidersLive.json" with {
  type: "json",
};
import {
  parseKalshiDistanceMarkets,
  kalshiMarketTickers,
  parseKalshiUpcomingMarkets,
} from "./kalshiUpcoming.ts";
import {
  parsePolymarketDistanceMarket,
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

  it("treats an absent distance series as a normal empty result", () => {
    expect(parseKalshiDistanceMarkets({ markets: [] })).toEqual(new Map());
  });

  it("joins a listed distance market by the verified fight ticker key", () => {
    const distance = parseKalshiDistanceMarkets({
      markets: [
        {
          ticker: "KXUFCDISTANCE-26JUL25GIBHUS-DIST",
          last_price_dollars: "0.62",
        },
      ],
    });
    const markets = parseKalshiUpcomingMarkets(
      {
        events: [
          {
            event_ticker: "KXUFCFIGHT-26JUL25GIBHUS",
            markets: [
              {
                ticker: "KXUFCFIGHT-26JUL25GIBHUS-GIB",
                yes_sub_title: "First Fighter",
                yes_bid_dollars: "0.5",
              },
              {
                ticker: "KXUFCFIGHT-26JUL25GIBHUS-HUS",
                yes_sub_title: "Second Fighter",
                yes_bid_dollars: "0.5",
              },
            ],
          },
        ],
      },
      distance,
    );
    expect(markets[0]?.decision?.decisionProbability).toBeCloseTo(0.62);
  });

  it("captures Kalshi win-market volume and open interest", () => {
    const [market] = parseKalshiUpcomingMarkets({
      events: [
        {
          event_ticker: "KXUFCFIGHT-META",
          markets: [
            {
              ticker: "KXUFCFIGHT-META-A",
              yes_sub_title: "A",
              yes_bid_dollars: "0.5",
              volume_fp: "12.5",
              open_interest_fp: "4",
            },
            {
              ticker: "KXUFCFIGHT-META-B",
              yes_sub_title: "B",
              yes_bid_dollars: "0.5",
              volume_fp: "7.5",
              open_interest_fp: "6",
            },
          ],
        },
      ],
    });
    expect(market?.metadata).toEqual({ volume: 20, openInterest: 10 });
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

  it("accepts a liquid, tight distance market", () => {
    const decision = parsePolymarketDistanceMarket({
      conditionId: "0xdistance",
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0.475", "0.525"]',
      bestBid: 0.43,
      bestAsk: 0.51,
      liquidity: "1000",
    });
    expect(decision?.decisionProbability).toBeCloseTo(0.47);
    expect(decision?.finishProbability).toBeCloseTo(0.53);
  });

  it("rejects an untraded distance market even when outcome prices exist", () => {
    expect(
      parsePolymarketDistanceMarket({
        conditionId: "0xuntraded",
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.475", "0.525"]',
        bestBid: 0.04,
        bestAsk: 0.91,
        liquidity: "116.3016",
      }),
    ).toBeUndefined();
  });

  it("captures Polymarket win-market volume, 24-hour volume, and liquidity", () => {
    const [market] = parsePolymarketUpcomingMarkets([
      {
        title: "UFC: A vs. B",
        markets: [
          {
            conditionId: "0xwinner",
            outcomes: '["A", "B"]',
            outcomePrices: '["0.4", "0.6"]',
            volume: "1234.5",
            volume24hr: "67.8",
            liquidity: "910.11",
          },
        ],
      },
    ]);
    expect(market?.metadata).toEqual({
      volume: 1234.5,
      volume24hr: 67.8,
      liquidity: 910.11,
    });
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
    expect(parseOddsApiIoUpcomingOdds(fixture.oddsApiIoEventOdds).metadata).toEqual({
      bookmakerCount: 1,
    });
  });

  it("parses distance prices by label and de-vigs complementary outcomes", () => {
    const { decision } = parseOddsApiIoUpcomingOdds({
      bookmakers: {
        Bet365: [
          {
            name: "ML",
            odds: [{ home: "3.3", away: "1.35" }],
          },
          {
            name: "Fight to Go the Distance",
            odds: [
              { label: "No", under: "1.09" },
              { label: "Yes", under: "7.25" },
            ],
          },
        ],
      },
    });
    expect(decision?.decisionProbability).toBeCloseTo(
      (1 / 7.25) / (1 / 7.25 + 1 / 1.09),
    );
    expect(
      (decision?.decisionProbability ?? 0) + (decision?.finishProbability ?? 0),
    ).toBeCloseTo(1);
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
    expect(priced?.metadata).toEqual({ bookmakerCount: 1 });
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

  it("never requests a distance market from The Odds API", async () => {
    const urls: string[] = [];
    const provider = createTheOddsApiUpcomingProvider({
      apiKey: "not-used",
      fetchImpl: (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return new Response("[]", { status: 200 });
      }) as typeof fetch,
    });

    await provider.listMarkets();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("markets=h2h");
    expect(urls[0]).not.toMatch(/distance|fight_result|method_of_victory/i);
  });
});

describe("redactUrl", () => {
  it("replaces every query value", () => {
    expect(redactUrl("https://example.com/v3/odds?apiKey=abc&eventId=7")).toBe(
      "https://example.com/v3/odds?apiKey=%E2%80%A6&eventId=%E2%80%A6",
    );
  });
});
