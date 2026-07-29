import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { findUpcomingBout, type UpcomingOddsDocument } from "./lib/upcomingOdds.ts";
import { assembleDashboard } from "./store/useDashboard.ts";
import type { UpcomingOddsState } from "./store/useUpcomingOdds.ts";
import { LiveOddsSection } from "./App.tsx";

const document: UpcomingOddsDocument = {
  version: 1,
  generatedAt: "2026-08-14T12:00:00.000Z",
  synthetic: false,
  events: [
    {
      espnEventId: "600059185",
      name: "Fixture card",
      bouts: [
        {
          boutId: "bout-3",
          espnEventId: "600059185",
          redFighter: "Red Fighter",
          blueFighter: "Blue Fighter",
          providers: {},
          decision: {
            state: "not_listed",
            fetchedAt: "2026-08-14T12:00:00.000Z",
            synthetic: false,
          },
        },
      ],
    },
  ],
  providerRuns: {},
  unmatchedMarkets: [],
};

function upcomingState(
  oddsDocument: UpcomingOddsDocument | null,
): UpcomingOddsState {
  return {
    status: "ready",
    document: oddsDocument,
    stale: false,
    reload: () => undefined,
  };
}

describe("LiveOddsSection", () => {
  it("uses upcoming provider panels for an unstarted bout without live odds", async () => {
    const state = await assembleDashboard();
    const view = state.boutViews["bout-3"];
    expect(view).toBeDefined();
    if (!view) return;

    const html = renderToStaticMarkup(
      <LiveOddsSection
        view={{ ...view, bout: { ...view.bout, status: "upcoming" }, latestOdds: {} }}
        upcomingOdds={upcomingState(document)}
      />,
    );

    expect(html).toContain("Kalshi");
    expect(html).toContain("Polymarket");
    expect(html).toContain("Sportsbooks");
    expect(html).not.toContain(">Markets<");
  });

  it("keeps live OddsPanel precedence when the bout has live odds", async () => {
    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;

    const html = renderToStaticMarkup(
      <LiveOddsSection
        view={{ ...view, bout: { ...view.bout, status: "upcoming" } }}
        upcomingOdds={upcomingState(document)}
      />,
    );

    expect(html).toContain(">Markets<");
  });

  it("falls back to OddsPanel when the bout is missing from upcoming odds", async () => {
    const state = await assembleDashboard();
    const view = state.boutViews["bout-3"];
    expect(view).toBeDefined();
    if (!view) return;

    expect(findUpcomingBout(document, view.bout.id)).toBeDefined();
    const html = renderToStaticMarkup(
      <LiveOddsSection
        view={{ ...view, bout: { ...view.bout, status: "upcoming" }, latestOdds: {} }}
        upcomingOdds={upcomingState({ ...document, events: [] })}
      />,
    );

    expect(html).toContain(">Markets<");
  });
});
