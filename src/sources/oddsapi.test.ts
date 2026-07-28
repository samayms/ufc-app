import eventFixture from "../fixtures/event.json";
import type { Bout, Corner, Fighter } from "../schema.ts";
import { describe, expect, it } from "vitest";
import { createOddsApiSource } from "./oddsapi.ts";

function getFixtureBout(boutId: string): Bout {
  const rawBout = eventFixture.bouts.find((bout) => bout.id === boutId);
  if (!rawBout) {
    throw new Error(`Missing fixture bout: ${boutId}`);
  }

  const fighters = Object.fromEntries(
    Object.entries(rawBout.fighterIds).map(([corner, fighterId]) => {
      const fighter = eventFixture.fighters.find(
        (candidate) => candidate.id === fighterId,
      );
      if (!fighter) {
        throw new Error(`Missing fixture fighter: ${fighterId}`);
      }

      return [corner, fighter];
    }),
  ) as Record<Corner, Fighter>;

  return {
    ...rawBout,
    fighters,
    provenance: eventFixture.event.provenance,
  } as Bout;
}

describe("createOddsApiSource", () => {
  const source = createOddsApiSource({ mode: "fixture" });

  it("returns moneyline quotes for both corners from multiple books", async () => {
    const snapshot = await source.getOddsSnapshot(getFixtureBout("bout-main"));

    expect(snapshot).not.toBeNull();
    expect(snapshot?.boutId).toBe("bout-main");
    expect(snapshot?.market).toBe("sportsbook");
    expect(snapshot?.provenance).toEqual({
      source: "odds-api",
      fetchedAt: "2026-07-26T02:40:28Z",
      synthetic: true,
    });

    const quotes = snapshot?.quotes ?? [];
    const books = new Set(
      quotes.map((quote) =>
        quote.native.kind === "american-moneyline"
          ? quote.native.book
          : "unexpected",
      ),
    );

    expect(books.size).toBeGreaterThan(1);
    for (const book of books) {
      expect(
        quotes
          .filter(
            (quote) =>
              quote.native.kind === "american-moneyline" &&
              quote.native.book === book,
          )
          .map((quote) => quote.corner)
          .sort(),
      ).toEqual(["blue", "red"]);
    }
  });

  it("converts each American moneyline to implied probability", async () => {
    const snapshot = await source.getOddsSnapshot(getFixtureBout("bout-main"));
    if (!snapshot) {
      throw new Error("Expected odds snapshot for bout-main");
    }

    for (const quote of snapshot.quotes) {
      if (quote.native.kind !== "american-moneyline") {
        throw new Error("Expected an American moneyline quote");
      }

      const moneyline = quote.native.moneyline;
      const expected =
        moneyline < 0
          ? -moneyline / (-moneyline + 100)
          : 100 / (moneyline + 100);

      expect(quote.impliedProbability).toBeCloseTo(expected, 4);
    }
  });

  it("returns null for a finished bout with no lines", async () => {
    await expect(
      source.getOddsSnapshot(getFixtureBout("bout-comain")),
    ).resolves.toBeNull();
  });
});
