import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { interpolateClockSeconds } from "../store/collectorClient.ts";
import { loadFixtureEvent } from "../store/fixtureEvent.ts";
import { BoutHeader, formatFightClock } from "./BoutHeader.tsx";

describe("BoutHeader live clock", () => {
  it("counts down from the latest source value and clamps at zero", () => {
    const sync = {
      clockSeconds: 197,
      receivedAt: "2026-07-28T01:00:00Z",
    };

    expect(
      interpolateClockSeconds(sync, Date.parse("2026-07-28T01:00:04Z")),
    ).toBe(193);
    expect(
      interpolateClockSeconds(sync, Date.parse("2026-07-28T01:10:00Z")),
    ).toBe(0);
    expect(formatFightClock(193)).toBe("3:13");
    expect(formatFightClock(undefined)).toBe("-:--");
  });

  it("renders the synchronized ESPN clock as the primary live datum", () => {
    const bout = loadFixtureEvent().bouts[0]!;
    const markup = renderToStaticMarkup(
      <BoutHeader
        weightClassLabel="Welterweight"
        titleFight={false}
        scheduledRounds={3}
        fighters={bout.fighters}
        status="in-round"
        currentRound={2}
        clockSync={{
          boutId: bout.id,
          source: "espn",
          state: "in",
          period: 2,
          completed: false,
          clockSeconds: 197,
          sourceReceivedAt: "2999-01-01T00:00:00Z",
          receivedAt: "2999-01-01T00:00:00Z",
        }}
      />,
    );

    expect(markup).toContain('role="timer"');
    expect(markup).toContain("3:17");
    expect(markup).toContain("In round");
    expect(markup).toContain("Round 2");
    expect(markup).not.toContain("ESPN sync");
  });

  it("renders walkouts and end-of-round states without fake round zero copy", () => {
    const bout = loadFixtureEvent().bouts[0]!;
    const walkouts = renderToStaticMarkup(
      <BoutHeader
        weightClassLabel="Welterweight"
        titleFight={false}
        scheduledRounds={3}
        fighters={bout.fighters}
        status="in-round"
        currentRound={0}
      />,
    );
    const roundEnd = renderToStaticMarkup(
      <BoutHeader
        weightClassLabel="Welterweight"
        titleFight={false}
        scheduledRounds={3}
        fighters={bout.fighters}
        status="between-rounds"
        currentRound={2}
      />,
    );

    expect(walkouts).toContain("Walkouts");
    expect(walkouts).toContain("Round 1");
    expect(walkouts).not.toContain("R0");
    expect(roundEnd).toContain("End round");
    expect(roundEnd).toContain("R2");
    expect(roundEnd).toContain("Round 3 next");
  });

  it("makes the final method and round explicit", () => {
    const bout = loadFixtureEvent().bouts[0]!;
    const markup = renderToStaticMarkup(
      <BoutHeader
        weightClassLabel="Welterweight"
        titleFight={false}
        scheduledRounds={3}
        fighters={bout.fighters}
        status="final"
        result={{ winner: "red", method: "submission", round: 2, time: "3:41" }}
      />,
    );

    expect(markup).toContain(">SUB<");
    expect(markup).toContain("Round 2 · 3:41");
    expect(markup).toContain("tot-winner-arrow-red");
    expect(markup).toContain('aria-label="Danilo Reyes won"');
    expect(markup).not.toContain("Reyes wins");
  });

  it("puts the winner arrow inline beside the method, in a fixed slot", () => {
    const bout = loadFixtureEvent().bouts[0]!;
    const redWon = renderToStaticMarkup(
      <BoutHeader
        weightClassLabel="Welterweight"
        titleFight={false}
        scheduledRounds={3}
        fighters={bout.fighters}
        status="final"
        result={{ winner: "red", method: "submission", round: 2, time: "3:41" }}
      />,
    );
    const blueWon = renderToStaticMarkup(
      <BoutHeader
        weightClassLabel="Welterweight"
        titleFight={false}
        scheduledRounds={3}
        fighters={bout.fighters}
        status="final"
        result={{ winner: "blue", method: "ko-tko", round: 1, time: "1:02" }}
      />,
    );

    // Red wins: arrow slot comes before the method text.
    expect(redWon.indexOf("tot-method-arrow-slot")).toBeLessThan(
      redWon.indexOf(">SUB<"),
    );
    expect(redWon).toContain("tot-winner-arrow-red");

    // Blue wins: arrow slot comes after the method text.
    expect(blueWon.indexOf(">KO/TKO<")).toBeLessThan(
      blueWon.indexOf("tot-method-arrow-slot"),
    );
    expect(blueWon).toContain("tot-winner-arrow-blue");

    // Round/time substate is unaffected either way.
    expect(redWon).toContain("Round 2 · 3:41");
    expect(blueWon).toContain("Round 1 · 1:02");
  });
});
