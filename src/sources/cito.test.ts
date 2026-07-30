import { describe, expect, it, vi } from "vitest";

import canonicalFixture from "../fixtures/event.json";
import citoLiveLiveFixture from "../fixtures/citoLiveLive.json";
import {
  buildCitoLiveStateUrl,
  buildCitoRoundRowsUrl,
  buildCitoRoundStatsUrl,
  createCitoSource,
  createFixtureCitoRoundStatsFetcher,
  createLiveCitoLifecycleFetcher,
  createLiveCitoRoundStatsFetcher,
  parseCitoRoundStatsResponse,
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

  it("constructs fail-closed in live mode", async () => {
    const live = createCitoSource({ mode: "live" });

    await expect(
      live.getEvent({ source: "cito", id: "event" }),
    ).resolves.toBeNull();
    await expect(live.getRoundUpdates({} as never)).resolves.toEqual([]);
    await expect(
      live.getFighter({ source: "cito", id: "fighter" }),
    ).resolves.toBeNull();
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

  it("requires both live round-stats transport credentials", () => {
    expect(() =>
      createLiveCitoRoundStatsFetcher({
        baseUrl: "https://cito.example.invalid",
        apiKey: "",
      }),
    ).toThrow(/CITO_API_KEY/);
    expect(() =>
      createLiveCitoRoundStatsFetcher({ baseUrl: "", apiKey: "secret" }),
    ).toThrow(/base URL/);
  });
});

describe("Cito exact-round URLs", () => {
  it("builds the documented stats and rows paths with a round filter", () => {
    expect(
      buildCitoRoundStatsUrl(
        "https://api.citoapi.com/api/v1",
        "bout-123",
        3,
      ),
    ).toBe("https://api.citoapi.com/api/v1/ufc/bouts/bout-123/stats?round=3");
    expect(
      buildCitoRoundRowsUrl(
        "https://api.citoapi.com/api/v1",
        "bout-123",
        3,
      ),
    ).toBe("https://api.citoapi.com/api/v1/ufc/bouts/bout-123/rounds?round=3");
  });

  it("preserves the configured base path with or without a trailing slash", () => {
    expect(
      buildCitoRoundStatsUrl("https://cito.example.invalid/v1/", "b", 1),
    ).toBe(buildCitoRoundStatsUrl("https://cito.example.invalid/v1", "b", 1));
    expect(
      buildCitoRoundRowsUrl("https://cito.example.invalid/v1/", "b", 1),
    ).toBe(buildCitoRoundRowsUrl("https://cito.example.invalid/v1", "b", 1));
  });
});

describe("parseCitoRoundStatsResponse", () => {
  const expected = {
    round: 2,
    fighterA: {
      significantStrikes: 11,
      totalStrikes: 22,
      takedowns: 1,
      takedownsAttempted: 2,
      controlTimeSeconds: 35,
      knockdowns: 0,
    },
    fighterB: {
      significantStrikes: 9,
      totalStrikes: 18,
      takedowns: 0,
      takedownsAttempted: 1,
      controlTimeSeconds: 12,
      knockdowns: 1,
    },
  };

  it("normalizes a single round object without claiming a real vendor shape", () => {
    expect(
      parseCitoRoundStatsResponse(
        {
          round: 2,
          red: {
            significant_strikes: 11,
            total_strikes: 22,
            takedowns: 1,
            takedowns_attempted: 2,
            control_time_seconds: 35,
            knockdowns: 0,
          },
          blue: {
            significant_strikes: 9,
            total_strikes: 18,
            takedowns: 0,
            takedowns_attempted: 1,
            control_time_seconds: 12,
            knockdowns: 1,
          },
        },
        2,
      ),
    ).toEqual(expected);
  });

  it("normalizes a data wrapper and nested stats object", () => {
    expect(
      parseCitoRoundStatsResponse(
        {
          data: {
            round: 2,
            stats: {
              fighterA: {
                significantStrikes: 11,
                totalStrikes: 22,
                takedowns: 1,
                takedownsAttempted: 2,
                controlTimeSeconds: 35,
                knockdowns: 0,
              },
              fighterB: {
                significantStrikes: 9,
                totalStrikes: 18,
                takedowns: 0,
                takedownsAttempted: 1,
                controlTimeSeconds: 12,
                knockdowns: 1,
              },
            },
          },
        },
        2,
      ),
    ).toEqual(expected);
  });

  it("selects only explicitly corner-labeled rows for the requested round", () => {
    expect(
      parseCitoRoundStatsResponse(
        [
          { round: 1, corner: "red", significant_strikes: 100 },
          { round: 2, corner: "red", ...expected.fighterA },
          { round: 2, corner: "blue", ...expected.fighterB },
        ],
        2,
      ),
    ).toEqual(expected);
  });

  it("leaves an unmapped fighter absent instead of zero-filling it", () => {
    const parsed = parseCitoRoundStatsResponse(
      {
        round: 1,
        red: {
          significantStrikes: 0,
          totalStrikes: 0,
          takedowns: 0,
          takedownsAttempted: 0,
          controlTimeSeconds: 0,
          knockdowns: 0,
        },
      },
      1,
    );

    expect(parsed?.fighterA).toEqual({
      significantStrikes: 0,
      totalStrikes: 0,
      takedowns: 0,
      takedownsAttempted: 0,
      controlTimeSeconds: 0,
      knockdowns: 0,
    });
    expect(parsed).not.toHaveProperty("fighterB");
    expect(parsed?.fighterB).not.toEqual(expect.objectContaining({
      significantStrikes: 0,
    }));
  });

  it("does not subtract cumulative totals into a per-round result", () => {
    expect(
      parseCitoRoundStatsResponse(
        {
          round: 2,
          cumulative: {
            red: { significantStrikes: 40, totalStrikes: 80 },
            blue: { significantStrikes: 30, totalStrikes: 70 },
          },
        },
        2,
      ),
    ).toEqual({ round: 2 });
  });

  it("returns null for garbage or a payload with no requested round", () => {
    expect(parseCitoRoundStatsResponse({ nope: true }, 1)).toBeNull();
    expect(parseCitoRoundStatsResponse([{ round: 2 }], 1)).toBeNull();
  });
});

describe("createLiveCitoRoundStatsFetcher", () => {
  function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  const roundBody = {
    round: 2,
    red: {
      significantStrikes: 11,
      totalStrikes: 22,
      takedowns: 1,
      takedownsAttempted: 2,
      controlTimeSeconds: 35,
      knockdowns: 0,
    },
    blue: {
      significantStrikes: 9,
      totalStrikes: 18,
      takedowns: 0,
      takedownsAttempted: 1,
      controlTimeSeconds: 12,
      knockdowns: 1,
    },
  };

  it("sends x-api-key and fetches the bout plus one exact-round endpoint", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = vi.fn(async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return String(input).endsWith("/ufc/bouts/bout-123")
        ? response({ data: { fighters: [] } })
        : response(roundBody);
    }) as unknown as typeof fetch;
    const fetcher = createLiveCitoRoundStatsFetcher({
      baseUrl: "https://cito.example.invalid/api/v1/",
      apiKey: "test-secret",
      fetchImpl,
    });

    await expect(fetcher.fetchRound("bout-123", 2)).resolves.toMatchObject({
      boutId: "bout-123",
      round: 2,
      fighterA: { significantStrikes: 11 },
      fighterB: { knockdowns: 1 },
    });
    expect(calls.map(({ url }) => url)).toEqual([
      "https://cito.example.invalid/api/v1/ufc/bouts/bout-123",
      "https://cito.example.invalid/api/v1/ufc/bouts/bout-123/stats?round=2",
    ]);
    expect(calls.every(({ headers }) => headers.get("x-api-key") === "test-secret")).toBe(true);
  });

  it.each([401, 403, 429] as const)(
    "classifies HTTP %s as terminal without exposing the key",
    async (status) => {
      const fetchImpl = vi.fn(async () => response({}, status)) as unknown as typeof fetch;
      const fetcher = createLiveCitoRoundStatsFetcher({
        baseUrl: "https://cito.example.invalid/api/v1",
        apiKey: "secret-key",
        fetchImpl,
      });
      const result = fetcher.fetchRound("bout-123", 1);

      await expect(result).rejects.toMatchObject({
        kind: status === 429 ? "quota" : "auth",
        status,
      });
      await expect(result).rejects.not.toThrow("secret-key");
    },
  );

  it("classifies HTTP 500 as transient", async () => {
    const fetchImpl = vi.fn(async () => response({}, 500)) as unknown as typeof fetch;
    const fetcher = createLiveCitoRoundStatsFetcher({
      baseUrl: "https://cito.example.invalid/api/v1",
      apiKey: "secret-key",
      fetchImpl,
    });

    await expect(fetcher.fetchRound("bout-123", 1)).rejects.toMatchObject({
      kind: "transient",
      status: 500,
    });
  });

  it("classifies an aborted request as transient timeout", async () => {
    const fetchImpl = (async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;
    const fetcher = createLiveCitoRoundStatsFetcher({
      baseUrl: "https://cito.example.invalid/api/v1",
      apiKey: "secret-key",
      fetchImpl,
      timeoutMs: 1,
    });

    await expect(fetcher.fetchRound("bout-123", 1)).rejects.toMatchObject({
      kind: "transient",
    });
  });

  it("rejects an oversized response before parsing it", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ round: 1, red: {} }))) as typeof fetch;
    const fetcher = createLiveCitoRoundStatsFetcher({
      baseUrl: "https://cito.example.invalid/api/v1",
      apiKey: "secret-key",
      fetchImpl,
      maxBytes: 4,
    });

    await expect(fetcher.fetchRound("bout-123", 1)).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("serializes five documented round-filtered reconciliation requests", async () => {
    let active = 0;
    let maximumActive = 0;
    const rounds: number[] = [];
    const fetchImpl = vi.fn(async (input) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const round = Number(new URL(String(input)).searchParams.get("round"));
      rounds.push(round);
      const result = response({ ...roundBody, round });
      active -= 1;
      return result;
    }) as unknown as typeof fetch;
    const fetcher = createLiveCitoRoundStatsFetcher({
      baseUrl: "https://cito.example.invalid/api/v1",
      apiKey: "secret-key",
      fetchImpl,
    });

    await expect(fetcher.fetchAllRounds("bout-123")).resolves.toHaveLength(5);
    expect(maximumActive).toBe(1);
    expect(rounds).toEqual([0, 1, 2, 3, 4, 5]);
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
