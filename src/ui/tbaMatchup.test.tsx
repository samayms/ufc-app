import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardRail } from "./CardRail.tsx";
import { MatchupCard } from "./MatchupCard.tsx";
import { ScheduledCardRail } from "./ScheduledCardRail.tsx";
import type { Bout } from "../schema.ts";
import type { EspnScheduledCard } from "../sources/espnSchedule.ts";

const card = (over: Partial<Parameters<typeof MatchupCard>[0]> = {}) =>
  renderToStaticMarkup(
    <MatchupCard
      red={{ name: "Opponent TBA" }}
      blue={{ name: "TBA TBA" }}
      center={<span>vs</span>}
      isSelected={false}
      onSelect={() => {}}
      {...over}
    />,
  );

const bout = (id: string, red: string, blue: string): Bout =>
  ({
    id,
    segment: "main-card",
    cardPosition: 1,
    status: "upcoming",
    weightClass: "welterweight",
    scheduledRounds: 3,
    titleFight: false,
    fighters: {
      red: { name: red, record: { wins: 0, losses: 0, draws: 0 } },
      blue: { name: blue, record: { wins: 0, losses: 0, draws: 0 } },
    },
  }) as unknown as Bout;

describe("unannounced matchups are listings, not links", () => {
  it("disables the row when either side is TBA", () => {
    expect(card({ disabled: true })).toContain("disabled");
    expect(card({ disabled: true })).toContain("is-unavailable");
  });

  it("leaves a fully announced row tappable", () => {
    const announced = card({
      red: { name: "Dan Hooker" },
      blue: { name: "Salahdine Parnasse" },
    });
    expect(announced).not.toContain("disabled");
    expect(announced).not.toContain("is-unavailable");
  });

  it("disables TBA bouts in the live event's card rail", () => {
    const markup = renderToStaticMarkup(
      <CardRail
        bouts={[
          bout("real", "Dan Hooker", "Salahdine Parnasse"),
          bout("tba", "Opponent TBA", "TBA TBA"),
        ]}
        selectedId=""
        onSelect={() => {}}
      />,
    );
    const buttons = markup.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).not.toContain("disabled");
    expect(buttons[1]).toContain("disabled");
  });

  it("disables TBA fights on an upcoming ESPN card", () => {
    const espnCard = {
      name: "UFC 331",
      sections: [
        {
          key: "main",
          displayName: "Main card",
          fights: [
            {
              competitionId: "1",
              status: "upcoming",
              red: { name: "Opponent TBA" },
              blue: { name: "TBA TBA" },
            },
            {
              competitionId: "2",
              status: "upcoming",
              red: { name: "Joaquin Buckley" },
              blue: { name: "Mike Malott" },
            },
          ],
        },
      ],
    } as unknown as EspnScheduledCard;
    const buttons =
      renderToStaticMarkup(
        <ScheduledCardRail card={espnCard} onSelect={() => {}} />,
      ).match(/<button[^>]*>/g) ?? [];
    expect(buttons[0]).toContain("disabled");
    expect(buttons[1]).not.toContain("disabled");
  });
});

describe("CardRail segment start times", () => {
  it("shows each segment's start time next to its heading when provided", () => {
    const markup = renderToStaticMarkup(
      <CardRail
        bouts={[
          bout("main", "Dan Hooker", "Salahdine Parnasse"),
          { ...bout("prelim", "Fighter A", "Fighter B"), segment: "prelims" },
        ]}
        selectedId=""
        onSelect={() => {}}
        segmentStartTimes={{
          "main-card": "2026-07-30T22:00:00Z",
          prelims: "2026-07-30T19:00:00Z",
        }}
      />,
    );
    expect(markup).toContain("Main card · from");
    expect(markup).toContain("Prelims · from");
  });

  it("shows a bare segment heading, no dangling separator, when no time is known", () => {
    const markup = renderToStaticMarkup(
      <CardRail
        bouts={[bout("main", "Dan Hooker", "Salahdine Parnasse")]}
        selectedId=""
        onSelect={() => {}}
      />,
    );
    expect(markup).toContain(">Main card<");
    expect(markup).not.toContain("·");
  });
});

describe("TBA name rendering", () => {
  it("shows only the bare TBA, never ESPN's filler first name", () => {
    const markup = card();
    expect(markup).not.toContain("Opponent");
    expect(markup).not.toMatch(/TBA[^<]*<[^>]*>[^<]*TBA/);
    // Exactly one "TBA" label per side, no stacked duplicate.
    expect([...markup.matchAll(/>TBA</g)]).toHaveLength(2);
  });

  it("still renders both name lines for an announced fighter", () => {
    const markup = card({
      red: { name: "Dan Hooker" },
      blue: { name: "Salahdine Parnasse" },
    });
    expect(markup).toContain("Dan");
    expect(markup).toContain("Hooker");
    expect(markup).toContain("Salahdine");
    expect(markup).toContain("Parnasse");
  });
});
