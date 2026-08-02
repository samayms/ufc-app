import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoutView, SherdogScorerCard } from "../schema.ts";
import type { CollectorUnifiedRound } from "../store/collectorClient.ts";
import { matchWinnerCorner, ScorecardFeed } from "./ScorecardFeed.tsx";

// Real fighters from the app's data (see AGENTS/task notes): Sherdog's
// `winner` field drops diacritics ("Rakic"), the fighter's own name keeps
// them ("Rakić"). Reused across tests below.
const view = {
  bout: {
    id: "bout-rakic-tybura",
    scheduledRounds: 3,
    fighters: {
      red: { name: "Aleksandar Rakić" },
      blue: { name: "Marcin Tybura" },
    },
  },
} as unknown as BoutView;

function unifiedRound(
  round: number,
  scorerCards: SherdogScorerCard[],
): CollectorUnifiedRound {
  return {
    boutId: view.bout.id,
    round,
    sherdog: { round, scorerCards },
  } as unknown as CollectorUnifiedRound;
}

describe("matchWinnerCorner", () => {
  const fighters = { red: "Aleksandar Rakić", blue: "Marcin Tybura" };

  it("maps a diacritic-stripped Sherdog surname to the right corner", () => {
    expect(matchWinnerCorner("Rakic", fighters)).toBe("red");
    expect(matchWinnerCorner("Tybura", fighters)).toBe("blue");
  });

  it("returns undefined for a name that matches neither fighter", () => {
    expect(matchWinnerCorner("Silva", fighters)).toBeUndefined();
    expect(matchWinnerCorner(undefined, fighters)).toBeUndefined();
  });

  it("is case-insensitive", () => {
    expect(matchWinnerCorner("RAKIC", fighters)).toBe("red");
    expect(matchWinnerCorner("rakic", fighters)).toBe("red");
  });
});

describe("ScorecardFeed", () => {
  it("returns empty markup when nothing is scored", () => {
    const markup = renderToStaticMarkup(<ScorecardFeed view={view} records={[]} />);
    expect(markup).toBe("");
  });

  it("shows round 1's score as the running total and the winner's accented name, corner-coloured, with rounds 2-3 dashed", () => {
    const records = [
      unifiedRound(1, [
        { scorer: "Brian Knapp", winner: "Rakic", roundScore: "10-9" },
      ]),
    ];

    const markup = renderToStaticMarkup(
      <ScorecardFeed view={view} records={records} round={1} />,
    );

    expect(markup).toContain("10 - 9");
    // The regression that matters: Sherdog sent the unaccented "Rakic", the
    // rendered name must be the fighter's own accented spelling.
    expect(markup).toContain("Rakić");
    expect(markup).not.toContain(">Rakic<");
    expect(markup).toContain('class="scorecard-judge-winner corner-red"');
    // Grid is fixed to the bout's 3 scheduled rounds; rounds 2-3 aren't in yet.
    expect((markup.match(/scorecard-round-chip-empty/gu) ?? []).length).toBe(2);
  });

  it("through round 3, shows the final cumulative as the headline score with the winner beside it, every round chip filled", () => {
    const records = [
      unifiedRound(1, [{ scorer: "Brian Knapp", winner: "Rakic", roundScore: "10-9" }]),
      unifiedRound(2, [{ scorer: "Brian Knapp", winner: "Tybura", roundScore: "9-10" }]),
      unifiedRound(3, [
        {
          scorer: "Brian Knapp",
          winner: "Rakic",
          roundScore: "10-9",
          cumulativeScore: "29-28",
        },
      ]),
    ];

    const markup = renderToStaticMarkup(
      <ScorecardFeed view={view} records={records} allRounds />,
    );

    expect(markup).toContain("29 - 28");
    expect(markup).toContain("Rakić");
    expect(markup).toContain('class="scorecard-judge-winner corner-red"');
    expect(markup).not.toContain("scorecard-round-chip-empty");
  });

  it("falls back to the latest round's own score as the headline when no round ever carried a cumulative", () => {
    const records = [
      unifiedRound(1, [{ scorer: "Brian Knapp", winner: "Rakic", roundScore: "10-9" }]),
      unifiedRound(2, [{ scorer: "Brian Knapp", winner: "Tybura", roundScore: "9-10" }]),
    ];

    const markup = renderToStaticMarkup(
      <ScorecardFeed view={view} records={records} allRounds />,
    );

    expect(markup).toContain('class="scorecard-judge-score num" title="9-10">9 - 10<');
    expect((markup.match(/scorecard-round-chip-empty/gu) ?? []).length).toBe(1);
  });
});
