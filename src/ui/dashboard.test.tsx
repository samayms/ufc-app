import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoutView } from "../schema.ts";
import {
  assembleDashboard,
  collectorDisabled,
  dashboardDemoState,
} from "../store/useDashboard.ts";
import { FightSummary } from "./FightSummary.tsx";
import { OddsPanel } from "./OddsPanel.tsx";
import {
  completedRounds,
  defaultRoundSelection,
  RoundSelector,
} from "./RoundSelector.tsx";
import { RoundStatsPanel } from "./RoundStatsPanel.tsx";
import { ScorecardFeed } from "./ScorecardFeed.tsx";
import { SourceStatus } from "./SourceStatus.tsx";
import { SectionTabs } from "./SectionTabs.tsx";
import { EventSubheader, TopBar } from "./TopBar.tsx";

function toOddsPanelProps(view: BoutView) {
  const redName = view.bout.fighters.red.name.split(" ").at(-1) ?? view.bout.fighters.red.name;
  const blueName = view.bout.fighters.blue.name.split(" ").at(-1) ?? view.bout.fighters.blue.name;
  return {
    redName,
    blueName,
    latestOdds: view.latestOdds,
    preFightOdds: view.preFightOdds,
    emptyText:
      view.bout.status === "final"
        ? "Bout is final."
        : view.bout.status === "canceled" || view.bout.status === "postponed"
          ? `Bout ${view.bout.status}.`
          : undefined,
  };
}

describe("dashboard state surfaces", () => {
  it("parses only supported visual demo states", () => {
    expect(dashboardDemoState("?demo=stale")).toBe("stale");
    expect(dashboardDemoState("?demo=error")).toBe("error");
    expect(dashboardDemoState("?demo=live")).toBe("live");
    expect(dashboardDemoState("?demo=unknown")).toBe("default");
  });

  it("lets a link ignore a running collector so the fixture bout shows", () => {
    // A collector serving a real card shadows the fixture entirely, which
    // hides the fixture's only live bout.
    expect(collectorDisabled("?collector=off")).toBe(true);
    expect(collectorDisabled("")).toBe(false);
    expect(collectorDisabled("?collector=on")).toBe(false);
  });

  it("keeps the fight navigation focused on the remaining views", () => {
    const tabs = renderToStaticMarkup(
      <SectionTabs active="summary" onChange={() => undefined} />,
    );
    expect(tabs).toContain(">Fight</button>");
    expect(tabs).toContain(">Odds</button>");
    expect(tabs).toContain(">Tale</button>");
    expect(tabs).not.toContain(">Stats</button>");
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
      <FightSummary view={upcoming} eventStartsAt={state.event.startsAt} selection={1} />,
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

  it("uses the fixture market snapshot to preview round odds", async () => {
    const state = await assembleDashboard();
    const main = state.boutViews["bout-main"];
    expect(main).toBeDefined();
    if (!main) return;

    const html = renderToStaticMarkup(
      <FightSummary view={main} eventStartsAt={state.event.startsAt} selection={2} />,
    );
    expect(html).toContain('data-market-accent="kalshi"');
    expect(html).toContain(">Odds<");
    expect(html).not.toContain("round-end odds will appear");
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

  it("shows an honest expert-score empty state without invented posts", async () => {
    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;

    const scorecards = renderToStaticMarkup(<ScorecardFeed view={view} />);
    expect(scorecards).toContain("No Sherdog scorecard for this round.");
    expect(scorecards).not.toContain('class="media-scorecard"');
    expect(scorecards).not.toContain("10–9");
  });

  it("renders collector-delivered Sherdog values with provenance", async () => {
    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;

    const scorecards = renderToStaticMarkup(
      <ScorecardFeed
        view={view}
        round={1}
        records={[
          {
            boutId: view.bout.id,
            round: 1,
            detectedEndedAt: "2026-07-28T00:00:00Z",
            endingSignal: "period_transition",
            sherdog: {
              boutId: view.bout.id,
              round: 1,
              commentary: "Measured exchanges.",
              scorerCards: [
                {
                  scorer: "Sherdog",
                  winner: "Reyes",
                  roundScore: "10-9",
                },
              ],
              sourceUrl: "https://www.sherdog.com/news/fixture",
              publishedAt: "2026-07-28T00:00:09Z",
              fetchedAt: "2026-07-28T00:00:10Z",
              parserVersion: "test",
              payloadHash: "hash",
            },
            marketAtEnd: {},
            expertConsensus: {
              sherdog: {
                source: "sherdog",
                redVotes: 1,
                blueVotes: 0,
                drawVotes: 0,
                total: 1,
                leader: "red",
              },
            },
            provisional: false,
          },
        ]}
      />,
    );

    expect(scorecards).toContain("Measured exchanges.");
    expect(scorecards).toContain("Sherdog");
  });

  it("renders fixture-only odds unchanged when no collector deliveries are supplied", async () => {
    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;

    const panel = renderToStaticMarkup(<OddsPanel {...toOddsPanelProps(view)} />);
    expect(panel).toContain("Kalshi");
    expect(panel).toContain("Polymarket");
    expect(panel).toContain("Sportsbooks");
    expect(panel).toContain("as of");
    expect(panel).not.toContain("delivery-freshness");
  });

  it("computes per-market movement deltas from tick history, even though OddsPanel no longer renders them", async () => {
    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;

    // The store still computes this (see oddsMath.test.ts for the math itself) —
    // the odds panel just doesn't display it anymore.
    expect(view.marketMoves.kalshi?.red?.direction).toBe("up");
    expect(view.marketMoves.kalshi?.blue?.direction).toBe("down");
  });

  it("renders the same market-bar layout with '—' for a market with no snapshot", async () => {
    const state = await assembleDashboard();
    const view = state.boutViews["bout-3"];
    expect(view).toBeDefined();
    if (!view) return;

    const { polymarket: _droppedPolymarket, ...latestOddsWithoutPolymarket } = view.latestOdds;
    const panel = renderToStaticMarkup(
      <OddsPanel
        {...toOddsPanelProps({ ...view, latestOdds: latestOddsWithoutPolymarket })}
      />,
    );
    const polySection = panel.slice(
      panel.indexOf('aria-label="Polymarket odds"'),
      panel.indexOf('aria-label="Sportsbooks odds"'),
    );
    // Same market-bar/market-side layout as a populated block, just "—" for the numbers.
    expect(polySection).toContain("market-bar");
    expect(polySection).toContain(">—<");
  });

  it("surfaces collector delivery freshness (source, receipt time, stale) on live odds", async () => {
    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;

    const panel = renderToStaticMarkup(
      <OddsPanel
        {...toOddsPanelProps(view)}
        deliveries={{
          kalshi: {
            source: "Kalshi",
            sourceUpdatedAt: "2026-07-28T01:10:00Z",
            receivedAt: "2026-07-28T01:10:01Z",
            stale: true,
            provisional: false,
          },
        }}
      />,
    );
    expect(panel).toContain("delivery-freshness");
    expect(panel).toContain("Stale");
  });
});
