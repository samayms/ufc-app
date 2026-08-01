import { describe, expect, it } from "vitest";
import type { CitoRoundStatsFetcher } from "../src/sources/cito.ts";
import { createCitoRoundStatsRefTranslator } from "./collector.ts";

describe("Cito round-stats bout-id translation", () => {
  it("requests Cito ids while callers continue using internal ids", async () => {
    const calls: string[] = [];
    const fetcher: CitoRoundStatsFetcher = {
      async fetchRound(boutId, round) {
        calls.push(`round:${boutId}:${round}`);
        return { boutId, round };
      },
      async fetchAllRounds(boutId) {
        calls.push(`all:${boutId}`);
        return [{ boutId, round: 1 }];
      },
    };
    const translated = createCitoRoundStatsRefTranslator(
      fetcher,
      (internalBoutId) =>
        internalBoutId === "401870843"
          ? [{ source: "espn", id: internalBoutId }, { source: "cito", id: "12879" }]
          : [],
      () => {
        throw new Error("The mapped bout must not degrade");
      },
    );

    await expect(translated.fetchRound("401870843", 2)).resolves.toEqual({
      boutId: "12879",
      round: 2,
    });
    await expect(translated.fetchAllRounds("401870843")).resolves.toEqual([
      { boutId: "12879", round: 1 },
    ]);
    expect(calls).toEqual(["round:12879:2", "all:12879"]);
  });

  it("returns null/empty without HTTP and reports a missing ref once", async () => {
    let httpCalls = 0;
    let degradations = 0;
    const fetcher: CitoRoundStatsFetcher = {
      async fetchRound() {
        httpCalls += 1;
        return { round: 1 };
      },
      async fetchAllRounds() {
        httpCalls += 1;
        return [{ round: 1 }];
      },
    };
    const translated = createCitoRoundStatsRefTranslator(
      fetcher,
      () => [{ source: "espn", id: "401870843" }],
      () => {
        degradations += 1;
      },
    );

    await expect(translated.fetchRound("401870843", 1)).resolves.toBeNull();
    await expect(translated.fetchRound("401870843", 2)).resolves.toBeNull();
    await expect(translated.fetchAllRounds("401870843")).resolves.toEqual([]);
    expect(httpCalls).toBe(0);
    expect(degradations).toBe(1);
  });
});
