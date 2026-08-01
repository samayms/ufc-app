import { afterEach, describe, expect, it, vi } from "vitest";
import { LabTimeline } from "./timeline.ts";
import { LabWatcher } from "./watcher.ts";

const BASE_TIME = Date.parse("2026-08-01T20:00:00.000Z");

function citoResponse(roundStats: unknown[]): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        availability:
          roundStats.length > 0 ? "available" : "pending_stat_enrichment",
        roundStats,
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

/** No method yet — the live-state poller's "nothing to report" response. */
function citoLiveStateResponse(
  overrides: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: { method: null, winnerFighterSlug: null, ...overrides },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function espnResponse(clock: string): Response {
  return new Response(
    JSON.stringify({
      events: [
        {
          // Real scoreboard payloads carry the event id, and the parser now
          // relies on it to select the requested card — ESPN ignores the
          // `event` query parameter.
          id: "600059339",
          competitions: [
            {
              id: "401870843",
              status: {
                period: 2,
                displayClock: clock,
                type: { state: "in", completed: false },
              },
            },
          ],
        },
      ],
    }),
    { status: 200 },
  );
}

function espnStatsResponse(
  athleteId: string,
  strikesLanded: number,
): Response {
  return new Response(
    JSON.stringify({
      athlete: { id: athleteId },
      splits: {
        id: "0",
        name: "All Splits",
        type: "total",
        categories: [
          {
            name: "general",
            stats: [
              {
                name: "totalStrikesLanded",
                displayName: "Total Strikes Landed",
                value: strikesLanded,
                displayValue: String(strikesLanded),
              },
              {
                name: "sigStrikesLanded",
                displayName: "Significant Strikes Landed",
                value: strikesLanded,
                displayValue: String(strikesLanded),
              },
            ],
          },
        ],
      },
    }),
    {
      status: 200,
      headers: {
        "cache-control": "max-age=5",
        age: "1",
      },
    },
  );
}

function kalshiResponse(): Response {
  return new Response(
    JSON.stringify({
      events: [
        {
          event_ticker: "KXUFCFIGHT-26AUG01MEDROD",
          title: "Fight Night: Medic vs Rodriguez",
          markets: [
            {
              ticker: "KXUFCFIGHT-26AUG01MEDROD-MED",
              yes_sub_title: "Uros Medic",
              yes_bid_dollars: "0.5400",
              yes_ask_dollars: "0.5600",
            },
            {
              ticker: "KXUFCFIGHT-26AUG01MEDROD-ROD",
              yes_sub_title: "Daniel Rodriguez",
              yes_bid_dollars: "0.4400",
              yes_ask_dollars: "0.4600",
            },
          ],
        },
      ],
    }),
    { status: 200 },
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LabWatcher CITO round polling", () => {
  it("checks immediately, then every five seconds until stats arrive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    let statsCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/state")) return citoLiveStateResponse();
      statsCalls += 1;
      if (statsCalls === 1) return citoResponse([]);
      return citoResponse([
        { fighterSlug: "red-fighter", round: 2, significantStrikes: "12 of 20" },
        { fighterSlug: "blue-fighter", round: 2, significantStrikes: "9 of 18" },
      ]);
    });
    const timeline = new LabTimeline({ now: () => Date.now() });
    const watcher = new LabWatcher({
      timeline,
      fetchImpl,
      now: () => Date.now(),
      env: {
        CITO_API_BASE_URL: "https://cito.example.test/api/v1",
        CITO_API_KEY: "test-key",
      },
    });

    timeline.record({
      kind: "marker",
      source: "user",
      label: "round ended (broadcast)",
      boutId: "12879",
      round: 2,
    });
    watcher.start({
      boutId: "12879",
      round: 2,
      citoBoutIds: ["12879"],
      citoIntervalMs: 5_000,
    });

    // Each tick fires both the round-stats poller ("cito") and the
    // fast-finish live-state poller ("cito-live") on the same cadence.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(timeline.since(0)).toContainEqual(
      expect.objectContaining({
        source: "cito",
        boutId: "12879",
        round: 2,
        deltaMs: 5_000,
        detail: expect.objectContaining({
          availability: "available",
          rows: expect.any(Array),
        }),
      }),
    );

    // "cito" found its stats and paused; "cito-live" has no method yet and
    // keeps polling every 5s (fires at +10_000 and +15_000 here).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    watcher.stop();
  });

  it("reports a fast finish from the live-state endpoint even while round stats are still pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/state")) {
        return citoLiveStateResponse({
          method: "KO/TKO",
          winnerFighterSlug: "nina-milosevic",
          currentRound: 1,
        });
      }
      return citoResponse([]);
    });
    const timeline = new LabTimeline({ now: () => Date.now() });
    const watcher = new LabWatcher({
      timeline,
      fetchImpl,
      now: () => Date.now(),
      env: {
        CITO_API_BASE_URL: "https://cito.example.test/api/v1",
        CITO_API_KEY: "test-key",
      },
    });

    watcher.start({
      boutId: "12927",
      round: 1,
      citoBoutIds: ["12927"],
      citoIntervalMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(timeline.since(0)).toContainEqual(
      expect.objectContaining({
        source: "cito-live",
        boutId: "12927",
        round: 1,
        label: "live state: KO/TKO, nina-milosevic wins (round 1)",
      }),
    );
    expect(watcher.status()).toMatchObject({
      pollers: expect.arrayContaining([
        expect.objectContaining({ name: "cito-live", active: false }),
      ]),
    });

    // The round-stats poller keeps waiting on Cito's slower enrichment
    // pipeline — a fast finish being reported doesn't short-circuit it.
    await vi.advanceTimersByTimeAsync(10_000);
    watcher.stop();
  });

  it("cancels the next CITO check when stopped manually", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(citoResponse([]));
    const timeline = new LabTimeline({ now: () => Date.now() });
    const watcher = new LabWatcher({
      timeline,
      fetchImpl,
      now: () => Date.now(),
      env: {
        CITO_API_BASE_URL: "https://cito.example.test/api/v1",
        CITO_API_KEY: "test-key",
      },
    });

    timeline.record({
      kind: "marker",
      source: "user",
      label: "round ended (broadcast)",
      boutId: "12879",
      round: 1,
    });
    watcher.start({
      boutId: "12879",
      round: 1,
      citoBoutIds: ["12879"],
      citoIntervalMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    const status = watcher.stopSource("cito");
    await vi.advanceTimersByTimeAsync(10_000);

    // stopSource("cito") stops both the round-stats poller and the
    // fast-finish live-state poller.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(status).toMatchObject({
      running: true,
      pollers: expect.arrayContaining([
        expect.objectContaining({ name: "cito", active: false, polls: 1 }),
        expect.objectContaining({
          name: "cito-live",
          active: false,
          polls: 1,
        }),
      ]),
    });
    expect(timeline.since(0)).toContainEqual(
      expect.objectContaining({
        kind: "note",
        source: "cito",
        label: "CITO polling stopped by user",
      }),
    );
    watcher.stop();
  });
});

