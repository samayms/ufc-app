import { describe, expect, it } from "vitest";

import canonicalFixture from "../fixtures/event.json";
import {
  createCitoSource,
  createFixtureCitoRoundStatsFetcher,
  createLiveCitoRoundStatsFetcher,
} from "./cito.ts";

describe("createCitoSource", () => {
  it("returns the fixture event with five bouts", async () => {
    const source = createCitoSource({ mode: "fixture" });

    const event = await source.getEvent({
      source: "cito",
      id: "ufc-fixture-night",
    });

    expect(event).not.toBeNull();
    expect(event?.id).toBe("evt-fixture-001");
    expect(event?.bouts).toHaveLength(5);
    expect(event?.provenance).toMatchObject({
      source: "cito",
      synthetic: true,
    });
  });

  it("returns two ordered main-event rounds with stats for both corners", async () => {
    const source = createCitoSource({ mode: "fixture" });
    const event = await source.getEvent({
      source: "cito",
      id: "ufc-fixture-night",
    });
    const mainEvent = event?.bouts.find(({ id }) => id === "bout-main");

    expect(mainEvent).toBeDefined();
    if (mainEvent === undefined) {
      return;
    }

    const rounds = await source.getRoundUpdates(mainEvent);

    expect(rounds.map(({ round }) => round)).toEqual([1, 2]);
    for (const round of rounds) {
      for (const corner of ["red", "blue"] as const) {
        expect(round.stats?.[corner]?.controlTimeSeconds).toEqual(
          expect.any(Number),
        );
        expect(round.stats?.[corner]?.significantStrikes).toEqual(
          expect.any(Number),
        );
      }
    }
  });

  it("returns a fighter record matching the canonical event fixture", async () => {
    const source = createCitoSource({ mode: "fixture" });
    const event = await source.getEvent({
      source: "cito",
      id: "ufc-fixture-night",
    });
    const citoRef = event?.bouts[0]?.fighters.red.externalRefs.find(
      ({ source: refSource }) => refSource === "cito",
    );
    const expected = canonicalFixture.fighters.find(
      ({ id }) => id === "ftr-reyes",
    );

    expect(citoRef).toBeDefined();
    expect(expected).toBeDefined();
    if (citoRef === undefined) {
      return;
    }

    const fighter = await source.getFighter(citoRef);

    expect(fighter?.id).toBe("ftr-reyes");
    expect(fighter?.record).toEqual(expected?.record);
  });

  it("returns null or an empty list for unknown references", async () => {
    const source = createCitoSource({ mode: "fixture" });
    const event = await source.getEvent({
      source: "cito",
      id: "ufc-fixture-night",
    });
    const mainEvent = event?.bouts[0];

    expect(
      await source.getEvent({ source: "cito", id: "unknown-event" }),
    ).toBeNull();
    expect(
      await source.getFighter({ source: "cito", id: "unknown-fighter" }),
    ).toBeNull();
    expect(mainEvent).toBeDefined();
    if (mainEvent === undefined) {
      return;
    }

    expect(
      await source.getRoundUpdates({
        ...mainEvent,
        externalRefs: [{ source: "cito", id: "unknown-bout" }],
      }),
    ).toEqual([]);
  });

  it("rejects live mode at the factory boundary", () => {
    expect(() => createCitoSource({ mode: "live" })).toThrow(
      "cito live mode not available yet",
    );
  });

  it("provides exact fixture-backed round fetches for the collector pipeline", async () => {
    const fetcher = createFixtureCitoRoundStatsFetcher();

    await expect(fetcher.fetchRound("bout-main", 1)).resolves.toMatchObject({
      boutId: "bout-main",
      round: 1,
      fighterA: {
        significantStrikes: 24,
        controlTimeSeconds: 72,
      },
      fighterB: {
        significantStrikes: 19,
        controlTimeSeconds: 18,
      },
    });
    await expect(
      fetcher.fetchAllRounds("bout-main"),
    ).resolves.toHaveLength(2);
    await expect(
      fetcher.fetchRound("unknown-bout", 1),
    ).resolves.toBeNull();
  });

  it("leaves live round fetching as a typed fail-closed hook", async () => {
    const fetcher = createLiveCitoRoundStatsFetcher();

    await expect(fetcher.fetchRound("bout-main", 1)).rejects.toThrow(
      "not installed",
    );
    await expect(fetcher.fetchAllRounds("bout-main")).rejects.toThrow(
      "not installed",
    );
  });
});
