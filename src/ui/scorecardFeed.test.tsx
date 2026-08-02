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

  it("shows the reformatted round score and the winner's accented name, corner-coloured", () => {
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
    expect(markup).toContain('class="media-scorecard-winner corner-red"');
  });

  it("in total mode, joins every round's score in order and shows the final cumulative with the winner in parens", () => {
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

    expect(markup).toContain("10 - 9, 9 - 10, 10 - 9");
    expect(markup).toContain("29 - 28");
    expect(markup).toContain("(");
    expect(markup).toContain("Rakić");
    expect(markup).toContain('class="media-scorecard-winner corner-red"');
  });

  it("omits the cumulative line in total mode when no round ever carried one", () => {
    const records = [
      unifiedRound(1, [{ scorer: "Brian Knapp", winner: "Rakic", roundScore: "10-9" }]),
      unifiedRound(2, [{ scorer: "Brian Knapp", winner: "Tybura", roundScore: "9-10" }]),
    ];

    const markup = renderToStaticMarkup(
      <ScorecardFeed view={view} records={records} allRounds />,
    );

    expect(markup).toContain("10 - 9, 9 - 10");
    expect(markup).not.toContain("media-scorecard-total");
  });
});
