import { describe, expect, it, vi } from "vitest";
import scoreboardFixture from "../fixtures/espnScheduleScoreboard.json" with {
  type: "json",
};
import fightcenterFixture from "../fixtures/espnFightcenter.json" with {
  type: "json",
};
import {
  buildEspnAthleteUrl,
  buildEspnFightcenterUrl,
  buildEspnScheduleUrl,
  createEspnScheduleSource,
  parseEspnAthleteBio,
  parseEspnFightcenterCard,
  parseEspnRankings,
  parseEspnScheduleEvents,
} from "./espnSchedule.ts";

const ufc330Fixture = fightcenterFixture["600059185"];
const sparseFixture = fightcenterFixture["600060773"];

/** Minimal stand-in for a fetch Response: JSON body, no ReadableStream. */
function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    text: async () => "",
  } as unknown as Response;
}

describe("buildEspnScheduleUrl", () => {
  it("formats both dates as YYYYMMDD in UTC and sets limit=1000", () => {
    // Deliberately a UTC late-evening timestamp so a naive local-time
    // formatter would roll the date forward/back depending on TZ.
    const start = new Date("2026-07-28T23:30:00Z");
    const end = new Date("2026-08-01T00:15:00Z");

    const url = buildEspnScheduleUrl(start, end);

    expect(url).toContain("dates=20260728-20260801");
    expect(url).toContain("limit=1000");
    expect(() => new URL(url)).not.toThrow();
  });

  it("accepts the 365-day window that stays under ESPN's 366-day cap", () => {
    const start = new Date("2026-07-28T00:00:00Z");
    const end = new Date(start.getTime() + 365 * 24 * 60 * 60 * 1000);

    expect(() => buildEspnScheduleUrl(start, end)).not.toThrow();
    expect(buildEspnScheduleUrl(start, end)).toContain(
      "dates=20260728-20270728",
    );
  });

  it("throws a TypeError when end is before start", () => {
    const start = new Date("2026-07-28T00:00:00Z");
    const end = new Date("2026-07-27T23:59:59Z");

    expect(() => buildEspnScheduleUrl(start, end)).toThrow(TypeError);
    expect(() => buildEspnScheduleUrl(start, end)).toThrow(/end >= start/);
  });
});

describe("buildEspnFightcenterUrl", () => {
  it("builds a fightcenter URL scoped to the event id", () => {
    const url = buildEspnFightcenterUrl("600059185");

    expect(url).toBe(
      "https://site.web.api.espn.com/apis/common/v3/sports/mma/ufc/fightcenter/600059185",
    );
  });

  it("rejects an empty event id", () => {
    expect(() => buildEspnFightcenterUrl("  ")).toThrow(TypeError);
    expect(() => buildEspnFightcenterUrl("")).toThrow(/non-empty event id/);
  });
});

describe("buildEspnAthleteUrl", () => {
  it("builds an athlete bio URL scoped to the athlete id", () => {
    const url = buildEspnAthleteUrl("4738092");

    expect(url).toBe(
      "https://site.web.api.espn.com/apis/common/v3/sports/mma/ufc/athletes/4738092",
    );
  });

  it("rejects an empty athlete id", () => {
    expect(() => buildEspnAthleteUrl("  ")).toThrow(TypeError);
    expect(() => buildEspnAthleteUrl("")).toThrow(/non-empty athlete id/);
  });
});

