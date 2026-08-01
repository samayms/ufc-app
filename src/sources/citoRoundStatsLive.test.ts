import { describe, expect, it } from "vitest";

import boutFixture from "../fixtures/citoBoutLive.json";
import roundRowsFixture from "../fixtures/citoRoundRowsLive.json";
import roundStatsFixture from "../fixtures/citoRoundStatsLive.json";
import {
  createLiveCitoRoundStatsFetcher,
  parseCitoBoutCorners,
  parseCitoRoundStatsResponse,
} from "./cito.ts";

const corners = new Map<string, "red" | "blue">([
  ["bogdan-guskov", "red"],
  ["magomed-ankalaev", "blue"],
]);

const expected = {
  boutId: "9009ec7b91f2be14",
  round: 1,
  fighterA: {
    significantStrikes: 11,
    totalStrikes: 11,
    takedowns: 0,
    takedownsAttempted: 0,
    controlTimeSeconds: 0,
    knockdowns: 0,
  },
  fighterB: {
    significantStrikes: 19,
    totalStrikes: 19,
    takedowns: 0,
    takedownsAttempted: 1,
    controlTimeSeconds: 0,
    knockdowns: 0,
  },
  sourceUpdatedAt: "2026-07-29T18:50:55.459Z",
};

describe("real Cito exact-round fixtures", () => {
  it("extracts both fighters and exact normalized values from stats", () => {
    expect(
      parseCitoRoundStatsResponse(roundStatsFixture, 1, { corners }),
    ).toEqual(expected);
  });

  it("parses the strict-subset rounds response identically", () => {
    expect(
      parseCitoRoundStatsResponse(roundRowsFixture, 1, { corners }),
    ).toEqual(expected);
  });

  it("returns only round-level data without a corner map", () => {
    expect(parseCitoRoundStatsResponse(roundStatsFixture, 1)).toEqual({
      boutId: "9009ec7b91f2be14",
      round: 1,
      sourceUpdatedAt: "2026-07-29T18:50:55.459Z",
    });
  });

  it("skips an unknown slug while retaining the mapped fighter", () => {
    const payload = {
      ...roundStatsFixture,
      data: {
        ...roundStatsFixture.data,
        roundStats: [
          ...roundStatsFixture.data.roundStats,
          {
            ...roundStatsFixture.data.roundStats[0],
            fighterSlug: "unknown-fighter",
          },
        ],
      },
    };

    expect(
      parseCitoRoundStatsResponse(payload, 1, { corners }),
    ).toEqual(expected);
  });

  it("returns null while Cito has not enriched the round", () => {
    expect(
      parseCitoRoundStatsResponse(
        {
          success: true,
          data: { roundStats: [], availability: "pending_stat_enrichment" },
          meta: { round: 1 },
        },
        1,
      ),
    ).toBeNull();
  });

  it("preserves control-time zero", () => {
    const parsed = parseCitoRoundStatsResponse(roundStatsFixture, 1, {
      corners,
    });

    expect(parsed?.fighterA?.controlTimeSeconds).toBe(0);
    expect(parsed?.fighterB?.controlTimeSeconds).toBe(0);
  });

  it("reads both valid corners from the captured bout response", () => {
    expect(parseCitoBoutCorners(boutFixture)).toEqual(
      new Map([
        ["daniel-rodriguez", "blue"],
        ["uros-medic", "red"],
      ]),
    );
  });
});

describe("real Cito live fetch path", () => {
  it("fetches bout corners once, then only stats for later rounds", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/ufc/bouts/9009ec7b91f2be14")) {
        return new Response(
          JSON.stringify({
            data: {
              fighters: [
                { fighterSlug: "bogdan-guskov", corner: "red" },
                { fighterSlug: "magomed-ankalaev", corner: "blue" },
              ],
            },
          }),
        );
      }
      if (url.includes("/stats?round=")) {
        return new Response(JSON.stringify(roundStatsFixture));
      }
      throw new Error(`Unexpected Cito URL: ${url}`);
    };

    const fetcher = createLiveCitoRoundStatsFetcher({
      baseUrl: "https://cito.example.invalid/api/v1",
      apiKey: "test-secret",
      fetchImpl,
    });

    await expect(fetcher.fetchRound("9009ec7b91f2be14", 1)).resolves.toEqual(
      expected,
    );
    await expect(
      fetcher.fetchRound("9009ec7b91f2be14", 2),
    ).resolves.toBeNull();

    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe(
      "https://cito.example.invalid/api/v1/ufc/bouts/9009ec7b91f2be14",
    );
    expect(calls[1]).toBe(
      "https://cito.example.invalid/api/v1/ufc/bouts/9009ec7b91f2be14/stats?round=1",
    );
    expect(calls[2]).toBe(
      "https://cito.example.invalid/api/v1/ufc/bouts/9009ec7b91f2be14/stats?round=2",
    );
    expect(calls.every((url) => !url.includes("/rounds"))).toBe(true);
  });
});
