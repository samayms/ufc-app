import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Bout } from "../schema.ts";
import type { UpcomingOddsState } from "../store/useUpcomingOdds.ts";
import {
  boutToScheduledFight,
  ScheduledFightPreview,
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
});
