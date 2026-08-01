import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MatchupCard } from "./MatchupCard.tsx";

const RED = { name: "Danilo Reyes" };
const BLUE = { name: "Marco Silva" };

function slots(markup: string): string[] {
  const matches = [
    ...markup.matchAll(/<span class="event-card-arrow-slot[^"]*">/g),
  ];
  return matches.map((m) => m[0]);
}

describe("MatchupCard winner arrow", () => {
  it("reserves a fixed-width slot on both sides regardless of winner", () => {
    const noWinner = renderToStaticMarkup(
      <MatchupCard
        red={RED}
        blue={BLUE}
        center={<span>vs</span>}
        isSelected={false}
        onSelect={() => {}}
      />,
    );
    const redWon = renderToStaticMarkup(
      <MatchupCard
        red={RED}
        blue={BLUE}
        center={<span>KO/TKO</span>}
        winnerCorner="red"
        isSelected={false}
        onSelect={() => {}}
      />,
    );
    const blueWon = renderToStaticMarkup(
      <MatchupCard
        red={RED}
        blue={BLUE}
        center={<span>SUB</span>}
        winnerCorner="blue"
        isSelected={false}
        onSelect={() => {}}
      />,
    );

    // Exactly two slots, always, regardless of winner.
    expect(slots(noWinner)).toHaveLength(2);
    expect(slots(redWon)).toHaveLength(2);
    expect(slots(blueWon)).toHaveLength(2);

    // The winner's arrow lives in its own corner's slot, the other slot
    // stays present but empty — so the DOM order/width around `center`
    // never changes.
    expect(redWon).toContain("tot-winner-arrow-red");
    expect(redWon.indexOf("tot-winner-arrow-red")).toBeLessThan(
      redWon.indexOf(">KO/TKO<"),
    );
    expect(blueWon).toContain("tot-winner-arrow-blue");
    expect(blueWon.indexOf("tot-winner-arrow-blue")).toBeGreaterThan(
      blueWon.indexOf(">SUB<"),
    );
  });
});
