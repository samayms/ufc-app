import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  assembleDashboard,
  dashboardDemoState,
} from "../store/useDashboard.ts";
import { FightSummary } from "./FightSummary.tsx";
import {
  completedRounds,
  defaultRoundSelection,
  RoundSelector,
} from "./RoundSelector.tsx";
import { RoundStatsPanel } from "./RoundStatsPanel.tsx";
import { ScorecardFeed } from "./ScorecardFeed.tsx";
import { SourceStatus } from "./SourceStatus.tsx";
import { EventSubheader, TopBar } from "./TopBar.tsx";

describe("dashboard state surfaces", () => {
  it("parses only supported visual demo states", () => {
    expect(dashboardDemoState("?demo=stale")).toBe("stale");
    expect(dashboardDemoState("?demo=error")).toBe("error");
    expect(dashboardDemoState("?demo=unknown")).toBe("default");
  });

  it("switches the selected round without enabling future rounds", async () => {
    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;

    expect(completedRounds(view)).toEqual([1, 2]);
    expect(defaultRoundSelection(view)).toBe(2);

    const roundOne = renderToStaticMarkup(
      <RoundSelector view={view} value={1} onChange={() => undefined} />,
    );
    const totals = renderToStaticMarkup(
      <RoundSelector view={view} value="total" onChange={() => undefined} />,
    );
    expect(roundOne).toContain('aria-selected="true"');
    expect(roundOne).toContain(">R1</button>");
    expect(roundOne).toContain(">R3</button>");
    expect(roundOne).toContain("disabled");
    expect(totals).toContain("round-tab-total is-active");

    const firstRoundStats = renderToStaticMarkup(
      <RoundStatsPanel view={view} selection={1} />,
    );
    expect(firstRoundStats).toContain("Round 1 stats");
    expect(firstRoundStats).toContain(">24/31<");
  });

  it("renders honest missing-round and stale-source states", async () => {
    const state = await assembleDashboard();
    const upcoming = state.boutViews["bout-3"];
    expect(upcoming).toBeDefined();
    if (!upcoming) return;

    const missing = renderToStaticMarkup(
      <FightSummary view={upcoming} selection={1} />,
    );
    expect(missing).toContain("Stats lock in after each completed round.");
    expect(missing).toContain(
      "A grounded summary will appear after the round is complete.",
    );

    const stale = renderToStaticMarkup(
      <SourceStatus state={state} stale />,
    );
    expect(stale).toContain("Stale");
    expect(stale).toContain("Fixture data");
    expect(stale).toContain("Last synced");
    expect(stale).toContain("On dashboard refresh");
    expect(stale).toContain("completed-round data stays");
  });

  it("keeps diagnostics in Data and the UFC masthead clear", async () => {
    const state = await assembleDashboard();
    const topBar = renderToStaticMarkup(<TopBar />);
    const eventSubheader = renderToStaticMarkup(
      <EventSubheader event={state.event} />,
    );
    const sources = renderToStaticMarkup(<SourceStatus state={state} />);

    expect(topBar).toContain("topbar-wordmark");
    expect(topBar).not.toContain("<h1");
    expect(topBar).not.toContain("Fight Night");
    expect(topBar).not.toContain("Fixture data");
    expect(topBar).not.toContain("synced");
    expect(eventSubheader).toContain("Fight Night: Reyes vs. Volkov");
    expect(eventSubheader).toContain(
      'aria-label="UFC Fight Night: Reyes vs. Volkov"',
    );
    expect(sources).toContain("Data feeds");
    expect(sources).toContain("Fixture data");
  });

  it("reserves exactly four compact media scorecard slots", async () => {
    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;

    const scorecards = renderToStaticMarkup(
      <ScorecardFeed view={view} accounts={state.scorecardAccounts} />,
    );
    expect(scorecards.match(/class="media-scorecard"/g)).toHaveLength(4);
    expect(scorecards).toContain("10–9");
    expect(scorecards).not.toContain("Cleaner counters");
  });
});
