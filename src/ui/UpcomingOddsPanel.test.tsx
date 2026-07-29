import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  UpcomingBoutOdds,
  UpcomingDecisionOdds,
  UpcomingProviderEntry,
} from "../lib/upcomingOdds.ts";
import { UpcomingOddsPanel } from "./UpcomingOddsPanel.tsx";

const NOW_MS = Date.parse("2026-08-14T12:00:00.000Z");

function entry(
  market: "kalshi" | "polymarket" | "sportsbook",
  quotes: NonNullable<UpcomingProviderEntry["snapshot"]>["quotes"],
  overrides: Partial<UpcomingProviderEntry> = {},
): UpcomingProviderEntry {
  return {
    status: "loaded",
    fetchedAt: "2026-08-14T11:00:00.000Z",
    updatedAt: "2026-08-14T11:00:00.000Z",
    externalId: "provider-market-1",
    confidence: 1,
    cornersReversed: false,
    snapshot: {
      boutId: "401869336",
      market,
      quotes,
      provenance: {
        source: market === "sportsbook" ? "odds-api" : market,
        fetchedAt: "2026-08-14T11:00:00.000Z",
        synthetic: false,
      },
    },
    ...overrides,
  };
}

function loadedKalshi(
  overrides: Partial<UpcomingProviderEntry> = {},
): UpcomingProviderEntry {
  return entry("kalshi", [
    {
      corner: "red",
      native: { kind: "kalshi-cents", yesCents: 69, noCents: 31 },
      impliedProbability: 0.69,
    },
    {
      corner: "blue",
      native: { kind: "kalshi-cents", yesCents: 31, noCents: 69 },
      impliedProbability: 0.31,
    },
  ], overrides);
}

function loadedPolymarket(
  overrides: Partial<UpcomingProviderEntry> = {},
): UpcomingProviderEntry {
  return entry("polymarket", [
    {
      corner: "red",
      native: { kind: "polymarket-price", price: 0.42 },
      impliedProbability: 0.42,
    },
    {
      corner: "blue",
      native: { kind: "polymarket-price", price: 0.58 },
      impliedProbability: 0.58,
    },
  ], overrides);
}

function sportsbookEntry(
  redMoneyline: number,
  redProbability: number,
  blueMoneyline: number,
  blueProbability: number,
): UpcomingProviderEntry {
  return entry("sportsbook", [
    {
      corner: "red",
      native: { kind: "american-moneyline", moneyline: redMoneyline, book: "book" },
      impliedProbability: redProbability,
    },
    {
      corner: "blue",
      native: { kind: "american-moneyline", moneyline: blueMoneyline, book: "book" },
      impliedProbability: blueProbability,
    },
  ]);
}

function bout(
  providers: UpcomingBoutOdds["providers"],
  decision: UpcomingDecisionOdds = {
    state: "not_listed",
    fetchedAt: "2026-08-14T11:00:00.000Z",
    synthetic: false,
  },
): UpcomingBoutOdds {
  return {
    boutId: "401869336",
    espnEventId: "600059185",
    redFighter: "Islam Makhachev",
    blueFighter: "Ian Machado Garry",
    providers,
    decision,
  };
}

function loadedDecision(
  source: "kalshi" | "polymarket" | "odds-api-io",
  decisionProbability: number,
  synthetic = false,
): UpcomingDecisionOdds {
  return {
    state: "loaded",
    decisionProbability,
    finishProbability: 1 - decisionProbability,
    source,
    fetchedAt: "2026-08-14T11:00:00.000Z",
    synthetic,
  };
}

function render(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(node);
}

