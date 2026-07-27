import { describe, expect, it } from "vitest";
import type { OddsSnapshot } from "../schema/types.ts";
import {
  americanToImpliedProb,
  consensus,
  devigPair,
  marketProbabilities,
} from "./oddsMath.ts";

const provenance = {
  source: "fixture" as const,
  fetchedAt: "2026-07-27T00:00:00Z",
  synthetic: true,
};

describe("americanToImpliedProb", () => {
  it("converts a negative (favorite) moneyline", () => {
    // -185 -> 185 / (185 + 100) = 0.6491228070...
    expect(americanToImpliedProb(-185)).toBeCloseTo(0.6491228070, 9);
  });

  it("converts a positive (underdog) moneyline", () => {
    // +150 -> 100 / (150 + 100) = 0.4
    expect(americanToImpliedProb(150)).toBeCloseTo(0.4, 9);
  });
});

describe("devigPair", () => {
  it("de-vigs -185/+150 implied probabilities so they sum to 1", () => {
    const red = americanToImpliedProb(-185);
    const blue = americanToImpliedProb(150);
    const result = devigPair(red, blue);

    expect(result.red).toBeCloseTo(0.6187290970, 9);
    expect(result.blue).toBeCloseTo(0.3812709030, 9);
    expect(result.red + result.blue).toBeCloseTo(1, 12);
  });

  it("falls back to 0.5/0.5 on a degenerate (non-positive) sum", () => {
    expect(devigPair(0, 0)).toEqual({ red: 0.5, blue: 0.5 });
    expect(devigPair(-0.2, -0.1)).toEqual({ red: 0.5, blue: 0.5 });
  });
});

describe("marketProbabilities", () => {
  it("averages books then de-vigs for a sportsbook snapshot", () => {
    const snapshot: OddsSnapshot = {
      boutId: "bout-main",
      market: "sportsbook",
      quotes: [
        {
          corner: "red",
          native: { kind: "american-moneyline", moneyline: -200, book: "draftkings" },
          impliedProbability: americanToImpliedProb(-200),
        },
        {
          corner: "blue",
          native: { kind: "american-moneyline", moneyline: 170, book: "draftkings" },
          impliedProbability: americanToImpliedProb(170),
        },
        {
          corner: "red",
          native: { kind: "american-moneyline", moneyline: -180, book: "fanduel" },
          impliedProbability: americanToImpliedProb(-180),
        },
        {
          corner: "blue",
          native: { kind: "american-moneyline", moneyline: 160, book: "fanduel" },
          impliedProbability: americanToImpliedProb(160),
        },
      ],
      provenance,
    };

    const result = marketProbabilities(snapshot);

    expect(result).not.toBeNull();
    // redAvg = (0.6666666667 + 0.6428571429) / 2 = 0.6547619048
    // blueAvg = (0.3703703704 + 0.3846153846) / 2 = 0.3774928775
    // sum = 1.0322547823
    expect(result?.red).toBeCloseTo(0.6343026121, 9);
    expect(result?.blue).toBeCloseTo(0.3656973879, 9);
    expect((result?.red ?? 0) + (result?.blue ?? 0)).toBeCloseTo(1, 9);
  });

  it("passes through and de-vigs a kalshi snapshot with spread", () => {
    const snapshot: OddsSnapshot = {
      boutId: "bout-main",
      market: "kalshi",
      quotes: [
        {
          corner: "red",
          native: { kind: "kalshi-cents", yesCents: 62, noCents: 38 },
          impliedProbability: 0.62,
        },
        {
          corner: "blue",
          native: { kind: "kalshi-cents", yesCents: 35, noCents: 65 },
          impliedProbability: 0.35,
        },
      ],
      provenance,
    };

    const result = marketProbabilities(snapshot);

    // sum = 0.97; red = 0.62 / 0.97, blue = 0.35 / 0.97
    expect(result?.red).toBeCloseTo(0.6391752577, 9);
    expect(result?.blue).toBeCloseTo(0.3608247423, 9);
  });

  it("passes through and de-vigs a polymarket snapshot with spread", () => {
    const snapshot: OddsSnapshot = {
      boutId: "bout-main",
      market: "polymarket",
      quotes: [
        {
          corner: "red",
          native: { kind: "polymarket-price", price: 0.6 },
          impliedProbability: 0.6,
        },
        {
          corner: "blue",
          native: { kind: "polymarket-price", price: 0.42 },
          impliedProbability: 0.42,
        },
      ],
      provenance,
    };

    const result = marketProbabilities(snapshot);

    // sum = 1.02; red = 0.6 / 1.02, blue = 0.42 / 1.02
    expect(result?.red).toBeCloseTo(0.5882352941, 9);
    expect(result?.blue).toBeCloseTo(0.4117647059, 9);
  });

  it("returns null when a corner has no quotes", () => {
    const snapshot: OddsSnapshot = {
      boutId: "bout-main",
      market: "kalshi",
      quotes: [
        {
          corner: "red",
          native: { kind: "kalshi-cents", yesCents: 62, noCents: 38 },
          impliedProbability: 0.62,
        },
      ],
      provenance,
    };

    expect(marketProbabilities(snapshot)).toBeNull();
  });
});

describe("consensus", () => {
  const kalshiSnapshot: OddsSnapshot = {
    boutId: "bout-main",
    market: "kalshi",
    quotes: [
      {
        corner: "red",
        native: { kind: "kalshi-cents", yesCents: 62, noCents: 38 },
        impliedProbability: 0.62,
      },
      {
        corner: "blue",
        native: { kind: "kalshi-cents", yesCents: 35, noCents: 65 },
        impliedProbability: 0.35,
      },
    ],
    provenance,
  };

  const polymarketSnapshot: OddsSnapshot = {
    boutId: "bout-main",
    market: "polymarket",
    quotes: [
      {
        corner: "red",
        native: { kind: "polymarket-price", price: 0.6 },
        impliedProbability: 0.6,
      },
      {
        corner: "blue",
        native: { kind: "polymarket-price", price: 0.42 },
        impliedProbability: 0.42,
      },
    ],
    provenance,
  };

  it("averages vig-free probabilities across markets and reports spread", () => {
    const result = consensus([kalshiSnapshot, polymarketSnapshot]);

    expect(result).not.toBeNull();
    // kalshi de-vigged: red 0.6391752577, blue 0.3608247423
    // polymarket de-vigged: red 0.5882352941, blue 0.4117647059
    expect(result?.red).toBeCloseTo(0.6137052759, 9);
    expect(result?.blue).toBeCloseTo(0.3862947241, 9);
    expect(result?.markets).toBe(2);

    expect(result?.spread.red[0]).toBeCloseTo(0.5882352941, 9);
    expect(result?.spread.red[1]).toBeCloseTo(0.6391752577, 9);
    expect(result?.spread.blue[0]).toBeCloseTo(0.3608247423, 9);
    expect(result?.spread.blue[1]).toBeCloseTo(0.4117647059, 9);
  });

  it("returns null when no snapshot yields probabilities", () => {
    const incomplete: OddsSnapshot = {
      boutId: "bout-main",
      market: "kalshi",
      quotes: [
        {
          corner: "red",
          native: { kind: "kalshi-cents", yesCents: 62, noCents: 38 },
          impliedProbability: 0.62,
        },
      ],
      provenance,
    };

    expect(consensus([incomplete])).toBeNull();
    expect(consensus([])).toBeNull();
  });
});