describe("LabWatcher synchronized horn checks", () => {
  it("fires CITO, ESPN, and Kalshi immediately and timestamps ESPN round end", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    let espnCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("cito.example.test")) {
        return citoResponse([
          { fighterSlug: "uros-medic", round: 2, significantStrikes: "12 of 20" },
          {
            fighterSlug: "daniel-rodriguez",
            round: 2,
            significantStrikes: "9 of 18",
          },
        ]);
      }
      if (url.includes("site.api.espn.com")) {
        espnCalls += 1;
        return espnResponse(espnCalls === 1 ? "0:08" : "0:00");
      }
      if (url.includes("api.elections.kalshi.com")) {
        return kalshiResponse();
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const timeline = new LabTimeline({ now: () => Date.now() });
    const watcher = new LabWatcher({
      timeline,
      fetchImpl,
      now: () => Date.now(),
      env: {
        CITO_API_BASE_URL: "https://cito.example.test/api/v1",
        CITO_API_KEY: "test-key",
      },
    });
    timeline.record({
      kind: "marker",
      source: "user",
      label: "round ended (broadcast)",
      boutId: "12879",
      round: 2,
    });

    watcher.start({
      boutId: "12879",
      round: 2,
      espnEventId: "600059339",
      espnBoutId: "401870843",
      espnIntervalMs: 1_000,
      citoBoutIds: ["12879"],
      citoIntervalMs: 5_000,
      redFighter: "Uroš Medić",
      blueFighter: "Daniel Rodriguez",
      kalshiIntervalMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    // espn + cito + cito-live + kalshi, all firing immediately.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(timeline.since(0)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "cito",
          boutId: "12879",
          round: 2,
          deltaMs: 0,
        }),
        expect.objectContaining({
          source: "espn",
          boutId: "12879",
          round: 2,
          deltaMs: 0,
          detail: expect.objectContaining({ roundEnded: false }),
        }),
        expect.objectContaining({
          source: "kalshi",
          boutId: "12879",
          round: 2,
          deltaMs: 0,
          detail: expect.objectContaining({
            listed: true,
            red: expect.objectContaining({ yesCents: 55 }),
            blue: expect.objectContaining({ yesCents: 45 }),
          }),
        }),
      ]),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(timeline.since(0)).toContainEqual(
      expect.objectContaining({
        source: "espn",
        boutId: "12879",
        round: 2,
        deltaMs: 1_000,
        detail: expect.objectContaining({
          roundEnded: true,
          signal: "clock_zero",
        }),
      }),
    );

    // espn and kalshi are done; cito-live keeps polling every 5s since this
    // mock's response never carries a method.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    watcher.stop();
  });
});

