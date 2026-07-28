import { describe, expect, it } from "vitest";

import eventFixture from "../fixtures/event.json";
import type { Bout } from "../schema.ts";
import { createPolymarketSource } from "./polymarket.ts";

function getFixtureBout(id: string): Bout {
  const bout = eventFixture.bouts.find((candidate) => candidate.id === id);

  if (!bout) {
    throw new Error(`Missing fixture bout: ${id}`);
  }

  return bout as unknown as Bout;
}

describe("createPolymarketSource", () => {
  const source = createPolymarketSource({ mode: "fixture" });

  it("returns both main-event corners at their token prices", async () => {
    const snapshot = await source.getOddsSnapshot(getFixtureBout("bout-main"));

    expect(snapshot).not.toBeNull();
    expect(snapshot?.market).toBe("polymarket");
    expect(snapshot?.quotes).toHaveLength(2);
    expect(snapshot?.quotes).toEqual([
      {
        corner: "red",
        native: { kind: "polymarket-price", price: 0.62 },
        impliedProbability: 0.62,
      },
      {
        corner: "blue",
        native: { kind: "polymarket-price", price: 0.39 },
        impliedProbability: 0.39,
      },
    ]);
    expect(
      snapshot?.quotes.every(
        ({ impliedProbability }) =>
          impliedProbability > 0 && impliedProbability < 1,
      ),
    ).toBe(true);
  });

  it("returns null for a finished bout without a market", async () => {
    await expect(
      source.getOddsSnapshot(getFixtureBout("bout-comain")),
    ).resolves.toBeNull();
  });

  it("keeps the Polymarket native price kind", async () => {
    const snapshot = await source.getOddsSnapshot(getFixtureBout("bout-main"));

    expect(
      snapshot?.quotes.every(
        ({ native }) => native.kind === "polymarket-price",
      ),
    ).toBe(true);
  });
});
