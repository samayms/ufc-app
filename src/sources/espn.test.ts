import { describe, expect, it } from "vitest";
import type { Bout } from "../schema.ts";
import {
  buildEspnScoreboardUrl,
  createEspnSource,
  createLiveEspnLifecycleFetcher,
  parseEspnScoreboardLifecycle,
} from "./espn.ts";

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

describe("buildEspnScoreboardUrl", () => {
  it("builds a scoreboard URL scoped to the requested event", () => {
    const url = buildEspnScoreboardUrl("600051234");

    expect(url).toContain("event=600051234");
    expect(() => new URL(url)).not.toThrow();
  });

  it("rejects an empty event id", () => {
    expect(() => buildEspnScoreboardUrl("  ")).toThrow(/non-empty event id/);
  });
});

describe("parseEspnScoreboardLifecycle", () => {
  it("normalizes a realistic scoreboard payload into lifecycle entries", () => {
    const payload = {
      event: {
        header: {
          id: "600051234",
          competitions: [
            {
              id: "401770001",
              status: {
                period: 2,
                displayClock: "0:00",
                type: {
                  name: "STATUS_HALFTIME",
                  state: "in",
                  completed: false,
                },
              },
            },
            {
              id: "401770002",
              status: {
                period: 2,
                displayClock: "3:17",
                type: { name: "STATUS_FINAL", state: "post", completed: true },
              },
            },
            {
              id: "401770003",
              status: {
                period: 0,
                displayClock: "5:00",
                type: {
                  name: "STATUS_SCHEDULED",
                  state: "pre",
                  completed: false,
                },
              },
            },
          ],
        },
      },
    };

    expect(parseEspnScoreboardLifecycle(payload)).toEqual([
      {
        externalId: "401770001",
        state: "in",
        period: 2,
        completed: false,
        clockSeconds: 0,
      },
      {
        externalId: "401770002",
        state: "post",
        period: 2,
        completed: true,
        clockSeconds: 197,
      },
      {
        externalId: "401770003",
        state: "pre",
        period: 0,
        completed: false,
        clockSeconds: 300,
      },
    ]);
  });

  it("skips competitions without an id and omits an unparseable clock", () => {
    const payload = {
      event: {
        header: {
          competitions: [
            { status: { period: 1, type: { state: "in" } } },
            {
              id: "401770099",
              status: {
                period: 1,
                displayClock: "--",
                type: { state: "in" },
              },
            },
          ],
        },
      },
    };

    expect(parseEspnScoreboardLifecycle(payload)).toEqual([
      {
        externalId: "401770099",
        state: "in",
        period: 1,
        completed: false,
      },
    ]);
  });

  it("rejects a non-object payload", () => {
    expect(() => parseEspnScoreboardLifecycle(null)).toThrow(/JSON object/);
    expect(() => parseEspnScoreboardLifecycle("nope")).toThrow(/JSON object/);
  });

  it("returns an empty array when the payload has no competitions", () => {
    expect(parseEspnScoreboardLifecycle({})).toEqual([]);
  });
});

describe("createLiveEspnLifecycleFetcher", () => {
  it("fails closed outside of live mode", () => {
    expect(() =>
      createLiveEspnLifecycleFetcher({ mode: "fixture" }),
    ).toThrow(/DATA_MODE=live/);
  });

  it("constructs without requiring credentials in live mode", () => {
    expect(() =>
      createLiveEspnLifecycleFetcher({ mode: "live" }),
    ).not.toThrow();
  });
});
