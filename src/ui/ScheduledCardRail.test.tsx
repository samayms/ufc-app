import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  EspnScheduledCard,
  EspnScheduledFight,
  EspnScheduledFighter,
} from "../sources/espnSchedule.ts";
import { fmtTime } from "./format.ts";
import { ScheduledCardRail } from "./ScheduledCardRail.tsx";

function fighter(
  name: string,
  overrides: Partial<EspnScheduledFighter> = {},
): EspnScheduledFighter {
  return { name, ...overrides };
}

function fight(
  overrides: Partial<EspnScheduledFight> & {
    competitionId: string;
    red: EspnScheduledFighter;
    blue: EspnScheduledFighter;
  },
): EspnScheduledFight {
  return { titleFight: false, mainEvent: false, ...overrides };
}

/** Built directly from the contract types — deliberately not the data layer's own fixtures. */
const card: EspnScheduledCard = {
  eventId: "600060773",
  name: "UFC 999: Test vs. Fixture",
  startsAt: "2026-08-16T01:00:00.000+00:00",
  venue: "Test Arena",
  city: "Las Vegas, NV",
  sections: [
    {
      key: "main",
      displayName: "Main Card",
      segment: "main-card",
      startsAt: "2026-08-16T01:00:00.000+00:00",
      fights: [
        fight({
          competitionId: "c1",
          matchNumber: 1,
          titleFight: true,
          mainEvent: true,
          weightClassLabel: "Welterweight",
          red: fighter("Main Red"),
          blue: fighter("Main Blue"),
        }),
        fight({
          competitionId: "c2",
          matchNumber: 2,
          mainEvent: false,
          // A per-fight startsAt should never be rendered — only the section's.
          startsAt: "2026-08-16T01:20:00.000+00:00",
          weightClassLabel: "Middleweight",
          red: fighter("Co Red"),
          blue: fighter("Co Blue"),
        }),
      ],
    },
    {
      key: "prelims1",
      displayName: "Prelims",
      segment: "prelims",
      startsAt: "2026-08-15T22:00:00.000+00:00",
      fights: [
        fight({
          competitionId: "c3",
          matchNumber: 3,
          // No weightClassLabel — ESPN omits `type` on newly-announced fights.
          red: fighter("Prelim Red"),
          blue: fighter("Prelim Blue"),
        }),
      ],
    },
    {
      key: "prelims2",
      displayName: "Early Prelims",
      segment: "early-prelims",
      // No startsAt for this section.
      fights: [
        fight({
          competitionId: "c4",
          matchNumber: 4,
          weightClassLabel: "Flyweight",
          red: fighter("Early Red"),
          blue: fighter("Early Blue"),
        }),
      ],
    },
  ],
};

describe("ScheduledCardRail", () => {
  it("renders fights in the given order with the main event first, never re-sorting", () => {
    const markup = renderToStaticMarkup(
      <ScheduledCardRail card={card} onSelect={() => undefined} />,
    );
    const mainRedIndex = markup.indexOf("Main Red");
    const coRedIndex = markup.indexOf("Co Red");
    const prelimRedIndex = markup.indexOf("Prelim Red");
    const earlyRedIndex = markup.indexOf("Early Red");

    expect(mainRedIndex).toBeGreaterThan(-1);
    expect(mainRedIndex).toBeLessThan(coRedIndex);
    expect(coRedIndex).toBeLessThan(prelimRedIndex);
    expect(prelimRedIndex).toBeLessThan(earlyRedIndex);
  });

  it("shows the three section headings with their start times, omitting the time when absent", () => {
    const markup = renderToStaticMarkup(
      <ScheduledCardRail card={card} onSelect={() => undefined} />,
    );

    expect(markup).toContain(
      `Main Card · from ${fmtTime(card.sections[0]!.startsAt!)}`,
    );
    expect(markup).toContain(
      `Prelims · from ${fmtTime(card.sections[1]!.startsAt!)}`,
    );
    expect(markup).toContain(">Early Prelims<");
    expect(markup).not.toContain("Early Prelims · from");
  });

  it("labels chips TITLE / MAIN / UPCOMING per fight", () => {
    const markup = renderToStaticMarkup(
      <ScheduledCardRail card={card} onSelect={() => undefined} />,
    );
    expect(markup).toContain(">TITLE<");
    expect(markup).toContain(">UPCOMING<");
  });

  it("never renders a per-fight timestamp, only the section's", () => {
    const markup = renderToStaticMarkup(
      <ScheduledCardRail card={card} onSelect={() => undefined} />,
    );
    expect(markup).not.toContain("01:20");
    expect(markup).not.toContain(card.sections[0]!.fights[1]!.startsAt!);
  });

  it("omits the weight element and does not crash when weightClassLabel is absent", () => {
    expect(() =>
      renderToStaticMarkup(<ScheduledCardRail card={card} onSelect={() => undefined} />),
    ).not.toThrow();

    const markup = renderToStaticMarkup(
      <ScheduledCardRail card={card} onSelect={() => undefined} />,
    );
    expect(markup).not.toMatch(/<span class="rail-weight"><\/span>/);
  });

  it("renders each fight as a clickable button, one per fight", () => {
    const markup = renderToStaticMarkup(
      <ScheduledCardRail card={card} onSelect={vi.fn()} />,
    );
    const buttonCount = (markup.match(/<button/g) ?? []).length;
    expect(buttonCount).toBe(4);
  });
});
