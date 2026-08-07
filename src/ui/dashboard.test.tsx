import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoutView } from "../schema.ts";
import {
  assembleDashboard,
  collectorDisabled,
  collectorSnapshotIsStale,
  dashboardDemoState,
} from "../store/useDashboard.ts";
import { BoutHeader } from "./BoutHeader.tsx";
import { EventList, type EventListEntry } from "./EventList.tsx";
import { fmtRecord } from "./format.ts";
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

  it("only raises the reconnecting snapshot warning while a fight is active", async () => {
    const active = await assembleDashboard();
    const health = {
      espn: {
        source: "espn",
        status: "stale" as const,
        fresh: false,
        checkedAt: "2026-08-01T19:30:00.000Z",
      },
    };
    expect(
      collectorSnapshotIsStale({
        connection: "connected",
        dashboard: active,
        health,
        unifiedRounds: [],
        lifecycle: {},
        clocks: {},
        marketDeliveries: {},
      }),
    ).toBe(true);

    const completed = {
      ...active,
      event: {
        ...active.event,
        bouts: active.event.bouts.map((bout) => ({
          ...bout,
          status: "final" as const,
        })),
      },
    };
    expect(
      collectorSnapshotIsStale({
        connection: "reconnecting",
        dashboard: completed,
        health,
        unifiedRounds: [],
        lifecycle: {},
        clocks: {},
        marketDeliveries: {},
      }),
    ).toBe(false);
  });

  it("keeps the fight navigation focused on the remaining views", () => {
    const tabs = renderToStaticMarkup(
      <SectionTabs active="summary" onChange={() => undefined} />,
    );
    expect(tabs).toContain(">Fight</button>");
    expect(tabs).toContain(">Stats</button>");
    expect(tabs).toContain(">Odds</button>");
    expect(tabs).toContain(">Tale</button>");
  });

  it("omits the Odds tab from a completed fight's navigation", () => {
    const tabs = renderToStaticMarkup(
      <SectionTabs
        active="summary"
        onChange={() => undefined}
        sections={["summary", "stats", "tale"]}
      />,
    );
    expect(tabs).not.toContain(">Odds</button>");
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

  it("does not label fixture live odds as completed-round odds", async () => {
    const state = await assembleDashboard();
    const main = state.boutViews["bout-main"];
    expect(main).toBeDefined();
    if (!main) return;

    const html = renderToStaticMarkup(
      <FightSummary view={main} eventStartsAt={state.event.startsAt} selection={2} />,
    );
    expect(html).not.toContain('data-market-accent="kalshi"');
    expect(html).not.toContain(">Odds<");
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

  it("omits the Sherdog scorecard panel when no round score exists", async () => {
    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;

    const scorecards = renderToStaticMarkup(<ScorecardFeed view={view} />);
    expect(scorecards).toBe("");
    expect(scorecards).not.toContain('class="scorecard-judge"');
    expect(scorecards).not.toContain("10–9");
  });

  it("omits unscored Sherdog placeholders and renders stored scorer-card photos", async () => {
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
              aiSummary: "Reyes controlled the round behind clean counters.",
              scorerCards: [
                { scorer: "Future round" },
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

    expect(scorecards).not.toContain("Reyes controlled the round behind clean counters.");
    expect(scorecards).not.toContain("Measured exchanges.");
    expect(scorecards).not.toContain("Future round");
    expect(scorecards).not.toContain("delivery-freshness");
    expect(scorecards).not.toContain("Sherdog · Round");
    expect(scorecards).not.toContain("received");
    expect(scorecards).toContain('class="scorecard-judge-avatar"');
    expect(scorecards).toContain('alt=""');
    expect(scorecards).toContain('aria-label="Sherdog scorecards through round 1"');
    expect(scorecards).toContain("10-9");
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

  // App.tsx has no runnable interaction-simulation harness in this repo (its
  // tests are all `renderToStaticMarkup` snapshots of the actual rendering
  // components, never a rendered+clicked <App/> — there's no
  // testing-library/jsdom-event setup here), so this exercises the same two
  // rendering paths App.tsx wires archived events through — EventList's
  // "Past events" grouping, and the final-bout SectionTabs/BoutHeader
  // combination a selected archived event's boutViews resolve to — rather
  // than driving App's own internal navigation state.
  it("feeds an archived event into Past events and its own locked bout data into the fight view", async () => {
    const liveState = await assembleDashboard();
    const liveView = liveState.boutViews["bout-main"];
    expect(liveView).toBeDefined();
    if (!liveView) return;

    // A record that differs from the live mock event's own bout-main
    // fighters, so the assertions below can only pass by actually reading
    // the archived payload, not by coincidentally matching the live one.
    const archivedRedRecord = { wins: 30, losses: 1, draws: 0, noContests: 0 };
    const archivedBout = {
      ...liveView.bout,
      id: "archived-bout-1",
      status: "final" as const,
      fighters: {
        red: {
          ...liveView.bout.fighters.red,
          name: "Archived Red",
          record: archivedRedRecord,
        },
        blue: { ...liveView.bout.fighters.blue, name: "Archived Blue" },
      },
    };
    const archivedView: BoutView = { ...liveView, bout: archivedBout };

    const archivedEntry: EventListEntry = {
      id: "archived-event-1",
      name: "UFC 000: Archived vs. Event",
      startsAt: "2026-01-01T00:00:00.000Z",
      isComplete: true,
    };

    // Step 1: an archived summary lands in EventList's "Past events" group
    // (the shape App.tsx's archivedEventEntries maps ArchivedEventSummary
    // into).
    const eventListMarkup = renderToStaticMarkup(
      <EventList
        currentEvent={null}
        events={[archivedEntry]}
        selectedId=""
        onSelect={() => undefined}
      />,
    );
    expect(eventListMarkup).toContain("Past events");
    expect(eventListMarkup).toContain("UFC 000: Archived vs. Event");

    // Step 2: selecting that event resolves its bout data from the
    // archived payload — a final bout's SectionTabs drops Odds, and its
    // BoutHeader shows the archived record, not the live mock's.
    const tabsMarkup = renderToStaticMarkup(
      <SectionTabs
        active="summary"
        onChange={() => undefined}
        sections={
          archivedView.bout.status === "final"
            ? ["summary", "stats", "tale"]
            : undefined
        }
      />,
    );
    expect(tabsMarkup).not.toContain(">Odds</button>");

    const headerMarkup = renderToStaticMarkup(
      <BoutHeader
        weightClassLabel=""
        titleFight={archivedBout.titleFight}
        scheduledRounds={archivedBout.scheduledRounds}
        fighters={archivedBout.fighters}
        status={archivedBout.status}
        currentRound={archivedBout.currentRound}
        result={archivedBout.result}
      />,
    );
    expect(headerMarkup).toContain("Archived");
    expect(headerMarkup).toContain(fmtRecord(archivedRedRecord));
    expect(headerMarkup).not.toContain(fmtRecord(liveView.bout.fighters.red.record));
  });
});
