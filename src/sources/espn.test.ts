import { describe, expect, it } from "vitest";
import type { Bout } from "../schema.ts";
import { createEspnSource } from "./espn.ts";

const espn = createEspnSource({ mode: "fixture" });

describe("createEspnSource", () => {
  it("normalizes the fixture event, bout statuses, and results", async () => {
    const event = await espn.getEvent({ source: "espn", id: "600051234" });

    expect(event).not.toBeNull();
    expect(event?.id).toBe("evt-fixture-001");
    expect(event?.bouts).toHaveLength(5);
    expect(event?.bouts.map((bout) => bout.status)).toEqual([
      "between-rounds",
      "final",
      "upcoming",
      "upcoming",
      "final",
    ]);
    expect(event?.bouts[0]).toMatchObject({
      id: "bout-main",
      currentRound: 2,
    });
    expect(event?.bouts[1]?.result).toEqual({
      winner: "blue",
      method: "submission",
      round: 2,
      time: "3:17",
    });
    expect(event?.bouts[4]?.result).toEqual({
      winner: "red",
      method: "ko-tko",
      round: 1,
      time: "0:48",
    });
    expect(event?.provenance).toEqual({
      source: "espn",
      fetchedAt: "2026-07-26T02:41:00Z",
      synthetic: true,
    });
  });

  it("returns the main event's completed rounds in order", async () => {
    const event = await espn.getEvent({ source: "espn", id: "600051234" });
    const mainEvent = event?.bouts[0];

    expect(mainEvent).toBeDefined();
    const updates = await espn.getRoundUpdates(mainEvent as Bout);

    expect(updates.map((update) => update.round)).toEqual([1, 2]);
    expect(updates.every((update) => update.boutId === "bout-main")).toBe(true);
    expect(updates.every((update) => update.summary)).toBe(true);
    expect(updates.every((update) => update.stats === undefined)).toBe(true);
  });

  it("normalizes fighter records and profile fields", async () => {
    const fighter = await espn.getFighter({
      source: "espn",
      id: "5088801",
    });

    expect(fighter).toMatchObject({
      id: "ftr-reyes",
      name: "Danilo Reyes",
      nickname: "El Rayo",
      record: {
        wins: 17,
        losses: 3,
        draws: 0,
        noContests: 0,
      },
      stance: "southpaw",
      heightCm: 178,
      reachCm: 183,
      age: 29,
      country: "Mexico",
    });
    expect(fighter?.recentBouts).toHaveLength(3);
    expect(fighter?.provenance.source).toBe("espn");
    expect(fighter?.provenance.synthetic).toBe(true);
  });

  it("returns null or an empty list for unknown references", async () => {
    await expect(
      espn.getEvent({ source: "espn", id: "unknown-event" }),
    ).resolves.toBeNull();
    await expect(
      espn.getEvent({ source: "cito", id: "600051234" }),
    ).resolves.toBeNull();
    await expect(
      espn.getFighter({ source: "espn", id: "unknown-fighter" }),
    ).resolves.toBeNull();
    await expect(
      espn.getRoundUpdates({
        id: "unknown-bout",
        externalRefs: [{ source: "espn", id: "unknown-bout" }],
      } as Bout),
    ).resolves.toEqual([]);
    await expect(
      espn.getRoundUpdates({
        id: "bout-without-espn",
        externalRefs: [],
      } as unknown as Bout),
    ).resolves.toEqual([]);
  });
});
