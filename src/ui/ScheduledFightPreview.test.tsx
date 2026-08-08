import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Bout, BoutView } from "../schema.ts";
import type { UpcomingOddsState } from "../store/useUpcomingOdds.ts";
import {
  boutToScheduledFight,
  liveBoutToUpcomingOdds,
  ScheduledFightPreview,
  UpcomingOddsSection,
  UpcomingTaleSection,
} from "./ScheduledFightPreview.tsx";

const bout: Bout = {
  id: "fixture-upcoming-bout",
  externalRefs: [{ source: "espn", id: "fixture-upcoming-bout" }],
  eventId: "fixture-live-event",
  cardPosition: 3,
  segment: "prelims",
  weightClass: "lightweight",
  scheduledRounds: 3,
  titleFight: false,
  fighters: {
    red: {
      id: "red",
      externalRefs: [{ source: "espn", id: "red" }],
      name: "Red Fixture",
      record: { wins: 10, losses: 2, draws: 0, noContests: 0 },
      provenance: {
        source: "fixture",
        fetchedAt: "2026-07-29T00:00:00Z",
        synthetic: true,
      },
    },
    blue: {
      id: "blue",
      externalRefs: [{ source: "espn", id: "blue" }],
      name: "Blue Fixture",
      record: { wins: 8, losses: 3, draws: 0, noContests: 0 },
      provenance: {
        source: "fixture",
        fetchedAt: "2026-07-29T00:00:00Z",
        synthetic: true,
      },
    },
  },
  status: "upcoming",
  provenance: {
    source: "fixture",
    fetchedAt: "2026-07-29T00:00:00Z",
    synthetic: true,
  },
};

const upcoming: UpcomingOddsState = {
  status: "ready",
  document: null,
  stale: false,
  reload: () => undefined,
};

describe("ScheduledFightPreview", () => {
  it("adapts an upcoming event bout and keeps live-only tabs hidden", () => {
    const fight = boutToScheduledFight(bout);
    const html = renderToStaticMarkup(
      <ScheduledFightPreview fight={fight} upcoming={upcoming} />,
    );

    expect(fight.weightClassLabel).toBe("Lightweight");
    expect(html).toContain(">Tale</button>");
    expect(html).toContain(">Odds</button>");
    expect(html).not.toContain(">Fight</button>");
    expect(html).not.toContain(">Stats</button>");
  });

  it("shows a finished past-event fight as Final, not Upcoming", () => {
    const finishedBout: Bout = {
      ...bout,
      id: "fixture-past-bout",
      status: "final",
      result: { winner: "red", method: "ko-tko", round: 2, time: "3:14" },
    };
    const fight = boutToScheduledFight(finishedBout);
    const html = renderToStaticMarkup(
      <ScheduledFightPreview fight={fight} upcoming={upcoming} />,
    );

    expect(html).not.toContain("Upcoming");
    expect(html).toContain("KO/TKO");
    expect(html).toContain("tot-winner-arrow-red");
  });

  it("drops the Odds tab for a finished fight, leaving only Tale", () => {
    const finishedBout: Bout = {
      ...bout,
      id: "fixture-past-bout-odds-check",
      status: "final",
      result: { winner: "red", method: "ko-tko", round: 2, time: "3:14" },
    };
    const fight = boutToScheduledFight(finishedBout);
    const html = renderToStaticMarkup(
      <ScheduledFightPreview fight={fight} upcoming={upcoming} />,
    );

    expect(html).toContain(">Tale</button>");
    expect(html).not.toContain(">Odds</button>");
    expect(html).not.toContain(">Fight</button>");
    expect(html).not.toContain(">Stats</button>");
  });

  it("renders the fight-outlook heading and text when outlook is present", () => {
    const html = renderToStaticMarkup(
      <UpcomingTaleSection
        fighters={bout.fighters}
        outlook="Real Sherdog-derived outlook text."
      />,
    );

    expect(html).toContain("Fight outlook");
    expect(html).toContain("Real Sherdog-derived outlook text.");
  });

  it("omits the fight-outlook heading and panel entirely when outlook is absent", () => {
    const html = renderToStaticMarkup(
      <UpcomingTaleSection fighters={bout.fighters} />,
    );

    expect(html).not.toContain("Fight outlook");
    expect(html).not.toContain("outlook-panel");
  });
});

const LOADING_FIGHT = {
  competitionId: "c1",
  red: { name: "Danilo Reyes" },
  blue: { name: "Marco Silva" },
} as Parameters<typeof UpcomingOddsSection>[0]["fight"];

