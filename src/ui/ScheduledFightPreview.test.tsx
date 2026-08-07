import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Bout } from "../schema.ts";
import type { UpcomingOddsState } from "../store/useUpcomingOdds.ts";
import {
  boutToScheduledFight,
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
