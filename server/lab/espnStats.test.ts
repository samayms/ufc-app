import { describe, expect, it, vi } from "vitest";
import {
  buildEspnCoreStatsUrl,
  diffEspnCoreStats,
  fetchEspnCoreStats,
  hasNonzeroEspnCoreStats,
  parseEspnCoreStats,
  type EspnCoreStatsResponseMeta,
} from "./espnStats.ts";

const RESPONSE_META: EspnCoreStatsResponseMeta = {
  url: "https://sports.core.api.espn.com/example",
  startedAt: "2026-08-01T20:00:00.000Z",
  receivedAt: "2026-08-01T20:00:00.120Z",
  durationMs: 120,
  status: 200,
  bytes: 123,
  sha256: "abc",
};

function statsPayload(totalLanded: number, controlTime: number): unknown {
  return {
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
              abbreviation: "TSL",
              value: totalLanded,
              displayValue: String(totalLanded),
            },
            {
              name: "timeInControl",
              displayName: "Time in Control",
              value: controlTime,
              displayValue: `${Math.floor(controlTime / 60)}:${String(
                controlTime % 60,
              ).padStart(2, "0")}`,
            },
          ],
        },
      ],
    },
  };
}

describe("ESPN core statistics", () => {
  it("builds the fighter-specific core API URL", () => {
    expect(
      buildEspnCoreStatsUrl("600059339", "401870843", "4685870"),
    ).toBe(
      "https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/600059339/competitions/401870843/competitors/4685870/statistics",
    );
  });

  it("keeps every stat and reports sample-to-sample field changes", () => {
    const first = parseEspnCoreStats(
      statsPayload(0, 0),
      "4685870",
      RESPONSE_META,
    );
    const second = parseEspnCoreStats(
      statsPayload(7, 12),
      "4685870",
      { ...RESPONSE_META, sha256: "def" },
    );

    expect(first).toMatchObject({
      athleteId: "4685870",
      split: {
        id: "0",
        name: "All Splits",
        type: "total",
        categories: ["general"],
      },
      stats: [
        {
          name: "totalStrikesLanded",
          displayName: "Total Strikes Landed",
          abbreviation: "TSL",
          value: 0,
          displayValue: "0",
        },
        {
          name: "timeInControl",
          value: 0,
          displayValue: "0:00",
        },
      ],
    });
    expect(hasNonzeroEspnCoreStats(first)).toBe(false);
    expect(hasNonzeroEspnCoreStats(second)).toBe(true);
    expect(diffEspnCoreStats(first, second)).toEqual([
      expect.objectContaining({
        name: "totalStrikesLanded",
        previous: 0,
        current: 7,
        delta: 7,
      }),
      expect.objectContaining({
        name: "timeInControl",
        previous: 0,
        current: 12,
        delta: 12,
        displayValue: "0:12",
      }),
    ]);
  });

  it("captures response timing, cache headers, bytes, and body hash", async () => {
    let nowCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(statsPayload(0, 0)), {
        status: 200,
        headers: {
          "cache-control": "max-age=5, stale-while-revalidate=30",
          age: "3",
          date: "Sat, 01 Aug 2026 20:00:00 GMT",
          etag: '"stats-v1"',
        },
      }),
    );

    const sample = await fetchEspnCoreStats({
      eventId: "600059339",
      competitionId: "401870843",
      athleteId: "4685870",
      fetchImpl,
      now: () => [1_786_132_800_000, 1_786_132_800_125][nowCalls++] ?? 0,
    });

    expect(sample.response).toMatchObject({
      durationMs: 125,
      status: 200,
      cacheControl: "max-age=5, stale-while-revalidate=30",
      age: "3",
      date: "Sat, 01 Aug 2026 20:00:00 GMT",
      etag: '"stats-v1"',
    });
    expect(sample.response.bytes).toBeGreaterThan(0);
    expect(sample.response.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
