import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoutView, OddsSnapshot } from "../schema.ts";
import { assembleDashboard } from "../store/useDashboard.ts";
import { OddsPanel } from "./OddsPanel.tsx";

/** A hand-built opening (pre-fight) Kalshi snapshot, distinct from the fixture's current price. */
function openKalshiSnapshot(boutId: string): OddsSnapshot {
  return {
    boutId,
    market: "kalshi",
    quotes: [
      {
        corner: "red",
        native: { kind: "kalshi-cents", yesCents: 40, noCents: 60 },
        impliedProbability: 0.4,
      },
      {
        corner: "blue",
        native: { kind: "kalshi-cents", yesCents: 60, noCents: 40 },
        impliedProbability: 0.6,
      },
    ],
    provenance: { source: "kalshi", fetchedAt: "2026-07-20T18:00:00Z", synthetic: true },
  };
}

/** A hand-built "current" Kalshi snapshot, moved up for red / down for blue vs. the opening line above. */
function currentKalshiSnapshot(boutId: string): OddsSnapshot {
  return {
    boutId,
    market: "kalshi",
    quotes: [
      {
        corner: "red",
        native: { kind: "kalshi-cents", yesCents: 70, noCents: 30 },
        impliedProbability: 0.7,
      },
      {
        corner: "blue",
        native: { kind: "kalshi-cents", yesCents: 30, noCents: 70 },
        impliedProbability: 0.3,
      },
    ],
    provenance: { source: "kalshi", fetchedAt: "2026-07-28T01:00:00Z", synthetic: true },
  };
}

describe("OddsPanel pre-fight (opening line) rendering", () => {
  it("renders the opening price and the move from open to now when a pre-fight snapshot exists", async () => {
    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;

    const withOpen: BoutView = {
      ...view,
      latestOdds: { ...view.latestOdds, kalshi: currentKalshiSnapshot(view.bout.id) },
      marketMoves: { ...view.marketMoves, kalshi: {} },
      preFightOdds: { ...view.preFightOdds, kalshi: openKalshiSnapshot(view.bout.id) },
    };

    const panel = renderToStaticMarkup(<OddsPanel view={withOpen} />);
    expect(panel).toContain("Opening line");
    expect(panel).toContain("opened");
    // Opening prices, distinct from the 70%/30% current prices rendered above.
    expect(panel).toContain("40%");
    expect(panel).toContain("60%");
    expect(panel).toContain("70%");
    expect(panel).toContain("30%");
    // Red opened at 40%, now 70% -> up; blue opened at 60%, now 30% -> down.
    expect(panel).toContain("market-move-up");
    expect(panel).toContain("market-move-down");
  });

  it("renders an honest empty state, with no fabricated delta, when no pre-fight snapshot was captured", async () => {
    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;

    // The fixture-mode store never captures pre-fight snapshots (server-side-only capability),
    // so preFightOdds stays the empty stub straight out of assembleDashboard().
    expect(view.preFightOdds).toEqual({});

    const panel = renderToStaticMarkup(<OddsPanel view={view} />);
    expect(panel).toContain("No opening line captured for this market.");
    // Never substitute the current price as if it were the opening one, and
    // never fabricate a delta from a price we don't have.
    expect(panel).not.toContain("Opening line");
  });

  it("never fabricates a delta when an opening line exists but there is no current price to compare it to", async () => {
    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;

    // Drop the "kalshi" key entirely (not set-to-undefined) to match how the
    // store actually represents "no current snapshot" for a market.
    const { kalshi: _droppedKalshi, ...latestOddsWithoutKalshi } = view.latestOdds;
    const withOpenOnly: BoutView = {
      ...view,
      latestOdds: latestOddsWithoutKalshi,
      preFightOdds: { ...view.preFightOdds, kalshi: openKalshiSnapshot(view.bout.id) },
    };

    const panel = renderToStaticMarkup(<OddsPanel view={withOpenOnly} />);
    // Scope to the Kalshi section — Polymarket/Sportsbooks legitimately have
    // their own unrelated market-move-up/down from fixture tick history.
    const kalshiSection = panel.slice(
      panel.indexOf('aria-label="Kalshi odds"'),
      panel.indexOf('aria-label="Polymarket odds"'),
    );
    expect(kalshiSection).toContain("Opening line");
    expect(kalshiSection).toContain("40%");
    expect(kalshiSection).toContain("current price unavailable");
    expect(kalshiSection).not.toContain("market-move-up");
    expect(kalshiSection).not.toContain("market-move-down");
  });
});
