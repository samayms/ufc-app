/**
 * ESPN provides fight totals, not a dependable round endpoint.  This module
 * turns those monotonically-increasing totals into the live/final total for a
 * single round without ever reaching out to another provider.
 */
export interface EspnCumulativeFighterStats {
  significantStrikesLanded: number;
  significantStrikesAttempted: number;
  totalStrikesLanded: number;
  totalStrikesAttempted: number;
  takedownsLanded: number;
  takedownsAttempted: number;
  submissionsAttempted: number;
  reversals: number;
  controlTimeSeconds: number;
  knockdowns: number;
  headStrikesLanded: number;
  headStrikesAttempted: number;
  bodyStrikesLanded: number;
  bodyStrikesAttempted: number;
  legStrikesLanded: number;
  legStrikesAttempted: number;
}

export interface EspnCumulativeSnapshot {
  boutId: string;
  round: number;
  fighterA: EspnCumulativeFighterStats;
  fighterB: EspnCumulativeFighterStats;
  observedAt: string;
}

export interface EspnDerivedRoundStats {
  boutId: string;
  round: number;
  fighterA: EspnCumulativeFighterStats;
  fighterB: EspnCumulativeFighterStats;
  observedAt: string;
  finalized: boolean;
}

export const ESPN_ROUND_FINALIZATION_DELAY_MS = 30_000;

function subtract(
  current: EspnCumulativeFighterStats,
  baseline: EspnCumulativeFighterStats | undefined,
): EspnCumulativeFighterStats {
  const result = {} as Record<keyof EspnCumulativeFighterStats, number>;
  for (const key of Object.keys(current) as Array<keyof EspnCumulativeFighterStats>) {
    // Correct a transient upstream regression without exposing negative stats.
    result[key] = Math.max(0, current[key] - (baseline?.[key] ?? 0));
  }
  return result as EspnCumulativeFighterStats;
}

/** Maintains completed-round cumulative baselines and live current-round deltas. */
export class EspnRoundStatsAccumulator {
  private readonly finalizedTotals = new Map<string, EspnCumulativeSnapshot>();

  private readonly pendingFinalizations = new Map<string, number>();

  observe(snapshot: EspnCumulativeSnapshot): EspnDerivedRoundStats {
    const baseline = this.finalizedTotals.get(
      `${snapshot.boutId}:${snapshot.round - 1}`,
    );
    const key = `${snapshot.boutId}:${snapshot.round}`;
    const dueAt = this.pendingFinalizations.get(key);
    const finalized = dueAt !== undefined && Date.parse(snapshot.observedAt) >= dueAt;
    const derived: EspnDerivedRoundStats = {
      ...snapshot,
      fighterA: subtract(snapshot.fighterA, baseline?.fighterA),
      fighterB: subtract(snapshot.fighterB, baseline?.fighterB),
      finalized,
    };
    if (finalized) {
      this.finalizedTotals.set(key, snapshot);
      this.pendingFinalizations.delete(key);
    }
    return derived;
  }

  /** Start the 30-second ESPN settlement window when lifecycle detects a round end. */
  markRoundEnded(boutId: string, round: number, endedAt: string): void {
    this.pendingFinalizations.set(
      `${boutId}:${round}`,
      Date.parse(endedAt) + ESPN_ROUND_FINALIZATION_DELAY_MS,
    );
  }

  finalizeFight(snapshot: EspnCumulativeSnapshot): EspnDerivedRoundStats {
    this.pendingFinalizations.set(`${snapshot.boutId}:${snapshot.round}`, 0);
    return this.observe(snapshot);
  }
}