describe("UpcomingOddsSection loading state", () => {
  it("renders skeleton rows instead of a blank panel while odds are loading", () => {
    const markup = renderToStaticMarkup(
      <UpcomingOddsSection
        fight={LOADING_FIGHT}
        upcoming={{ status: "loading", document: null, stale: false, reload: () => undefined }}
      />,
    );
    expect(markup).toContain("skeleton");
  });
});

describe("liveBoutToUpcomingOdds", () => {
  it("carries a live snapshot's volume through as provider metadata", () => {
    const view: BoutView = {
      bout,
      rounds: {},
      latestOdds: {
        kalshi: {
          boutId: bout.id,
          market: "kalshi",
          quotes: [],
          volume: 4_200,
          provenance: {
            source: "kalshi",
            fetchedAt: "2026-08-08T00:00:00Z",
            synthetic: false,
          },
        },
      },
      oddsHistory: {},
      marketMoves: {},
      preFightOdds: {},
    };

    const upcomingBout = liveBoutToUpcomingOdds(view);

    // Without this, UpcomingOddsPanel's MetadataFooter has nothing to read
    // and a live Kalshi/Polymarket block never shows Vol/OI/Liq — the exact
    // stats the same panel shows for an upcoming (not-yet-started) fight.
    expect(upcomingBout.providers.kalshi?.metadata?.volume).toBe(4_200);
  });
});

describe("UpcomingOddsSection", () => {
  it("keeps the real go-the-distance market once the fight goes live, instead of blanking it to not_listed", () => {
    // The live tick pipeline has never carried a "go the distance" market —
    // liveBoutToUpcomingOdds always stamps decision as not_listed. The
    // moment a bout has any live moneyline odds, UpcomingOddsSection used to
    // switch wholesale to that live view, discarding the real distance
    // market the upcoming-odds sync already had, even though nothing about
    // the fight starting makes that market stop existing.
    const fight = boutToScheduledFight(bout);
    const liveView: BoutView = {
      bout: { ...bout, status: "in-round", currentRound: 1 },
      rounds: {},
      latestOdds: {
        kalshi: {
          boutId: bout.id,
          market: "kalshi",
          quotes: [],
          volume: 5_000,
          provenance: {
            source: "kalshi",
            fetchedAt: "2026-08-08T00:00:00Z",
            synthetic: false,
          },
        },
      },
      oddsHistory: {},
      marketMoves: {},
      preFightOdds: {},
    };
    const upcomingWithDecision: UpcomingOddsState = {
      status: "ready",
      stale: false,
      reload: () => undefined,
      document: {
        version: 1,
        generatedAt: "2026-08-08T00:00:00Z",
        synthetic: false,
        events: [
          {
            espnEventId: bout.eventId,
            name: "Fixture Event",
            bouts: [
              {
                boutId: bout.id,
                espnEventId: bout.eventId,
                redFighter: bout.fighters.red.name,
                blueFighter: bout.fighters.blue.name,
                providers: {
                  "odds-api": {
                    status: "loaded",
                    fetchedAt: "2026-08-08T00:00:00Z",
                    snapshot: {
                      boutId: bout.id,
                      market: "sportsbook",
                      quotes: [
                        {
                          corner: "red",
                          impliedProbability: 0.61,
                          native: {
                            kind: "american-moneyline",
                            moneyline: -155,
                            book: "draftkings",
                          },
                        },
                        {
                          corner: "blue",
                          impliedProbability: 0.39,
                          native: {
                            kind: "american-moneyline",
                            moneyline: 135,
                            book: "draftkings",
                          },
                        },
                      ],
                      provenance: {
                        source: "odds-api",
                        fetchedAt: "2026-08-08T00:00:00Z",
                        synthetic: false,
                      },
                    },
                  },
                },
                decision: {
                  state: "loaded",
                  decisionProbability: 0.62,
                  finishProbability: 0.38,
                  source: "kalshi",
                  fetchedAt: "2026-08-08T00:00:00Z",
                  synthetic: false,
                },
              },
            ],
          },
        ],
        providerRuns: {},
        unmatchedMarkets: [],
      },
    };

    const html = renderToStaticMarkup(
      <UpcomingOddsSection
        fight={fight}
        upcoming={upcomingWithDecision}
        liveView={liveView}
      />,
    );

    expect(html).toContain("Go the distance");
    expect(html).toContain('aria-label="Go the distance odds, available"');
    expect(html).toContain('aria-label="Sportsbooks odds, stale"');
    expect(html).toContain("-155");
  });
});
