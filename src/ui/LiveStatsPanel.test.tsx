import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoutView } from "../schema.ts";
import { LiveStatsPanel } from "./LiveStatsPanel.tsx";

const view = {
  bout: { status: "in-round" },
  rounds: {
    espn: [{
      round: 1,
      stats: {
        red: { significantStrikesLanded: 5, significantStrikesAttempted: 11, totalStrikesLanded: 12, totalStrikesAttempted: 20, headStrikesLanded: 3, headStrikesAttempted: 7, bodyStrikesLanded: 1, bodyStrikesAttempted: 2, legStrikesLanded: 1, legStrikesAttempted: 2, takedownsLanded: 1, takedownsAttempted: 2, submissionsAttempted: 1, controlTimeSeconds: 64, knockdowns: 0, reversals: 1 },
        blue: { significantStrikesLanded: 4, significantStrikesAttempted: 9, totalStrikesLanded: 10, totalStrikesAttempted: 17, headStrikesLanded: 2, headStrikesAttempted: 6, bodyStrikesLanded: 1, bodyStrikesAttempted: 1, legStrikesLanded: 1, legStrikesAttempted: 2, takedownsLanded: 0, takedownsAttempted: 1, submissionsAttempted: 0, controlTimeSeconds: 3, knockdowns: 1, reversals: 0 },
      },
      provenance: { source: "espn", fetchedAt: "2026-08-01T00:00:00Z", synthetic: false },
    }],
  },
} as unknown as BoutView;

describe("LiveStatsPanel", () => {
  it("renders ESPN's expanded corner comparison with concise landed/attempted values", () => {
    const html = renderToStaticMarkup(<LiveStatsPanel view={view} selection={1} />);
    expect(html).toContain("Round 1 statistics");
    expect(html).toContain(">5/11<");
    expect(html).toContain(">12/20<");
    expect(html).toContain("Submission attempts");
    expect(html).toContain("Reversals");
    expect(html).toContain("ESPN");
  });

  it("renders an honest empty state when ESPN has not supplied detailed stats", () => {
    const empty = { ...view, rounds: { espn: [] } } as BoutView;
    const html = renderToStaticMarkup(<LiveStatsPanel view={empty} selection={1} />);
    expect(html).toContain("Detailed ESPN statistics will appear as the fight progresses.");
  });
});
