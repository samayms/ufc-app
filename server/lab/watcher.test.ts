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

function espnResponse(clock: string): Response {
  return new Response(
    JSON.stringify({
      events: [
        {
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
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(citoResponse([]))
      .mockResolvedValueOnce(
        citoResponse([
          { fighterSlug: "red-fighter", round: 2, significantStrikes: "12 of 20" },
          { fighterSlug: "blue-fighter", round: 2, significantStrikes: "9 of 18" },
        ]),
      );
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

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
    watcher.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

    expect(fetchImpl).toHaveBeenCalledTimes(3);
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
    expect(fetchImpl).toHaveBeenCalledTimes(4);
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

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    watcher.stop();
  });
});
