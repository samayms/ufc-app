import { describe, expect, it } from "vitest";
import weekendBouts from "../../src/fixtures/citoEventBoutsLive.json" with {
  type: "json",
};
import { buildLabCard } from "./server.ts";

describe("buildLabCard", () => {
  it("turns the captured weekend card into named fight choices", () => {
    const card = buildLabCard(weekendBouts);

    expect(card).toMatchObject({
      eventName: "UFC Fight Night: Medić vs. Rodriguez",
      eventDate: "2026-08-01",
      eventSlug: "ufc-fight-night-august-01-2026",
      pollIntervalMs: 5_000,
    });
    expect(card.fights).toHaveLength(14);
    expect(card.fights[0]).toEqual({
      id: "12879",
      espnBoutId: "401870843",
      cardSection: "Main Card",
      cardPosition: "Main Card 1",
      weightClass: "Welterweight",
      red: {
        name: "Uroš Medić",
        slug: "uros-medic",
        espnAthleteId: "4685870",
      },
      blue: {
        name: "Daniel Rodriguez",
        slug: "daniel-rodriguez",
        espnAthleteId: "4426312",
      },
    });
  });

  it("drops malformed fights instead of exposing incomplete options", () => {
    expect(
      buildLabCard({
        data: [
          { id: "complete", fighters: [
            { corner: "red", fighterName: "Red" },
            { corner: "blue", fighterName: "Blue" },
          ] },
          { id: "missing-blue", fighters: [
            { corner: "red", fighterName: "Red" },
          ] },
        ],
      }).fights,
    ).toEqual([
      {
        id: "complete",
        cardSection: "Card",
        cardPosition: "",
        weightClass: "Bout",
        red: { name: "Red" },
        blue: { name: "Blue" },
      },
    ]);
  });
});
