import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSherdogRoundObservations, parserVersion } from "./sherdog.ts";

/**
 * A real Sherdog play-by-play page, captured 2026-07-29. It differs from the
 * hand-written fixture in three ways that matter: every bout on the card lives
 * on one page, commentary is bare text between headings rather than `<p>`
 * elements, and each round is scored by named writers on a `Sherdog Scores`
 * list.
 */
const livePage = readFileSync(
  fileURLToPath(new URL("../fixtures/sherdogLivePage.html", import.meta.url)),
  "utf8",
);

const sourceUrl =
  "https://www.sherdog.com/news/news/UFC-Oklahoma-City-Du-Plessis-vs-Usman-playbyplay-results-round-scoring-201960";
const fetchedAt = "2026-07-29T04:10:00Z";

function parse(fighters: { red: string; blue: string }, boutId = "bout-1") {
  return parseSherdogRoundObservations({
    boutId,
    html: livePage,
    sourceUrl,
    fetchedAt,
    fighterNames: fighters,
  });
}

describe("parseSherdogRoundObservations against a real live page", () => {
  it("returns only the rounds of the requested bout, not the whole card", async () => {
    const observations = await parse({
      red: "Alden Coria",
      blue: "Stewart Nicoll",
    });

    expect(observations.map((observation) => observation.round)).toEqual([
      1, 2, 3,
    ]);
  });

  it("reads commentary that is bare text between headings", async () => {
    const [round1] = await parse({
      red: "Alden Coria",
      blue: "Stewart Nicoll",
    });

    expect(round1?.commentary).toContain("Coria takes to the center of the Octagon");
    expect(round1?.commentary).not.toContain("<");
    expect(round1?.commentary.length).toBeGreaterThan(400);
  });

  it("excludes the scorer lines from the commentary prose", async () => {
    const [round1] = await parse({
      red: "Alden Coria",
      blue: "Stewart Nicoll",
    });

    expect(round1?.commentary).not.toContain("scores the round");
    expect(round1?.commentary).not.toContain("Sherdog Scores");
  });

  it("reads every named writer's card for a round", async () => {
    const [round1] = await parse({
      red: "Alden Coria",
      blue: "Stewart Nicoll",
    });

    expect(round1?.scorerCards).toEqual([
      { scorer: "Jay Pettry", winner: "Coria", roundScore: "10-9" },
      { scorer: "Ben Duffy", winner: "Coria", roundScore: "10-9" },
      { scorer: "Tyler Treese", winner: "Coria", roundScore: "10-9" },
    ]);
  });

  it("keeps each bout's rounds separate when round numbers repeat", async () => {
    const main = await parse(
      { red: "Dricus Du Plessis", blue: "Kamaru Usman" },
      "bout-main",
    );

    expect(main.map((observation) => observation.round)).toEqual([1, 2, 3, 4, 5]);
    expect(main.every((observation) => observation.boutId === "bout-main")).toBe(
      true,
    );
    expect(main[0]?.commentary).not.toContain("Coria");
  });

  it("keeps a multi-word surname whole in the scorer's winner", async () => {
    const main = await parse(
      { red: "Dricus Du Plessis", blue: "Kamaru Usman" },
      "bout-main",
    );

    expect(main[0]?.scorerCards).toEqual([
      { scorer: "Jay Pettry", winner: "Du Plessis", roundScore: "10-9" },
      { scorer: "Ben Duffy", winner: "Du Plessis", roundScore: "10-9" },
      { scorer: "Tyler Treese", winner: "Du Plessis", roundScore: "10-9" },
    ]);
  });

  it("reads a round the writers scored for different fighters", async () => {
    const main = await parse(
      { red: "Dricus Du Plessis", blue: "Kamaru Usman" },
      "bout-main",
    );

    expect(main[4]?.scorerCards.map((card) => card.winner)).toEqual([
      "Du Plessis",
      "Usman",
      "Usman",
    ]);
  });

  it("handles a bout that ended inside round 1 with no scorer cards", async () => {
    const observations = await parse({
      red: "Dione Barbosa",
      blue: "Anna Melisano",
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]?.round).toBe(1);
    expect(observations[0]?.scorerCards).toEqual([]);
    expect(observations[0]?.commentary.length).toBeGreaterThan(200);
  });

  it("does not leak the official result line into round commentary", async () => {
    const observations = await parse({
      red: "Dione Barbosa",
      blue: "Anna Melisano",
    });

    expect(observations[0]?.commentary).not.toContain("The Official Result");
    expect(observations[0]?.commentary).not.toContain("def.");
  });

  it("returns nothing for a bout that is not on the page", async () => {
    await expect(
      parse({ red: "Danilo Reyes", blue: "Artem Volkov" }),
    ).resolves.toEqual([]);
  });

  it("matches bouts on last name so weigh-in spellings do not break scoping", async () => {
    const observations = await parse({
      red: "Dricus du Plessis",
      blue: "Kamaru Usman",
    });

    expect(observations).toHaveLength(5);
  });

  it("stamps every observation with the parser version and a payload hash", async () => {
    const observations = await parse({
      red: "Alden Coria",
      blue: "Stewart Nicoll",
    });

    for (const observation of observations) {
      expect(observation.parserVersion).toBe(parserVersion);
      expect(observation.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      expect(observation.sourceUrl).toBe(sourceUrl);
      expect(observation.fetchedAt).toBe(fetchedAt);
    }
  });

  it("gives distinct hashes to distinct rounds of the same bout", async () => {
    const observations = await parse({
      red: "Alden Coria",
      blue: "Stewart Nicoll",
    });
    const hashes = new Set(
      observations.map((observation) => observation.payloadHash),
    );

    expect(hashes.size).toBe(observations.length);
  });
});
