import { describe, expect, it } from "vitest";
import {
  ESPN_ROUND_FINALIZATION_DELAY_MS,
  EspnRoundStatsAccumulator,
  type EspnCumulativeSnapshot,
} from "./espnRoundStats.ts";

const zero = {
  significantStrikesLanded: 0, significantStrikesAttempted: 0,
  totalStrikesLanded: 0, totalStrikesAttempted: 0,
  takedownsLanded: 0, takedownsAttempted: 0, submissionsAttempted: 0,
  reversals: 0, controlTimeSeconds: 0, knockdowns: 0,
  headStrikesLanded: 0, headStrikesAttempted: 0,
  bodyStrikesLanded: 0, bodyStrikesAttempted: 0,
  legStrikesLanded: 0, legStrikesAttempted: 0,
};

function snapshot(round: number, at: number, significant: number): EspnCumulativeSnapshot {
  return {
    boutId: "bout", round, observedAt: new Date(at).toISOString(),
    fighterA: { ...zero, significantStrikesLanded: significant, significantStrikesAttempted: significant + 2 },
    fighterB: { ...zero, significantStrikesLanded: significant + 1, significantStrikesAttempted: significant + 4 },
  };
}

describe("EspnRoundStatsAccumulator", () => {
  it("emits live current-round deltas and settles a baseline 30 seconds after the end", () => {
    const stats = new EspnRoundStatsAccumulator();
    const endedAt = Date.parse("2026-08-01T00:00:00.000Z");
    stats.markRoundEnded("bout", 1, new Date(endedAt).toISOString());
    expect(stats.observe(snapshot(1, endedAt + 5_000, 10))).toMatchObject({ finalized: false, fighterA: { significantStrikesLanded: 10 } });
    expect(stats.observe(snapshot(1, endedAt + ESPN_ROUND_FINALIZATION_DELAY_MS, 12))).toMatchObject({ finalized: true, fighterA: { significantStrikesLanded: 12 } });
    expect(stats.observe(snapshot(2, endedAt + 35_000, 17))).toMatchObject({ finalized: false, fighterA: { significantStrikesLanded: 5, significantStrikesAttempted: 5 } });
  });

  it("finalizes the final round immediately when ESPN reports the fight complete", () => {
    const stats = new EspnRoundStatsAccumulator();
    expect(stats.finalizeFight(snapshot(1, Date.now(), 8)).finalized).toBe(true);
  });
});
