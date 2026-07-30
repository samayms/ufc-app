import { describe, expect, it } from "vitest";
import type { Bout, SherdogRoundObservation } from "../src/schema.ts";
import type { ParsedExpertScore } from "../src/sources/x.ts";
import { loadFixtureEvent } from "../src/store/fixtureEvent.ts";
import { computeExpertConsensus } from "./expertConsensus.ts";

const bout = loadFixtureEvent().bouts.find(
  (candidate) => candidate.id === "bout-main",
)!;

describe("computeExpertConsensus", () => {
  it("keeps Sherdog cards and X scores in separate labeled values", () => {
    const sherdog: SherdogRoundObservation = {
      boutId: bout.id,
      round: 1,
      commentary: "Plain text",
      scorerCards: [
        { scorer: "Sherdog", winner: "Reyes", roundScore: "10-9" },
        { scorer: "Guest", winner: "Volkov", roundScore: "10-9" },
      ],
      sourceUrl: "https://www.sherdog.com/news/fixture",
      fetchedAt: "2026-07-28T00:00:10Z",
      parserVersion: "test",
      payloadHash: "hash",
    };
    const xScores: ParsedExpertScore[] = [
      {
        source: "x",
        sourcePostId: "1",
        scorer: "MMAJunkie",
        round: 1,
        score: { red: 10, blue: 9 },
        fetchedAt: "2026-07-28T00:00:40Z",
        parseConfidence: 1,
        mode: "manual",
        postUrl: "https://x.com/MMAJunkie/status/1",
      },
      {
        source: "x",
        sourcePostId: "2",
        scorer: "KevinI",
        round: 1,
        score: { red: 10, blue: 9 },
        fetchedAt: "2026-07-28T00:00:40Z",
        parseConfidence: 1,
        mode: "manual",
        postUrl: "https://x.com/KevinI/status/2",
      },
    ];

    expect(computeExpertConsensus(bout, sherdog, xScores)).toEqual({
      sherdog: {
        source: "sherdog",
        redVotes: 1,
        blueVotes: 1,
        drawVotes: 0,
        total: 2,
      },
      x: {
        source: "x",
        redVotes: 2,
        blueVotes: 0,
        drawVotes: 0,
        total: 2,
        leader: "red",
      },
    });
  });

  it("resolves a card won on a multi-word surname", () => {
    const duPlessis: Bout = {
      ...bout,
      fighters: {
        red: { ...bout.fighters.red, name: "Dricus Du Plessis" },
        blue: { ...bout.fighters.blue, name: "Kamaru Usman" },
      },
    };
    const sherdog: SherdogRoundObservation = {
      boutId: duPlessis.id,
      round: 1,
      commentary: "Plain text",
      scorerCards: [
        { scorer: "Jay Pettry", winner: "Du Plessis", roundScore: "10-9" },
        { scorer: "Ben Duffy", winner: "Du Plessis", roundScore: "10-9" },
        { scorer: "Tyler Treese", winner: "Usman", roundScore: "10-9" },
      ],
      sourceUrl: "https://www.sherdog.com/news/fixture",
      fetchedAt: "2026-07-28T00:00:10Z",
      parserVersion: "test",
      payloadHash: "hash",
    };

    expect(computeExpertConsensus(duPlessis, sherdog, [])?.sherdog).toEqual({
      source: "sherdog",
      redVotes: 2,
      blueVotes: 1,
      drawVotes: 0,
      total: 3,
      leader: "red",
    });
  });

  it("does not resolve a corner from an ambiguous name fragment", () => {
    const duPlessis: Bout = {
      ...bout,
      fighters: {
        red: { ...bout.fighters.red, name: "Dricus Du Plessis" },
        blue: { ...bout.fighters.blue, name: "Kamaru Usman" },
      },
    };
    const sherdog: SherdogRoundObservation = {
      boutId: duPlessis.id,
      round: 1,
      commentary: "Plain text",
      scorerCards: [{ scorer: "Jay Pettry", winner: "Du", roundScore: "10-9" }],
      sourceUrl: "https://www.sherdog.com/news/fixture",
      fetchedAt: "2026-07-28T00:00:10Z",
      parserVersion: "test",
      payloadHash: "hash",
    };

    expect(
      computeExpertConsensus(duPlessis, sherdog, [])?.sherdog,
    ).toBeUndefined();
  });
});
