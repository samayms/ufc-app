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

  it("still derives round 2 as a delta when ESPN's own period flips to 2 immediately, before any round-1 snapshot arrives at/after the 30s settlement point", () => {
    // This is the real-world ESPN behavior, not the test fixture's generous
    // assumption above: the scoreboard's `period` field can advance to the
    // next round within a couple of poll cycles of the horn, well under the
    // 30-second settlement window. No further round-1-tagged observation
    // ever arrives, so finalization must not depend on one.
    const stats = new EspnRoundStatsAccumulator();
    const endedAt = Date.parse("2026-08-01T00:00:00.000Z");
    expect(stats.observe(snapshot(1, endedAt - 2_000, 10))).toMatchObject({ finalized: false });
    stats.markRoundEnded("bout", 1, new Date(endedAt).toISOString());
    // Round flips to 2 within a couple of poll cycles — well before the 30s
    // settlement point round 1 was waiting on.
    const round2 = stats.observe(snapshot(2, endedAt + 5_000, 17));
    expect(round2.finalized).toBe(false);
    expect(round2.fighterA.significantStrikesLanded).toBe(7);
    expect(round2.fighterA.significantStrikesAttempted).toBe(7);
  });

  it("uses a seeded baseline for the next round's delta after a fresh accumulator (e.g. a process restart mid-fight)", () => {
    // EspnRoundStatsAccumulator's finalizedTotals map is pure in-memory
    // state. A restart mid-fight (a deploy, a crash) constructs a brand new
    // accumulator with no memory of any already-completed round, even though
    // round 1's cumulative-through-round-1 total is fully recoverable from
    // what was already persisted (the round's own stored delta *is* that
    // cumulative total, since round 1's baseline is always zero). Without a
    // way to seed that recovered baseline back in, every later round's
    // "individual round" stats silently revert to raw fight-to-date
    // cumulative totals for the rest of the fight — this is the Miller-fight
    // bug: it reproduces the exact symptom the period-flip fix above
    // addresses, but from state loss on restart rather than a timing race.
    const stats = new EspnRoundStatsAccumulator();
    stats.seedBaseline("bout", 1, {
      fighterA: { ...zero, significantStrikesLanded: 10, significantStrikesAttempted: 12 },
      fighterB: { ...zero, significantStrikesLanded: 11, significantStrikesAttempted: 14 },
    });
    const endedAt = Date.parse("2026-08-01T00:00:00.000Z");
    const round2 = stats.observe(snapshot(2, endedAt + 5_000, 17));
    expect(round2.finalized).toBe(false);
    expect(round2.fighterA.significantStrikesLanded).toBe(7);
    expect(round2.fighterA.significantStrikesAttempted).toBe(7);
  });

  it("does not let a seeded baseline override a later, more current one for the same round", () => {
    const stats = new EspnRoundStatsAccumulator();
    const endedAt = Date.parse("2026-08-01T00:00:00.000Z");
    stats.markRoundEnded("bout", 1, new Date(endedAt).toISOString());
    stats.observe(snapshot(1, endedAt + ESPN_ROUND_FINALIZATION_DELAY_MS, 12));
    // A stale/late seed call (e.g. a slow restore racing live traffic)
    // should not clobber a baseline that observe() already established.
    stats.seedBaseline("bout", 1, {
      fighterA: { ...zero, significantStrikesLanded: 999 },
      fighterB: { ...zero, significantStrikesLanded: 999 },
    });
    const round2 = stats.observe(snapshot(2, endedAt + 35_000, 17));
    expect(round2.fighterA.significantStrikesLanded).toBe(5);
  });
});
