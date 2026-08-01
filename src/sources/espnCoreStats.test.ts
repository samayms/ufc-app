import { describe, expect, it, vi } from "vitest";
import { buildEspnCoreStatsUrl, fetchEspnCoreCumulativeStats } from "./espnCoreStats.ts";

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
});
