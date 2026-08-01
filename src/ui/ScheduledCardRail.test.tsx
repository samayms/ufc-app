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
  return { titleFight: false, mainEvent: false, status: "upcoming", ...overrides };
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
          mainEvent: true,
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
    // Fighter names render as separate first/last spans, so look for the
    // (uniquely identifying) first name rather than the full string.
    const mainRedIndex = markup.indexOf(">Main<");
    const coRedIndex = markup.indexOf(">Co<");
    const prelimRedIndex = markup.indexOf(">Prelim<");
    const earlyRedIndex = markup.indexOf(">Early<");

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

  it("labels every scheduled fight's chip UPCOMING, never TITLE or MAIN", () => {
    const markup = renderToStaticMarkup(
      <ScheduledCardRail card={card} onSelect={() => undefined} />,
    );
    expect(markup).toContain(">UPCOMING<");
    // Regression guard: a scheduled fight's chip always reads UPCOMING,
    // even for title fights or the non-title main event (c2) — it never
    // says TITLE or MAIN.
    expect(markup).not.toContain(">TITLE<");
    expect(markup).not.toContain(">MAIN<");
  });

  it("labels a live or final fight's chip from its ESPN status instead of TITLE/UPCOMING", () => {
    const liveCard: EspnScheduledCard = {
      ...card,
      sections: [
        {
          ...card.sections[0]!,
          fights: [
            fight({
              competitionId: "live1",
              matchNumber: 1,
              status: "in-round",
              currentRound: 2,
              red: fighter("Live Red"),
              blue: fighter("Live Blue"),
            }),
            fight({
              competitionId: "final1",
              matchNumber: 2,
              status: "final",
              result: {
                winner: "red",
                method: "ko-tko",
                round: 1,
              },
              red: fighter("Final Red"),
              blue: fighter("Final Blue"),
            }),
          ],
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <ScheduledCardRail card={liveCard} onSelect={() => undefined} />,
    );

    expect(markup).toContain(">IN R2<");
    expect(markup).toContain(">KO/TKO · R1<");
    expect(markup).toContain('class="event-card is-live"');
    expect(markup).not.toContain(">UPCOMING<");
  });

  it("distinguishes walkouts, active rounds, and completed rounds", () => {
    const phaseCard: EspnScheduledCard = {
      ...card,
      sections: [{
        ...card.sections[0]!,
        fights: [
          fight({
            competitionId: "walkouts",
            matchNumber: 1,
            status: "in-round",
            currentRound: 0,
            red: fighter("Walkout Red"),
            blue: fighter("Walkout Blue"),
          }),
          fight({
            competitionId: "break",
            matchNumber: 2,
            status: "between-rounds",
            currentRound: 1,
            red: fighter("Break Red"),
            blue: fighter("Break Blue"),
          }),
        ],
      }],
    };

    const markup = renderToStaticMarkup(
      <ScheduledCardRail card={phaseCard} onSelect={() => undefined} />,
    );
    expect(markup).toContain(">WALKOUTS<");
    expect(markup).toContain(">END R1<");
    expect(markup).not.toContain("LIVE R0");
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

  it("renders a long surname intact for measured fitting instead of clipping the text", () => {
    const longNameCard: EspnScheduledCard = {
      ...card,
      sections: [
        {
          ...card.sections[0]!,
          fights: [
            fight({
              competitionId: "long-name",
              matchNumber: 1,
              red: fighter("Umar Nurmagomedov"),
              blue: fighter("Song Yadong"),
            }),
          ],
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <ScheduledCardRail card={longNameCard} onSelect={() => undefined} />,
    );

    expect(markup).toContain(">Nurmagomedov</span>");
    expect(markup).not.toContain("event-card-fighter-lastname-compact");
    expect(markup).not.toContain("event-card-fighter-lastname-tight");
  });
});
