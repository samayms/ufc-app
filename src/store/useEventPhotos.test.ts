import { describe, expect, it } from "vitest";

import { cardHeadshotsByBoutId } from "./useEventPhotos.ts";

describe("cardHeadshotsByBoutId", () => {
  it("keeps only ESPN-provided headshots keyed by competition id", () => {
    expect(cardHeadshotsByBoutId({
      eventId: "event", name: "Card", sections: [{ key: "main", displayName: "Main", fights: [{
        competitionId: "bout", titleFight: false, mainEvent: true, status: "final",
        red: { name: "Red", headshotUrl: "https://a.espncdn.com/red.png" },
        blue: { name: "Blue" },
      }] }],
    })).toEqual({ bout: { red: "https://a.espncdn.com/red.png" } });
  });
});
