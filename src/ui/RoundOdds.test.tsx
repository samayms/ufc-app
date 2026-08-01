import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CollectorUnifiedRound } from "../store/collectorClient.ts";
import { RoundOdds } from "./RoundOdds.tsx";

describe("RoundOdds", () => {
  it("renders the selected round's preferred market with source accents", () => {
    const record: CollectorUnifiedRound = {
      boutId: "bout-main",
      round: 2,
      detectedEndedAt: "2026-07-28T01:02:03Z",
      endingSignal: "period_transition",
      provisional: false,
      marketAtEnd: {
        polymarket: {
          source: "polymarket",
          boutId: "bout-main",
          round: 2,
          boundaryType: "confirmed",
          takenAt: "2026-07-28T01:02:04Z",
          fresh: true,
          outcomes: [
            {
              outcome: "Danilo Reyes",
              marketType: "moneyline",
              midpoint: 0.58,
              impliedProbability: 0.58,
              receivedAt: "2026-07-28T01:02:04Z",
              stale: false,
            },
            {
              outcome: "Artem Volkov",
              marketType: "moneyline",
              midpoint: 0.42,
              impliedProbability: 0.42,
              receivedAt: "2026-07-28T01:02:04Z",
              stale: false,
            },
          ],
        },
      },
    };

    const html = renderToStaticMarkup(
      <RoundOdds
        boutId="bout-main"
        redName="Danilo Reyes"
        blueName="Artem Volkov"
        selection={2}
        records={[record]}
      />,
    );

    expect(html).toContain('aria-label="Odds after Round 2"');
    expect(html).toContain('data-market-accent="polymarket"');
    expect(html).not.toContain("Polymarket");
    expect(html).toContain(">Odds<");
    expect(html).toContain("58%");
    expect(html).toContain("42%");
    expect(html).not.toContain("$0.58");
  });

  it("prioritizes Kalshi when multiple round-end markets are available", () => {
    const record: CollectorUnifiedRound = {
      boutId: "bout-main",
      round: 2,
      detectedEndedAt: "2026-07-28T01:02:03Z",
      endingSignal: "period_transition",
      provisional: false,
      marketAtEnd: {
        kalshi: {
          source: "kalshi",
          boutId: "bout-main",
          round: 2,
          boundaryType: "confirmed",
          takenAt: "2026-07-28T01:02:04Z",
          fresh: true,
          outcomes: [
            {
              outcome: "Danilo Reyes",
              marketType: "moneyline",
              midpoint: 54,
              impliedProbability: 0.54,
              receivedAt: "2026-07-28T01:02:04Z",
              stale: false,
            },
            {
              outcome: "Artem Volkov",
              marketType: "moneyline",
              midpoint: 46,
              impliedProbability: 0.46,
              receivedAt: "2026-07-28T01:02:04Z",
              stale: false,
            },
          ],
        },
      },
    };
    const html = renderToStaticMarkup(
      <RoundOdds
        boutId="bout-main"
        redName="Danilo Reyes"
        blueName="Artem Volkov"
        selection={2}
        records={[record]}
      />,
    );
    expect(html).toContain('data-market-accent="kalshi"');
    expect(html).toContain("54%");
    expect(html).toContain("46%");
  });

  it("falls back to sportsbook when Kalshi volume is under $1000", () => {
    const record: CollectorUnifiedRound = {
      boutId: "bout-main",
      round: 2,
      detectedEndedAt: "2026-07-28T01:02:03Z",
      endingSignal: "period_transition",
      provisional: false,
      marketAtEnd: {
        kalshi: {
          source: "kalshi",
          boutId: "bout-main",
          round: 2,
          boundaryType: "confirmed",
          takenAt: "2026-07-28T01:02:04Z",
          fresh: true,
          outcomes: [
            {
              outcome: "Danilo Reyes",
              marketType: "moneyline",
              midpoint: 54,
              impliedProbability: 0.54,
              volume: 100,
              receivedAt: "2026-07-28T01:02:04Z",
              stale: false,
            },
            {
              outcome: "Artem Volkov",
              marketType: "moneyline",
              midpoint: 46,
              impliedProbability: 0.46,
              volume: 100,
              receivedAt: "2026-07-28T01:02:04Z",
              stale: false,
            },
          ],
        },
        oddsApiIo: {
          source: "odds-api-io",
          boutId: "bout-main",
          round: 2,
          boundaryType: "confirmed",
          takenAt: "2026-07-28T01:02:04Z",
          fresh: true,
          outcomes: [
            {
              outcome: "Danilo Reyes",
              marketType: "moneyline",
              midpoint: 0.6,
              noVigProbability: 0.6,
              receivedAt: "2026-07-28T01:02:04Z",
              stale: false,
            },
            {
              outcome: "Artem Volkov",
              marketType: "moneyline",
              midpoint: 0.4,
              noVigProbability: 0.4,
              receivedAt: "2026-07-28T01:02:04Z",
              stale: false,
            },
          ],
        },
      },
    };
    const html = renderToStaticMarkup(
      <RoundOdds
        boutId="bout-main"
        redName="Danilo Reyes"
        blueName="Artem Volkov"
        selection={2}
        records={[record]}
      />,
    );
    expect(html).toContain('data-market-accent="sportsbook"');
    expect(html).toContain("60%");
    expect(html).toContain("40%");
  });

  it("falls back to Kalshi under threshold when no sportsbook market exists", () => {
    const record: CollectorUnifiedRound = {
      boutId: "bout-main",
      round: 2,
      detectedEndedAt: "2026-07-28T01:02:03Z",
      endingSignal: "period_transition",
      provisional: false,
      marketAtEnd: {
        kalshi: {
          source: "kalshi",
          boutId: "bout-main",
          round: 2,
          boundaryType: "confirmed",
          takenAt: "2026-07-28T01:02:04Z",
          fresh: true,
          outcomes: [
            {
              outcome: "Danilo Reyes",
              marketType: "moneyline",
              midpoint: 54,
              impliedProbability: 0.54,
              volume: 10,
              receivedAt: "2026-07-28T01:02:04Z",
              stale: false,
            },
            {
              outcome: "Artem Volkov",
              marketType: "moneyline",
              midpoint: 46,
              impliedProbability: 0.46,
              volume: 10,
              receivedAt: "2026-07-28T01:02:04Z",
              stale: false,
            },
          ],
        },
      },
    };
    const html = renderToStaticMarkup(
      <RoundOdds
        boutId="bout-main"
        redName="Danilo Reyes"
        blueName="Artem Volkov"
        selection={2}
        records={[record]}
      />,
    );
    expect(html).toContain('data-market-accent="kalshi"');
    expect(html).toContain("54%");
    expect(html).toContain("46%");
  });
});