describe("LabWatcher continuous ESPN fight polling", () => {
  it("samples immediately and every five seconds without stopping at a round change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    let espnCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      espnCalls += 1;
      if (espnCalls === 1) return espnResponse("4:55");
      if (espnCalls === 2) return espnResponse("4:50");
      return new Response(
        JSON.stringify({
          events: [
            {
              id: "600059339",
              competitions: [
                {
                  id: "401870843",
                  status: {
                    period: 3,
                    displayClock: "5:00",
                    type: { state: "in", completed: false },
                  },
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    });
    const timeline = new LabTimeline({ now: () => Date.now() });
    const watcher = new LabWatcher({
      timeline,
      fetchImpl,
      now: () => Date.now(),
      env: {},
    });

    watcher.start({
      boutId: "12879",
      espnEventId: "600059339",
      espnBoutId: "401870843",
      continuousEspn: true,
      espnIntervalMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const espnEntries = timeline
      .since(0)
      .filter((entry) => entry.source === "espn");
    expect(espnEntries).toHaveLength(3);
    expect(espnEntries[1]).toMatchObject({
      boutId: "12879",
      round: 2,
      detail: {
        changed: true,
        clockCorrectionSeconds: 0,
        lifecycle: {
          period: 2,
          clockSeconds: 290,
        },
      },
    });
    expect(espnEntries[2]).toMatchObject({
      boutId: "12879",
      round: 3,
      label: "ESPN changed round 2 → 3 · 5:00 · in",
      detail: {
        changed: true,
        transition: {
          previousPeriod: 2,
          period: 3,
          previousState: "in",
          state: "in",
          previousCompleted: false,
          completed: false,
        },
        lifecycle: {
          period: 3,
          clockSeconds: 300,
        },
      },
    });
    expect(watcher.status()).toMatchObject({
      running: true,
      pollers: [expect.objectContaining({ name: "espn", polls: 3 })],
    });
    watcher.stop();
  });

  it("samples both fighters' cumulative core stats every five seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    let redCalls = 0;
    let blueCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("site.api.espn.com")) return espnResponse("0:10");
      if (url.includes("/competitors/4685870/statistics")) {
        redCalls += 1;
        return espnStatsResponse("4685870", redCalls === 1 ? 0 : 4);
      }
      if (url.includes("/competitors/4426312/statistics")) {
        blueCalls += 1;
        return espnStatsResponse("4426312", blueCalls === 1 ? 0 : 3);
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const timeline = new LabTimeline({ now: () => Date.now() });
    const watcher = new LabWatcher({
      timeline,
      fetchImpl,
      now: () => Date.now(),
      env: {},
    });

    watcher.start({
      boutId: "12879",
      espnEventId: "600059339",
      espnBoutId: "401870843",
      espnRedAthleteId: "4685870",
      espnBlueAthleteId: "4426312",
      continuousEspn: true,
      espnIntervalMs: 5_000,
      espnStatsIntervalMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    const samples = timeline
      .since(0)
      .filter((entry) => entry.source === "espn-stats");
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({
      boutId: "12879",
      detail: {
        cumulativeOnly: true,
        exactRoundStats: false,
        sampleNumber: 1,
        changedCount: 0,
        hasValues: false,
        red: {
          athleteId: "4685870",
          response: { cacheControl: "max-age=5", age: "1" },
        },
        blue: { athleteId: "4426312" },
      },
    });
    expect(samples[1]).toMatchObject({
      detail: {
        sampleNumber: 2,
        firstNonzero: true,
        hasValues: true,
        changedCount: 4,
        changedFields: expect.arrayContaining([
          expect.objectContaining({
            corner: "red",
            name: "totalStrikesLanded",
            delta: 4,
          }),
          expect.objectContaining({
            corner: "blue",
            name: "sigStrikesLanded",
            delta: 3,
          }),
        ]),
      },
    });
    expect(watcher.status()).toMatchObject({
      running: true,
      pollers: expect.arrayContaining([
        expect.objectContaining({ name: "espn", active: true, polls: 2 }),
        expect.objectContaining({
          name: "espn-stats",
          active: true,
          polls: 2,
        }),
      ]),
    });
    const callsAtStop = fetchImpl.mock.calls.length;
    const stopped = watcher.stopSource("espn");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(callsAtStop);
    expect(stopped.pollers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "espn", active: false }),
        expect.objectContaining({ name: "espn-stats", active: false }),
      ]),
    );
    watcher.stop();
  });
});