describe("UpcomingOddsPanel", () => {
  it("renders the three visible markets without removed chrome", () => {
    const html = render(
      <UpcomingOddsPanel
        bout={bout({ kalshi: loadedKalshi() })}
        redName="Makhachev"
        blueName="Garry"
        syncedAt="2026-08-14T12:30:00.000Z"
        notice="No sync has run yet."
        nowMs={NOW_MS}
      />,
    );

    expect(html).toContain('alt="Kalshi"');
    expect(html).toContain('alt="Polymarket"');
    expect(html).toContain('alt="BetMGM"');
    expect(html).toContain('class="market-head-text">Decision</h3>');
    expect(html).not.toContain("Odds-API.io");
    expect(html).not.toContain("The Odds API");
    expect(html).not.toContain("Markets");
    expect(html).not.toContain("12:30 PM");
    expect(html).not.toContain("LIVE");
    expect(html).not.toContain("Upcoming odds unavailable");
  });

  it("renders real prices without names, native prices, or timestamps", () => {
    const html = render(
      <UpcomingOddsPanel
        bout={bout({ kalshi: loadedKalshi() })}
        redName="Makhachev"
        blueName="Garry"
        nowMs={NOW_MS}
      />,
    );

    expect(html).toContain('class="market-pct num">69%</span>');
    expect(html).toContain('class="market-pct num">31%</span>');
    expect(html).not.toContain("market-name");
    expect(html).not.toContain("market-native");
    expect(html).not.toContain("updated");
    expect(html).not.toContain("never updated");
    expect(html).not.toContain("last known price retained");
  });

  it("keeps the same structure and em-dashes when no provider has data", () => {
    const html = render(
      <UpcomingOddsPanel
        bout={undefined}
        redName="Makhachev"
        blueName="Garry"
        notice="No sync has run yet."
        nowMs={NOW_MS}
      />,
    );

    expect(html.match(/class="market"/g)).toHaveLength(4);
    expect(html.match(/class="market-bar"/g)).toHaveLength(4);
    expect(html.match(/class="market-pct num">—/g)).toHaveLength(6);
    expect(html.match(/class="market-moneyline num">—/g)).toHaveLength(2);
    expect(html.match(/class="market-moneyline-pct num">—/g)).toHaveLength(2);
    expect(html).not.toMatch(/market-pct num">\d/);
    expect(html).not.toContain("No sync has run yet.");
    expect(html).not.toContain("state-notice");
  });

  it("picks the lowest implied-probability moneyline across both sportsbooks", () => {
    const html = render(
      <UpcomingOddsPanel
        bout={bout({
          "odds-api-io": sportsbookEntry(-200, 0.667, 170, 0.37),
          "odds-api": sportsbookEntry(-385, 0.206, 300, 0.25),
        })}
        redName="Makhachev"
        blueName="Garry"
        nowMs={NOW_MS}
      />,
    );

    const sportsbook = html.slice(html.indexOf('alt="BetMGM"'));
    expect(sportsbook).toContain('class="market-moneyline num">-385</span>');
    expect(sportsbook).toContain('class="market-moneyline-pct num">21%</span>');
    expect(sportsbook).toContain('class="market-moneyline num">+300</span>');
    expect(sportsbook).toContain('class="market-moneyline-pct num">25%</span>');
  });

  it("never renders synthetic snapshots as real prices", () => {
    const synthetic = loadedKalshi({
      snapshot: {
        ...loadedKalshi().snapshot!,
        provenance: {
          ...loadedKalshi().snapshot!.provenance,
          synthetic: true,
        },
      },
    });
    const html = render(
      <UpcomingOddsPanel
        bout={bout({ kalshi: synthetic })}
        redName="Makhachev"
        blueName="Garry"
        nowMs={NOW_MS}
      />,
    );

    expect(html).not.toContain("69%");
    expect(html).toContain('class="market-pct num">—</span>');
  });

  it("uses Kalshi first for the Decision block", () => {
    const html = render(
      <UpcomingOddsPanel
        bout={bout(
          { kalshi: loadedKalshi(), polymarket: loadedPolymarket() },
          loadedDecision("kalshi", 0.69),
        )}
        redName="Makhachev"
        blueName="Garry"
        nowMs={NOW_MS}
      />,
    );
    const decision = html.slice(html.lastIndexOf('<section class="market"'));
    expect(decision).toContain('data-market-accent="kalshi"');
    expect(decision).toContain('class="decision-label">DECISION</span>');
    expect(decision).toContain('class="decision-label">FINISH</span>');
    expect(decision).toContain('class="market-pct num">69%</span>');
    expect(decision).toContain('class="market-pct num">31%</span>');
    expect(decision).toContain('class="split-decision"');
    expect(decision).toContain('class="split-finish"');
  });

  it("falls through to Polymarket when Kalshi is absent", () => {
    const html = render(
      <UpcomingOddsPanel
        bout={bout({}, loadedDecision("polymarket", 0.42))}
        redName="Makhachev"
        blueName="Garry"
        nowMs={NOW_MS}
      />,
    );
    const decision = html.slice(html.lastIndexOf('<section class="market"'));
    expect(decision).toContain('data-market-accent="polymarket"');
    expect(decision).toContain('class="market-pct num">42%</span>');
    expect(decision).toContain('class="market-pct num">58%</span>');
  });

  it("falls through to de-vigged combined sportsbooks", () => {
    const html = render(
      <UpcomingOddsPanel
        bout={bout(
          {
            "odds-api-io": sportsbookEntry(-110, 100 / 210, -110, 100 / 210),
            "odds-api": sportsbookEntry(-110, 100 / 210, -110, 100 / 210),
          },
          loadedDecision("odds-api-io", 0.5),
        )}
        redName="Makhachev"
        blueName="Garry"
        nowMs={NOW_MS}
      />,
    );
    const decision = html.slice(html.lastIndexOf('<section class="market"'));
    expect(decision).toContain('data-market-accent="odds-api-io"');
    expect(decision).toContain('class="market-pct num">50%</span>');
    expect(decision.match(/class="market-pct num">50%<\/span>/g)).toHaveLength(2);
  });

  it("does not use synthetic odds for the Decision source", () => {
    const synthetic = loadedKalshi({
      snapshot: {
        ...loadedKalshi().snapshot!,
        provenance: { ...loadedKalshi().snapshot!.provenance, synthetic: true },
      },
    });
    const html = render(
      <UpcomingOddsPanel
        bout={bout(
          { kalshi: synthetic, polymarket: loadedPolymarket() },
          loadedDecision("kalshi", 0.69, true),
        )}
        redName="Makhachev"
        blueName="Garry"
        nowMs={NOW_MS}
      />,
    );
    const decision = html.slice(html.lastIndexOf('<section class="market"'));
    expect(decision).toContain('data-market-accent="kalshi"');
    expect(decision).not.toContain('class="market-pct num">69%</span>');
    expect(decision).toContain('class="market-pct num">—</span>');
  });
});
