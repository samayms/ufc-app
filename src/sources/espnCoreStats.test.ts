import { describe, expect, it, vi } from "vitest";
import { buildEspnCoreStatsUrl, fetchEspnCoreCumulativeStats, parseEspnCoreCumulativeStats } from "./espnCoreStats.ts";

describe("ESPN core cumulative stats", () => {
  it("uses the per-athlete core endpoint and maps stat names", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      splits: { categories: [{ stats: [
        { name: "sigStrikesLanded", value: 5 },
        { name: "sigStrikesAttempted", value: 11 },
        { name: "takedownsAttempted", value: 2 },
      ] }] },
    }), { status: 200 }));
    await expect(fetchEspnCoreCumulativeStats({ eventId: "600", competitionId: "401", athleteId: "88", fetchImpl })).resolves.toMatchObject({ significantStrikesLanded: 5, significantStrikesAttempted: 11, takedownsAttempted: 2 });
    expect(fetchImpl).toHaveBeenCalledWith(buildEspnCoreStatsUrl("600", "401", "88"), expect.any(Object));
  });

  it("handles captured control, submissions, and target component names", () => {
    const payload = { splits: { categories: [{ stats: [
      { name: "timeInControl", value: 74 }, { name: "submissions", value: 2 },
      { name: "sigDistanceHeadStrikesLanded", value: 3 }, { name: "sigClinchHeadStrikesLanded", value: 2 }, { name: "sigGroundHeadStrikesLanded", value: 1 },
      { name: "sigDistanceHeadStrikesAttempted", value: 7 }, { name: "sigClinchHeadStrikesAttempted", value: 4 }, { name: "sigGroundHeadStrikesAttempted", value: 2 },
      { name: "bodyStrikesLanded", value: 9 }, { name: "bodyStrikesLandedDistance", value: 1 },
    ] }] } };
    expect(parseEspnCoreCumulativeStats(payload)).toMatchObject({ controlTimeSeconds: 74, submissionsAttempted: 2, headStrikesLanded: 6, headStrikesAttempted: 13, bodyStrikesLanded: 9 });
  });
});
