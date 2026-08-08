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

  // Last raw cumulative snapshot seen while each round was still current.
  // ESPN's own `period` field can advance to the next round within a couple
  // of poll cycles of the horn — well under the 30s settlement window below
  // — in which case no further snapshot tagged with the old round number
  // ever arrives to complete finalization the normal way. Keeping the last
  // one lets settleStaleRounds() finalize from it once play has visibly
  // moved on, instead of leaving the baseline permanently missing (which
  // silently turned every later round's "individual round" stats into raw
  // fight-to-date cumulative totals).
  private readonly lastSnapshotByRound = new Map<string, EspnCumulativeSnapshot>();

  observe(snapshot: EspnCumulativeSnapshot): EspnDerivedRoundStats {
    this.settleStaleRounds(snapshot);

    const key = `${snapshot.boutId}:${snapshot.round}`;
    this.lastSnapshotByRound.set(key, snapshot);

    const baseline = this.finalizedTotals.get(
      `${snapshot.boutId}:${snapshot.round - 1}`,
    );
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

  /**
   * Once a later round has visibly started, every earlier round with a
   * still-pending finalization is unambiguously over — finalize it now from
   * the last cumulative total actually observed while it was current, since
   * no snapshot carrying its round number is coming again.
   */
  private settleStaleRounds(snapshot: EspnCumulativeSnapshot): void {
    for (const key of [...this.pendingFinalizations.keys()]) {
      const separator = key.lastIndexOf(":");
      const boutId = key.slice(0, separator);
      const round = Number(key.slice(separator + 1));
      if (boutId !== snapshot.boutId || round >= snapshot.round) continue;

      const last = this.lastSnapshotByRound.get(key);
      if (last !== undefined) this.finalizedTotals.set(key, last);
      this.pendingFinalizations.delete(key);
    }
  }

  finalizeFight(snapshot: EspnCumulativeSnapshot): EspnDerivedRoundStats {
    this.pendingFinalizations.set(`${snapshot.boutId}:${snapshot.round}`, 0);
    return this.observe(snapshot);
  }

  /**
   * Restore a round's cumulative-through-that-round baseline recovered from
   * persisted storage, so the next round's delta is computed correctly by
   * an accumulator that never itself observed that round live. This is what
   * makes finalizedTotals survive a process restart mid-fight — without it,
   * every round observed after a restart falls back to raw fight-to-date
   * cumulative totals, since finalizedTotals is otherwise built up only from
   * live observe()/settleStaleRounds() calls and starts empty on construction.
   *
   * Never overwrites a baseline observe()/settleStaleRounds() already
   * established — a seed call is a best-effort recovery, not a source of
   * truth once the accumulator has live data of its own.
   */
  seedBaseline(
    boutId: string,
    round: number,
    totals: {
      fighterA: EspnCumulativeFighterStats;
      fighterB: EspnCumulativeFighterStats;
    },
  ): void {
    const key = `${boutId}:${round}`;
    if (this.finalizedTotals.has(key)) return;
    this.finalizedTotals.set(key, {
      boutId,
      round,
      fighterA: totals.fighterA,
      fighterB: totals.fighterB,
      observedAt: new Date(0).toISOString(),
    });
  }
}
