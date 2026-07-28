import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  EspnScheduledCard,
  EspnScheduledEventSummary,
  EspnScheduledFight,
  EspnScheduledFighter,
} from "../sources/espnSchedule.ts";
import { fmtTime } from "./format.ts";
import { ScheduledCardRail } from "./ScheduledCardRail.tsx";
import { UpcomingEventRail } from "./UpcomingEventRail.tsx";

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
    const markup = renderToStaticMarkup(<ScheduledCardRail card={card} />);
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
    const markup = renderToStaticMarkup(<ScheduledCardRail card={card} />);

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
    const markup = renderToStaticMarkup(<ScheduledCardRail card={card} />);
    expect(markup).toContain(">TITLE<");
    expect(markup).toContain(">UPCOMING<");
  });

  it("never renders a per-fight timestamp, only the section's", () => {
    const markup = renderToStaticMarkup(<ScheduledCardRail card={card} />);
    expect(markup).not.toContain("01:20");
    expect(markup).not.toContain(card.sections[0]!.fights[1]!.startsAt!);
  });

  it("omits the weight element and does not crash when weightClassLabel is absent", () => {
    expect(() =>
      renderToStaticMarkup(<ScheduledCardRail card={card} />),
    ).not.toThrow();

    const markup = renderToStaticMarkup(<ScheduledCardRail card={card} />);
    expect(markup).not.toMatch(/<span class="rail-weight"><\/span>/);
  });

  it("renders fights as non-interactive rows, not buttons", () => {
    const markup = renderToStaticMarkup(<ScheduledCardRail card={card} />);
    expect(markup).not.toContain("<button");
  });
});

describe("UpcomingEventRail", () => {
  const events: EspnScheduledEventSummary[] = [
    { eventId: "1", name: "UFC 500", startsAt: "2026-08-01T14:00:00Z" },
    {
      eventId: "2",
      name: "UFC 501",
      shortName: "UFC 501",
      startsAt: "2026-08-08T14:00:00Z",
    },
  ];

  it("lists the current event first and pre-selected, then upcoming ESPN events", () => {
    const markup = renderToStaticMarkup(
      <UpcomingEventRail
        currentEvent={{
          id: "current",
          name: "UFC Fight Night: X vs. Y",
          startsAt: "2026-07-28T22:00:00Z",
        }}
        events={events}
        selectedId="current"
        onSelect={() => undefined}
      />,
    );

    expect(markup).toContain("Current event");
    expect(markup).toContain("Upcoming events");

    const currentIdx = markup.indexOf("UFC Fight Night: X vs. Y");
    const firstUpcomingIdx = markup.indexOf("UFC 500");
    expect(currentIdx).toBeGreaterThan(-1);
    expect(currentIdx).toBeLessThan(firstUpcomingIdx);

    const selectedMatches = markup.match(/aria-current="true"/g) ?? [];
    expect(selectedMatches.length).toBe(1);
  });

  it("marks a selected future ESPN event, not the current one", () => {
    const markup = renderToStaticMarkup(
      <UpcomingEventRail
        currentEvent={{
          id: "current",
          name: "Current",
          startsAt: "2026-07-28T22:00:00Z",
        }}
        events={events}
        selectedId="2"
        onSelect={() => undefined}
      />,
    );

    const selectedMatches = markup.match(/aria-current="true"/g) ?? [];
    expect(selectedMatches.length).toBe(1);

    const idx = markup.indexOf('aria-current="true"');
    const buttonStart = markup.lastIndexOf("<button", idx);
    const buttonEnd = markup.indexOf("</button>", idx);
    expect(markup.slice(buttonStart, buttonEnd)).toContain("UFC 501");
  });
});