// Regression guard for the shape captured live on 2026-07-28: the real
// scoreboard returns 18 events for the window 20260728-20261231, 10 of
// which are Dana White's Contender Series (must be excluded) and one of
// which is "Noche UFC" (a real UFC event that must survive the filter
// despite not containing the literal string "UFC").
describe("parseEspnScheduleEvents", () => {
  it("excludes all Contender Series events but keeps Noche UFC", () => {
    const now = new Date("2026-07-28T00:00:00Z");
    const events = parseEspnScheduleEvents(scoreboardFixture, now);

    expect(events).toHaveLength(8);
    expect(
      events.some((event) => /contender series/i.test(event.name)),
    ).toBe(false);
    expect(events.some((event) => event.name === "Noche UFC")).toBe(true);
  });

  it("keeps a recent completed card for review but drops it after the retention window", () => {
    const now = new Date("2026-08-20T00:00:00Z");
    const events = parseEspnScheduleEvents({
      events: [
        { id: "live", date: "2026-08-19T23:00:00Z", name: "UFC Live", status: { type: { name: "STATUS_IN_PROGRESS", completed: false } } },
        { id: "recent-final", date: "2026-08-19T18:00:00Z", name: "UFC Recent Final", status: { type: { name: "STATUS_FINAL", completed: true } } },
        { id: "old-final", date: "2026-08-18T05:00:00Z", name: "UFC Old Final", status: { type: { name: "STATUS_FINAL", completed: true } } },
        { id: "next", date: "2026-08-27T23:00:00Z", name: "UFC Next" },
      ],
    }, now);

    expect(events.map((event) => event.eventId)).toEqual([
      "recent-final",
      "live",
      "next",
    ]);
  });

  it("de-duplicates by event id", () => {
    const now = new Date("2026-07-28T00:00:00Z");
    const duplicated = {
      events: [
        ...(scoreboardFixture.events as unknown[]),
        scoreboardFixture.events[0],
      ],
    };

    const events = parseEspnScheduleEvents(duplicated, now);
    const ids = events.map((event) => event.eventId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sorts ascending by date", () => {
    const now = new Date("2026-07-28T00:00:00Z");
    const events = parseEspnScheduleEvents(scoreboardFixture, now);
    const times = events.map((event) => new Date(event.startsAt).getTime());

    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("returns an empty list rather than throwing on malformed input", () => {
    expect(parseEspnScheduleEvents(null, new Date())).toEqual([]);
    expect(parseEspnScheduleEvents({}, new Date())).toEqual([]);
    expect(parseEspnScheduleEvents({ cards: null }, new Date())).toEqual([]);
  });
});

// Regression guard for the shape captured live on 2026-07-28: UFC 330's
// fightcenter payload has three sections (main, prelims1, prelims2) with
// the main card's two title fights, and prelims1 carrying three distinct
// competition dates — an explicit case for the earliest-date-wins section
// timestamp rule.
describe("parseEspnFightcenterCard", () => {
  it("orders sections main-card, prelims, early-prelims", () => {
    const card = parseEspnFightcenterCard(ufc330Fixture, "600059185");

    expect(card).not.toBeNull();
    expect(card?.sections.map((section) => section.key)).toEqual([
      "main",
      "prelims1",
      "prelims2",
    ]);
    expect(card?.sections.map((section) => section.segment)).toEqual([
      "main-card",
      "prelims",
      "early-prelims",
    ]);
    expect(card?.sections.map((section) => section.displayName)).toEqual([
      "Main Card",
      "Prelims",
      "Early Prelims",
    ]);
  });

  it("keeps the main card's two fights with the main event first (regression guard)", () => {
    const card = parseEspnFightcenterCard(ufc330Fixture, "600059185");
    const mainSection = card?.sections[0];

    expect(mainSection?.fights).toHaveLength(2);
    expect(mainSection?.fights.map((fight) => fight.matchNumber)).toEqual([
      1, 2,
    ]);
    expect(mainSection?.fights[0]?.mainEvent).toBe(true);
    expect(mainSection?.fights[1]?.mainEvent).toBe(false);
    expect(mainSection?.fights[0]?.competitionId).toBe("401869336");
  });

  it("assigns corners with order === 2 as blue, otherwise red", () => {
    const card = parseEspnFightcenterCard(ufc330Fixture, "600059185");
    const mainEventFight = card?.sections[0]?.fights[0];

    expect(mainEventFight?.competitionId).toBe("401869336");
    expect(mainEventFight?.red.name).toBe("Islam Makhachev");
    expect(mainEventFight?.blue.name).toBe("Ian Machado Garry");
  });

  it("marks both main-card fights as title fights", () => {
    const card = parseEspnFightcenterCard(ufc330Fixture, "600059185");

    expect(card?.sections[0]?.fights.every((fight) => fight.titleFight)).toBe(
      true,
    );
  });

  it("uses the earliest competition date in a section as its startsAt", () => {
    const card = parseEspnFightcenterCard(ufc330Fixture, "600059185");

    expect(card?.sections[0]?.startsAt).toBe("2026-08-16T01:00:00.000+00:00");
    expect(card?.sections[1]?.startsAt).toBe("2026-08-15T21:00:00.000+00:00");
    expect(card?.sections[2]?.startsAt).toBe("2026-08-15T21:00:00.000+00:00");
  });

  it("handles a sparse event with null type and null note without throwing", () => {
    const card = parseEspnFightcenterCard(sparseFixture, "600060773");

    expect(card).not.toBeNull();
    const mainFight = card?.sections[0]?.fights[0];
    expect(mainFight?.competitionId).toBe("401897388");
    expect(mainFight?.weightClassLabel).toBeUndefined();
    expect(mainFight?.note).toBe("Main Event");

    const prelimsFight = card?.sections[1]?.fights[0];
    expect(prelimsFight?.competitionId).toBe("401897729");
    expect(prelimsFight?.weightClassLabel).toBeUndefined();
    expect(prelimsFight?.note).toBeUndefined();
  });

  it("returns null rather than throwing on malformed input", () => {
    expect(parseEspnFightcenterCard(null, "600059185")).toBeNull();
    expect(parseEspnFightcenterCard({}, "600059185")).toBeNull();
    expect(parseEspnFightcenterCard({ cards: null }, "600059185")).toBeNull();
  });

  // Regression guard for the shape captured live on 2026-07-28: fightcenter
  // competitors already carry age/displayHeight/displayReach/stance in the
  // same payload the card fetch already reads — no extra request needed for
  // these four fields. Ian Machado Garry's reach ("74.5\"") is deliberately
  // fractional, covering the non-integer-inches case.
  it("parses age/height/reach/stance directly off the fightcenter payload", () => {
    const card = parseEspnFightcenterCard(ufc330Fixture, "600059185");
    const mainEventFight = card?.sections[0]?.fights[0];

    expect(mainEventFight?.red.name).toBe("Islam Makhachev");
    expect(mainEventFight?.red.age).toBe(34);
    expect(mainEventFight?.red.stance).toBe("Southpaw");
    expect(mainEventFight?.red.heightCm).toBe(178); // 5'10"
    expect(mainEventFight?.red.reachCm).toBe(179); // 70.5"

    expect(mainEventFight?.blue.name).toBe("Ian Machado Garry");
    expect(mainEventFight?.blue.age).toBe(28);
    expect(mainEventFight?.blue.stance).toBe("Orthodox");
    expect(mainEventFight?.blue.heightCm).toBe(191); // 6'3"
    expect(mainEventFight?.blue.reachCm).toBe(189); // 74.5"
  });

  it("omits height/reach rather than throwing on an unparseable display string", () => {
    const malformed = {
      event: { id: "1", name: "Test Event" },
      cards: {
        main: {
          competitions: [
            {
              id: "c1",
              matchNumber: 1,
              competitors: [
                {
                  order: 1,
                  athlete: {
                    id: "a1",
                    displayName: "Fighter One",
                    displayHeight: "not a height",
                    displayReach: "not a reach",
                  },
                },
                { order: 2, athlete: { id: "a2", displayName: "Fighter Two" } },
              ],
            },
          ],
        },
      },
    };

    const card = parseEspnFightcenterCard(malformed, "1");
    const fight = card?.sections[0]?.fights[0];

    expect(fight?.red.heightCm).toBeUndefined();
    expect(fight?.red.reachCm).toBeUndefined();
  });

  // Regression guard: ScheduledCardRail must be able to show a live/final
  // status for a fight the user is already looking at instead of a stale
  // "upcoming" — verified straight off parseEspnFightcenterCard rather than
  // through the UI layer, since that's where ESPN's status/result shape
  // actually gets translated.
  it("parses a scheduled (not yet started) competition as status upcoming with no result", () => {
    const card = parseEspnFightcenterCard(ufc330Fixture, "600059185");
    const fight = card?.sections[0]?.fights[0];

    expect(fight?.status).toBe("upcoming");
    expect(fight?.currentRound).toBeUndefined();
    expect(fight?.result).toBeUndefined();
  });

  it("parses a live in-round competition's status and current round", () => {
    const live = {
      event: { id: "1", name: "Test Event" },
      cards: {
        main: {
          competitions: [
            {
              id: "c1",
              matchNumber: 1,
              status: { period: 2, type: { state: "in" } },
              competitors: [
                { order: 1, athlete: { id: "a1", displayName: "Fighter One" } },
                { order: 2, athlete: { id: "a2", displayName: "Fighter Two" } },
              ],
            },
          ],
        },
      },
    };

    const card = parseEspnFightcenterCard(live, "1");
    const fight = card?.sections[0]?.fights[0];

    expect(fight?.status).toBe("in-round");
    expect(fight?.currentRound).toBe(2);
    expect(fight?.result).toBeUndefined();
  });

  it("parses a completed competition's status and result, mapping the winning competitor to its corner", () => {
    const final = {
      event: { id: "1", name: "Test Event" },
      cards: {
        main: {
          competitions: [
            {
              id: "c1",
              matchNumber: 1,
              status: {
                period: 3,
                displayClock: "2:14",
                type: { state: "post", completed: true },
                result: { name: "submission", displayName: "Submission" },
              },
              competitors: [
                { order: 1, athlete: { id: "a1", displayName: "Fighter One" } },
                {
                  order: 2,
                  winner: true,
                  athlete: { id: "a2", displayName: "Fighter Two" },
                },
              ],
            },
          ],
        },
      },
    };

    const card = parseEspnFightcenterCard(final, "1");
    const fight = card?.sections[0]?.fights[0];

    expect(fight?.status).toBe("final");
    expect(fight?.currentRound).toBeUndefined();
    expect(fight?.result).toEqual({
      winner: "blue",
      method: "submission",
      round: 3,
      time: "2:14",
    });
  });

  it("treats a draw (no winning competitor) as a draw result rather than throwing", () => {
    const final = {
      event: { id: "1", name: "Test Event" },
      cards: {
        main: {
          competitions: [
            {
              id: "c1",
              matchNumber: 1,
              status: { type: { completed: true } },
              result: { method: { name: "decision---majority" } },
              competitors: [
                { order: 1, athlete: { id: "a1", displayName: "Fighter One" } },
                { order: 2, athlete: { id: "a2", displayName: "Fighter Two" } },
              ],
            },
          ],
        },
      },
    };

    const card = parseEspnFightcenterCard(final, "1");
    const fight = card?.sections[0]?.fights[0];

    expect(fight?.result?.winner).toBe("draw");
    expect(fight?.result?.method).toBe("decision-majority");
  });
});

// Regression guard for the shape captured live on 2026-07-28 from
// site.web.api.espn.com/.../ufc/athletes/{id}: `eventsMap` entries are
// keyed by event uid and already newest-first by insertion order.
describe("parseEspnAthleteBio", () => {
  const realisticPayload = {
    athlete: { id: "4426312", nickname: "D-Rod" },
    eventsMap: {
      "s:3301~l:3321~e:600053891~c:401799529": {
        name: "UFC 318: Holloway vs. Poirier 3",
        gameDate: "2025-07-19T22:00:00.000+00:00",
        gameResult: "W",
        status: {
          period: 3,
          result: { name: "decision---unanimous", displayName: "Decision - Unanimous" },
        },
        opponent: { displayName: "Kevin Holland" },
      },
      "s:3301~l:3321~e:600053455~c:401763453": {
        name: "UFC on ESPN: Some Event",
        gameDate: "2025-01-01T22:00:00.000+00:00",
        gameResult: "L",
        status: {
          period: 1,
          result: { name: "kotko", displayName: "KO/TKO" },
        },
        opponent: { displayName: "Some Opponent" },
      },
    },
  };

  it("extracts nickname and recent bouts, newest-first, from a realistic payload", () => {
    const bio = parseEspnAthleteBio(realisticPayload, "4426312");

    expect(bio.nickname).toBe("D-Rod");
    expect(bio.recentBouts).toEqual([
      {
        opponentName: "Kevin Holland",
        result: "win",
        method: "decision-unanimous",
        round: 3,
        date: "2025-07-19T22:00:00.000+00:00",
        eventName: "UFC 318: Holloway vs. Poirier 3",
      },
      {
        opponentName: "Some Opponent",
        result: "loss",
        method: "ko-tko",
        round: 1,
        date: "2025-01-01T22:00:00.000+00:00",
        eventName: "UFC on ESPN: Some Event",
      },
    ]);
  });

  it("caps recent bouts at 5", () => {
    const eventsMap: Record<string, unknown> = {};
    for (let i = 0; i < 8; i++) {
      eventsMap[`event-${i}`] = {
        name: `Event ${i}`,
        gameResult: "W",
        opponent: { displayName: `Opponent ${i}` },
      };
    }

    const bio = parseEspnAthleteBio({ eventsMap }, "any-id");

    expect(bio.recentBouts).toHaveLength(5);
  });

  it("drops entries with no opponent name or unrecognized game result, without throwing", () => {
    const bio = parseEspnAthleteBio(
      {
        eventsMap: {
          noOpponent: { gameResult: "W" },
          badResult: { gameResult: "X", opponent: { displayName: "Someone" } },
          valid: { gameResult: "D", opponent: { displayName: "Someone Else" } },
        },
      },
      "any-id",
    );

    expect(bio.recentBouts).toEqual([
      {
        opponentName: "Someone Else",
        result: "draw",
        method: "other",
      },
    ]);
  });

  it("returns no bio when the payload's own athlete id disagrees with the requested id", () => {
    const bio = parseEspnAthleteBio(
      { athlete: { id: "wrong-id", nickname: "Nope" }, eventsMap: {} },
      "requested-id",
    );

    expect(bio).toEqual({ recentBouts: [] });
  });

  it("returns an empty result rather than throwing on malformed input", () => {
    expect(parseEspnAthleteBio(null, "any-id")).toEqual({ recentBouts: [] });
    expect(parseEspnAthleteBio({}, "any-id")).toEqual({ recentBouts: [] });
    expect(parseEspnAthleteBio({ eventsMap: null }, "any-id")).toEqual({
      recentBouts: [],
    });
    expect(parseEspnAthleteBio({ eventsMap: "not an object" }, "any-id")).toEqual({
      recentBouts: [],
    });
  });
});

describe("parseEspnRankings", () => {
  // Trimmed but field-shaped like the live payload captured 2026-07-28:
  // pound-for-pound groups carry no weightClass (skipped), a division's
  // champion group (type ending "-champions") is listed ahead of its
  // numbered-contenders group (bare type), each with a weightClass.text.
  const realisticPayload = {
    rankings: [
      {
        id: "1",
        name: "Men's Pound for Pound Rankings",
        type: "pound-for-pound",
        ranks: [{ current: 1, athlete: { id: "3088812" }, recordSummary: "21-5-0" }],
      },
      {
        id: "6",
        name: "Welterweight Division Champions (Up to 170 pounds)",
        type: "welterweight-champions",
        weightClass: { id: "969", text: "Welterweight", shortName: "Welterweight", slug: "welterweight" },
        ranks: [{ current: 1, athlete: { id: "4083730" }, recordSummary: "17-3-0" }],
      },
      {
        id: "16",
        name: "Welterweight Division Rankings (Up to 170 pounds)",
        type: "welterweight",
        weightClass: { id: "969", text: "Welterweight", shortName: "Welterweight", slug: "welterweight" },
        ranks: [
          { current: 1, athlete: { id: "4361398" }, recordSummary: "20-4-0" },
          { current: 2, athlete: { id: "3948124" }, recordSummary: "18-6-0" },
        ],
      },
    ],
  };

  it("prefers a divisional champion/rank over pound-for-pound, formatted short", () => {
    const rankings = parseEspnRankings(realisticPayload);

    expect(rankings.get("4083730")).toBe("Welterweight Champion");
    expect(rankings.get("4361398")).toBe("#1 Welterweight");
    expect(rankings.get("3948124")).toBe("#2 Welterweight");
    // Pound-for-pound-only athlete never gets an entry: no weightClass group
    // ever mentions them in this payload.
    expect(rankings.get("3088812")).toBeUndefined();
    expect(rankings.size).toBe(3);
  });

  it("prefers the first group an athlete appears in (champion group listed before the numbered group)", () => {
    const rankings = parseEspnRankings({
      rankings: [
        {
          type: "welterweight-champions",
          weightClass: { text: "Welterweight" },
          ranks: [{ current: 1, athlete: { id: "same-id" } }],
        },
        {
          type: "welterweight",
          weightClass: { text: "Welterweight" },
          ranks: [{ current: 1, athlete: { id: "same-id" } }],
        },
      ],
    });

    expect(rankings.get("same-id")).toBe("Welterweight Champion");
  });

  it("derives contender rank from position, not ESPN's raw current field, when a division's numbered list redundantly includes its own champion", () => {
    // Mirrors the real live payload (verified 2026-07-28): the numbered
    // group redundantly lists the champion (usually at current: 1) ahead of
    // the actual numbered contenders, so `current` itself is off by one for
    // every real contender.
    const rankings = parseEspnRankings({
      rankings: [
        {
          type: "welterweight-champions",
          weightClass: { text: "Welterweight" },
          ranks: [{ current: 1, athlete: { id: "champ-id" } }],
        },
        {
          type: "welterweight",
          weightClass: { text: "Welterweight" },
          ranks: [
            { current: 1, athlete: { id: "champ-id" } }, // duplicate of the champion
            { current: 2, athlete: { id: "contender-1" } },
            { current: 3, athlete: { id: "contender-2" } },
          ],
        },
      ],
    });

    expect(rankings.get("champ-id")).toBe("Welterweight Champion");
    expect(rankings.get("contender-1")).toBe("#1 Welterweight");
    expect(rankings.get("contender-2")).toBe("#2 Welterweight");
  });

  it("skips groups with no weightClass, entries with no athlete id, and numbered entries with no current rank", () => {
    const rankings = parseEspnRankings({
      rankings: [
        { type: "pound-for-pound", ranks: [{ current: 1, athlete: { id: "no-weightclass" } }] },
        {
          type: "flyweight",
          weightClass: { text: "Flyweight" },
          ranks: [
            { current: 1 },
            { athlete: { id: "no-current" } },
            { current: 3, athlete: {} },
          ],
        },
      ],
    });

    expect(rankings.size).toBe(0);
  });

  it("returns an empty map rather than throwing on malformed input", () => {
    expect(parseEspnRankings(null).size).toBe(0);
    expect(parseEspnRankings(undefined).size).toBe(0);
    expect(parseEspnRankings("not an object").size).toBe(0);
    expect(parseEspnRankings({}).size).toBe(0);
    expect(parseEspnRankings({ rankings: "not an array" }).size).toBe(0);
    expect(parseEspnRankings({ rankings: [null, "bad", 42] }).size).toBe(0);
    expect(
      parseEspnRankings({
        rankings: [{ type: "flyweight", weightClass: { text: "Flyweight" }, ranks: "not an array" }],
      }).size,
    ).toBe(0);
  });
});

describe("createEspnScheduleSource", () => {
  it("caches listUpcomingEvents within the TTL and shares in-flight requests", async () => {
    let currentTime = new Date("2026-07-28T00:00:00Z");
    const fetchImpl = vi.fn(async () => jsonResponse(scoreboardFixture));
    const source = createEspnScheduleSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => currentTime,
      ttlMs: 60_000,
    });

    const [first, second] = await Promise.all([
      source.listUpcomingEvents(),
      source.listUpcomingEvents(),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);

    await source.listUpcomingEvents();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    currentTime = new Date(currentTime.getTime() + 61_000);
    await source.listUpcomingEvents();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("requests a one-day lookback within ESPN's inclusive 366-day cap", async () => {
    const currentTime = new Date("2026-07-28T00:00:00Z");
    const fetchImpl = vi.fn(async () => jsonResponse(scoreboardFixture));
    const source = createEspnScheduleSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => currentTime,
    });

    await source.listUpcomingEvents();

    const expectedUrl = buildEspnScheduleUrl(
      new Date(currentTime.getTime() - 24 * 60 * 60 * 1_000),
      new Date(currentTime.getTime() + 364 * 24 * 60 * 60 * 1000),
    );
    expect(fetchImpl).toHaveBeenCalledWith(expectedUrl, expect.anything());
  });

  it("never caches a failed schedule fetch", async () => {
    let shouldFail = true;
    const fetchImpl = vi.fn(async () => {
      if (shouldFail) {
        shouldFail = false;
        return errorResponse(500);
      }
      return jsonResponse(scoreboardFixture);
    });
    const source = createEspnScheduleSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date("2026-07-28T00:00:00Z"),
    });

    await expect(source.listUpcomingEvents()).rejects.toThrow(
      /Failed to load the ESPN UFC schedule/,
    );
    const retried = await source.listUpcomingEvents();
    expect(retried.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // ufc330Fixture and sparseFixture carry 18 and 2 unique athlete ids
  // respectively (disjoint sets), each triggering its own athlete-bio fetch
  // once getCard enriches the card — counted separately from the single
  // fightcenter fetch below so this test doesn't hardcode an opaque total.
  function cardFetchCount(fetchImpl: ReturnType<typeof vi.fn>): number {
    return fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes("/fightcenter/"),
    ).length;
  }
  function bioFetchCount(fetchImpl: ReturnType<typeof vi.fn>): number {
    return fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes("/athletes/"),
    ).length;
  }

  it("caches getCard per event id and shares in-flight requests, deduping per-athlete bio fetches", async () => {
    let currentTime = new Date("2026-07-28T00:00:00Z");
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/athletes/")) return jsonResponse({});
      const eventId = url.split("/").pop();
      return jsonResponse(
        eventId === "600059185" ? ufc330Fixture : sparseFixture,
      );
    });
    const source = createEspnScheduleSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => currentTime,
      ttlMs: 60_000,
    });

    const [first, second] = await Promise.all([
      source.getCard("600059185"),
      source.getCard("600059185"),
    ]);
    expect(cardFetchCount(fetchImpl)).toBe(1);
    expect(bioFetchCount(fetchImpl)).toBe(18);
    expect(first).toEqual(second);

    await source.getCard("600060773");
    expect(cardFetchCount(fetchImpl)).toBe(2);
    expect(bioFetchCount(fetchImpl)).toBe(20); // +2 unique athletes from the sparse fixture

    currentTime = new Date(currentTime.getTime() + 61_000);
    await source.getCard("600059185");
    expect(cardFetchCount(fetchImpl)).toBe(3);
    expect(bioFetchCount(fetchImpl)).toBe(38); // both caches expire after the TTL — all 18 re-fetched
  });

  it("never caches a failed card fetch", async () => {
    let shouldFail = true;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/athletes/")) return jsonResponse({});
      if (shouldFail) {
        shouldFail = false;
        return errorResponse(404);
      }
      return jsonResponse(ufc330Fixture);
    });
    const source = createEspnScheduleSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date("2026-07-28T00:00:00Z"),
    });

    await expect(source.getCard("600059185")).rejects.toThrow(
      /Failed to load the ESPN fight card for event 600059185/,
    );
    const retried = await source.getCard("600059185");
    expect(retried?.eventId).toBe("600059185");
    // The failed first attempt never reaches enrichment, so only the
    // successful retry's card fetch + its 18 athlete-bio fetches count.
    expect(cardFetchCount(fetchImpl)).toBe(2);
    expect(bioFetchCount(fetchImpl)).toBe(18);
  });

  it("merges nickname and recent-bout history from the athlete-bio endpoint onto getCard's fighters", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/athletes/4738092")) {
        return jsonResponse({
          athlete: { id: "4738092", nickname: "The Future" },
          eventsMap: {
            e1: {
              name: "UFC Fight Night",
              gameResult: "W",
              opponent: { displayName: "Some Opponent" },
              status: { period: 2, result: { name: "submission" } },
            },
          },
        });
      }
      if (url.includes("/athletes/")) return jsonResponse({});
      return jsonResponse(ufc330Fixture);
    });
    const source = createEspnScheduleSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date("2026-07-28T00:00:00Z"),
    });

    const card = await source.getCard("600059185");
    const garry = card?.sections[0]?.fights[0]?.blue;

    expect(garry?.name).toBe("Ian Machado Garry");
    expect(garry?.nickname).toBe("The Future");
    expect(garry?.recentBouts).toEqual([
      {
        opponentName: "Some Opponent",
        result: "win",
        method: "submission",
        round: 2,
        eventName: "UFC Fight Night",
      },
    ]);
  });

  it("prefers the official-UFC overlay over ESPN's stale rankings endpoint", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/rankings")) {
        return jsonResponse({
          rankings: [
            {
              type: "lightweight-champions",
              weightClass: { text: "Lightweight" },
              ranks: [{ current: 1, athlete: { id: "3332412" } }],
            },
          ],
        });
      }
      if (url.includes("/athletes/")) return jsonResponse({});
      return jsonResponse(ufc330Fixture);
    });
    const source = createEspnScheduleSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date("2026-07-28T00:00:00Z"),
    });

    const card = await source.getCard("600059185");
    const makhachev = card?.sections[0]?.fights[0]?.red;
    const garry = card?.sections[0]?.fights[0]?.blue;

    expect(makhachev?.name).toBe("Islam Makhachev");
    // ESPN's endpoint says lightweight champion here — and ESPN's real
    // endpoint is years out of date in exactly this way. The checked-in
    // official overlay wins.
    expect(makhachev?.ranking).toBe("Welterweight Champion");
    expect(garry?.ranking).toBe("#1 Welterweight");
  });

  it("falls back to ESPN for a fighter the official overlay does not name", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/rankings")) {
        return jsonResponse({
          rankings: [
            {
              type: "middleweight",
              weightClass: { text: "Middleweight" },
              // Dustin Stoltzfus is not on the official rankings page.
              ranks: [{ current: 1, athlete: { id: "4685871" } }],
            },
          ],
        });
      }
      if (url.includes("/athletes/")) return jsonResponse({});
      return jsonResponse(ufc330Fixture);
    });
    const source = createEspnScheduleSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date("2026-07-28T00:00:00Z"),
    });

    const card = await source.getCard("600059185");
    const ranked = card?.sections
      .flatMap((section) => section.fights)
      .flatMap((fight) => [fight.red, fight.blue])
      .find((fighter) => fighter.athleteId === "4685871");

    expect(ranked?.ranking).toBe("#1 Middleweight");
  });

  it("keeps the card intact when the rankings fetch fails, without failing or blocking card loading", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/rankings")) return errorResponse(500);
      if (url.includes("/athletes/")) return jsonResponse({});
      return jsonResponse(ufc330Fixture);
    });
    const source = createEspnScheduleSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date("2026-07-28T00:00:00Z"),
    });

    const card = await source.getCard("600059185");
    const garry = card?.sections[0]?.fights[0]?.blue;

    expect(garry?.name).toBe("Ian Machado Garry");
    // The ESPN fallback is gone, but the checked-in overlay needs no network
    // and still supplies the badge.
    expect(garry?.ranking).toBe("#1 Welterweight");
  });

  it("caches the rankings lookup across multiple getCard calls (single-entry, independent of the per-event card cache)", async () => {
    let currentTime = new Date("2026-07-28T00:00:00Z");
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/rankings")) {
        return jsonResponse({
          rankings: [
            {
              type: "lightweight-champions",
              weightClass: { text: "Lightweight" },
              ranks: [{ current: 1, athlete: { id: "3332412" } }],
            },
          ],
        });
      }
      if (url.includes("/athletes/")) return jsonResponse({});
      const eventId = url.split("/").pop();
      return jsonResponse(eventId === "600059185" ? ufc330Fixture : sparseFixture);
    });
    const source = createEspnScheduleSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => currentTime,
      ttlMs: 60_000,
    });

    function rankingsFetchCount(): number {
      return fetchImpl.mock.calls.filter(([url]) => String(url).includes("/rankings")).length;
    }

    await source.getCard("600059185");
    expect(rankingsFetchCount()).toBe(1);

    // A second event's card, well within the short card ttlMs, still reuses
    // the single cached rankings lookup rather than re-fetching it.
    await source.getCard("600060773");
    expect(rankingsFetchCount()).toBe(1);

    // Even once the (short) card cache has expired, the (much longer)
    // rankings cache is still live.
    currentTime = new Date(currentTime.getTime() + 61_000);
    await source.getCard("600059185");
    expect(rankingsFetchCount()).toBe(1);
  });

  it("keeps the rest of a fighter's data when their bio fetch fails, without failing the whole card", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/athletes/")) return errorResponse(500);
      return jsonResponse(ufc330Fixture);
    });
    const source = createEspnScheduleSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date("2026-07-28T00:00:00Z"),
    });

    const card = await source.getCard("600059185");
    const garry = card?.sections[0]?.fights[0]?.blue;

    expect(garry?.name).toBe("Ian Machado Garry");
    expect(garry?.age).toBe(28); // still parsed straight off the fightcenter payload
    expect(garry?.nickname).toBeUndefined();
    expect(garry?.recentBouts).toBeUndefined();
  });

  // Regression guard: the default fetch implementation must keep its
  // receiver — an unbound `fetch` reference throws "Illegal invocation" in
  // browsers (hit live on 2026-07-28).
  it("keeps fetch's receiver when no fetchImpl is provided", async () => {
    const originalFetch = globalThis.fetch;

    function receiverSensitiveFetch(
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(jsonResponse(scoreboardFixture));
    }
    globalThis.fetch = receiverSensitiveFetch as unknown as typeof fetch;

    try {
      const source = createEspnScheduleSource({
        now: () => new Date("2026-07-28T00:00:00Z"),
      });

      await expect(source.listUpcomingEvents()).resolves.not.toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
