import { describe, expect, it } from "vitest";

import type { OddsSnapshot } from "../schema.ts";
import { pickPriorityMarket, withoutSportsbookOnEventDay } from "./marketPriority.ts";

function snapshot(
  market: OddsSnapshot["market"],
  volume?: number,
): OddsSnapshot {
  return {
    boutId: "bout-1",
    market,
    quotes: [],
    ...(volume === undefined ? {} : { volume }),
    provenance: {
      source: market === "sportsbook" ? "odds-api" : market,
      fetchedAt: "2026-08-14T12:00:00.000Z",
      synthetic: false,
    },
  };
}

describe("pickPriorityMarket", () => {
  it("prefers Kalshi over sportsbook once volume clears the threshold", () => {
    const kalshi = snapshot("kalshi", 1000);
    const sportsbook = snapshot("sportsbook");
    expect(pickPriorityMarket({ kalshi, sportsbook })).toBe(kalshi);
  });

  it("falls back to sportsbook when Kalshi volume is under the threshold", () => {
    const kalshi = snapshot("kalshi", 999);
    const sportsbook = snapshot("sportsbook");
    expect(pickPriorityMarket({ kalshi, sportsbook })).toBe(sportsbook);
  });

  it("falls back to sportsbook when Kalshi volume is missing", () => {
    const kalshi = snapshot("kalshi");
    const sportsbook = snapshot("sportsbook");
    expect(pickPriorityMarket({ kalshi, sportsbook })).toBe(sportsbook);
  });

  it("prefers Polymarket over sportsbook once volume clears the threshold, after Kalshi", () => {
    const polymarket = snapshot("polymarket", 5000);
    const sportsbook = snapshot("sportsbook");
    expect(pickPriorityMarket({ polymarket, sportsbook })).toBe(polymarket);
  });

  it("prefers Kalshi over Polymarket when both clear the threshold", () => {
    const kalshi = snapshot("kalshi", 5000);
    const polymarket = snapshot("polymarket", 5000);
    expect(pickPriorityMarket({ kalshi, polymarket })).toBe(kalshi);
  });

  it("falls back to Kalshi under threshold when sportsbook is unavailable", () => {
    const kalshi = snapshot("kalshi", 10);
    expect(pickPriorityMarket({ kalshi })).toBe(kalshi);
  });

  it("falls back to Polymarket under threshold when neither Kalshi nor sportsbook exist", () => {
    const polymarket = snapshot("polymarket", 10);
    expect(pickPriorityMarket({ polymarket })).toBe(polymarket);
  });

  it("returns null when nothing is available", () => {
    expect(pickPriorityMarket({})).toBeNull();
  });
});

describe("withoutSportsbookOnEventDay", () => {
  it("drops sportsbook when now falls on the event's calendar day", () => {
    const kalshi = snapshot("kalshi");
    const sportsbook = snapshot("sportsbook");
    const result = withoutSportsbookOnEventDay(
      { kalshi, sportsbook },
      "2026-07-29T22:00:00Z",
      Date.parse("2026-07-29T08:00:00Z"),
    );
    expect(result).toEqual({ kalshi });
  });

  it("keeps sportsbook on any other day", () => {
    const kalshi = snapshot("kalshi");
    const sportsbook = snapshot("sportsbook");
    const result = withoutSportsbookOnEventDay(
      { kalshi, sportsbook },
      "2026-07-29T22:00:00Z",
      Date.parse("2026-07-28T08:00:00Z"),
    );
    expect(result).toEqual({ kalshi, sportsbook });
  });
});
