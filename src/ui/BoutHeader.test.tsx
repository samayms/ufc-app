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
    expect(markup).toContain("R2 · ESPN sync");
  });
});
