import { describe, expect, it } from "vitest";

import canonicalFixture from "../fixtures/event.json";
import citoLiveLiveFixture from "../fixtures/citoLiveLive.json";
import {
  buildCitoLiveStateUrl,
  createCitoSource,
  createFixtureCitoRoundStatsFetcher,
  createLiveCitoLifecycleFetcher,
  createLiveCitoRoundStatsFetcher,
  parseCitoLiveStateLifecycle,
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

describe("buildCitoLiveStateUrl", () => {
  it("preserves an /api/v1 base URL prefix when resolving the live path", () => {
    const url = buildCitoLiveStateUrl("https://api.citoapi.com/api/v1");

    expect(url).toBe("https://api.citoapi.com/api/v1/ufc/live");
  });

  it("builds a live-state URL under a configured base URL without a version prefix", () => {
    const url = buildCitoLiveStateUrl("https://cito.example.invalid/v1");

    expect(url).toBe("https://cito.example.invalid/v1/ufc/live");
  });

  it("resolves correctly whether or not the base URL has a trailing slash", () => {
    expect(buildCitoLiveStateUrl("https://cito.example.invalid/v1/")).toBe(
      buildCitoLiveStateUrl("https://cito.example.invalid/v1"),
    );
  });

  it("rejects an empty base URL", () => {
    expect(() => buildCitoLiveStateUrl("")).toThrow(/non-empty base URL/);
  });
});

describe("parseCitoLiveStateLifecycle", () => {
  it("normalizes a realistic {success,data,meta} live-state payload into lifecycle entries", () => {
    const payload = {
      success: true,
      data: {
        liveBouts: [
          {
            boutId: "cito-bout-9001",
            status: "between_rounds",
            currentRound: 2,
            finalRound: null,
          },
          {
            boutId: "cito-bout-9002",
            status: "completed",
            currentRound: null,
            finalRound: 2,
          },
          {
            boutId: "cito-bout-9003",
            status: "scheduled",
            currentRound: null,
            finalRound: null,
          },
        ],
        nextBouts: [
          { boutId: "cito-bout-9999", status: "scheduled" },
        ],
        nextArmedBout: null,
        events: [],
      },
      meta: { recommendedPollSeconds: 15, health: { ok: true } },
    };

    expect(parseCitoLiveStateLifecycle(payload)).toEqual([
      {
        externalId: "cito-bout-9001",
        state: "in",
        period: 2,
        completed: false,
        clockSeconds: 0,
      },
      {
        externalId: "cito-bout-9002",
        state: "post",
        period: 2,
        completed: true,
      },
      {
        externalId: "cito-bout-9003",
        state: "pre",
        period: 0,
        completed: false,
      },
    ]);
  });

  it("ignores nextBouts entirely (only liveBouts feed lifecycle entries)", () => {
    const payload = {
      success: true,
      data: {
        liveBouts: [],
        nextBouts: [
          { boutId: "cito-bout-armed", status: "scheduled" },
        ],
        nextArmedBout: { boutId: "cito-bout-armed" },
        events: [],
      },
    };

    expect(parseCitoLiveStateLifecycle(payload)).toEqual([]);
  });

  it("skips live bouts without a recognizable id", () => {
    const payload = {
      success: true,
      data: { liveBouts: [{ status: "live", currentRound: 1 }] },
    };

    expect(parseCitoLiveStateLifecycle(payload)).toEqual([]);
  });

  it("rejects a non-object payload", () => {
    expect(() => parseCitoLiveStateLifecycle(null)).toThrow(/JSON object/);
    expect(() => parseCitoLiveStateLifecycle(42)).toThrow(/JSON object/);
  });

  it("degrades safely (returns no entries) when data/liveBouts is missing or malformed", () => {
    expect(parseCitoLiveStateLifecycle({})).toEqual([]);
    expect(parseCitoLiveStateLifecycle({ success: false })).toEqual([]);
    expect(parseCitoLiveStateLifecycle({ data: null })).toEqual([]);
    expect(parseCitoLiveStateLifecycle({ data: {} })).toEqual([]);
    expect(parseCitoLiveStateLifecycle({ data: { liveBouts: null } })).toEqual(
      [],
    );
  });

  it("yields no lifecycle entries from the real captured /ufc/live response (empty liveBouts/nextBouts)", () => {
    expect(parseCitoLiveStateLifecycle(citoLiveLiveFixture)).toEqual([]);
  });
});

describe("createLiveCitoLifecycleFetcher", () => {
  it("fails closed outside of live mode", () => {
    expect(() =>
      createLiveCitoLifecycleFetcher(
        { mode: "fixture" },
        { baseUrl: "https://cito.example.invalid" },
      ),
    ).toThrow(/DATA_MODE=live/);
  });

  it("fails closed without CITO_API_KEY", () => {
    expect(() =>
      createLiveCitoLifecycleFetcher(
        { mode: "live", credentials: {} },
        { baseUrl: "https://cito.example.invalid" },
      ),
    ).toThrow(/CITO_API_KEY/);
  });

  it("fails closed without a configured base URL", () => {
    expect(() =>
      createLiveCitoLifecycleFetcher(
        { mode: "live", credentials: { CITO_API_KEY: "secret" } },
        { baseUrl: "" },
      ),
    ).toThrow(/base URL/);
  });

  it("constructs once mode, key, and base URL are all present", () => {
    expect(() =>
      createLiveCitoLifecycleFetcher(
        { mode: "live", credentials: { CITO_API_KEY: "secret" } },
        { baseUrl: "https://cito.example.invalid" },
      ),
    ).not.toThrow();
  });
});
