/**
 * Odds normalization: reconciles the three market kinds (Kalshi cents,
 * Polymarket 0-1 prices, vigged sportsbook American moneylines) into
 * comparable vig-free probabilities.
 *
 * Math choices, deliberately kept simple:
 *
 * - De-vig is multiplicative (divide each corner's probability by the pair's
 *   sum), not additive or model-based. It's the standard, simplest way to
 *   strip a market's overround and it's what makes probabilities from very
 *   different market structures (a sportsbook's two-sided moneyline, a
 *   Kalshi YES/NO pair, two independent Polymarket token prices)
 *   comparable on the same 0-1 scale. It is not a claim that the result is
 *   the "true" probability of either fighter winning — it's a consistent
 *   normalization so the UI can show markets side by side.
 * - Every market kind gets the same treatment: average each corner's raw
 *   implied probability (across sportsbook books, or across whatever
 *   quotes a market has for that corner), then de-vig the averaged pair.
 *   Kalshi and Polymarket are nominally single quotes per corner today, but
 *   their YES/NO or two-outcome prices can still sum away from 1 (spread,
 *   stale ticks), so they go through the same averaging + de-vig path as
 *   sportsbooks rather than a special case.
 * - Degenerate inputs (a pair summing to zero or less) fall back to 0.5/0.5
 *   rather than dividing by zero or returning a nonsensical negative
 *   probability.
 * - `consensus` averages vig-free probabilities across markets and reports
 *   the per-corner [min, max] spread so the UI can show how much markets
 *   disagree, not just a single blended number.
 */

import type { Corner, OddsSnapshot } from "../schema/types.ts";

/** American moneyline -> implied probability, vig included. */
export function americanToImpliedProb(moneyline: number): number {
  return moneyline < 0
    ? -moneyline / (-moneyline + 100)
    : 100 / (moneyline + 100);
}

/**
 * Multiplicative de-vig: divide each corner's probability by the pair's
 * sum so they add to 1. Degenerate sums (<= 0) fall back to 0.5/0.5.
 */
export function devigPair(
  redProb: number,
  blueProb: number,
): { red: number; blue: number } {
  const sum = redProb + blueProb;
  if (sum <= 0) {
    return { red: 0.5, blue: 0.5 };
  }

  return { red: redProb / sum, blue: blueProb / sum };
}

/**
 * Mean raw (still vigged) implied probability across every quote a snapshot
 * carries for one corner. Null when the corner has no quotes.
 */
export function averageImpliedProbability(
  snapshot: OddsSnapshot,
  corner: Corner,
): number | null {
  const probs = snapshot.quotes
    .filter((quote) => quote.corner === corner)
    .map((quote) => quote.impliedProbability);

  if (probs.length === 0) {
    return null;
  }

  return probs.reduce((sum, prob) => sum + prob, 0) / probs.length;
}

/**
 * Vig-free red/blue probabilities for one market snapshot. Averages each
 * corner's raw implied probability across whatever quotes that corner has
 * (multiple sportsbooks, or a single Kalshi/Polymarket quote), then
 * de-vigs the averaged pair. Null if either corner has no quotes.
 */
export function marketProbabilities(
  snapshot: OddsSnapshot,
): { red: number; blue: number } | null {
  const red = averageImpliedProbability(snapshot, "red");
  const blue = averageImpliedProbability(snapshot, "blue");

  if (red === null || blue === null) {
    return null;
  }

  return devigPair(red, blue);
}

/**
 * Vig-free probability per corner averaged across markets, plus the
 * per-corner [min, max] spread across markets and how many markets
 * contributed. Null when no snapshot yields probabilities.
 */
export function consensus(snapshots: OddsSnapshot[]): {
  red: number;
  blue: number;
  spread: { red: [number, number]; blue: [number, number] };
  markets: number;
} | null {
  const perMarket = snapshots
    .map((snapshot) => marketProbabilities(snapshot))
    .filter((probs): probs is { red: number; blue: number } => probs !== null);

  if (perMarket.length === 0) {
    return null;
  }

  const redValues = perMarket.map((probs) => probs.red);
  const blueValues = perMarket.map((probs) => probs.blue);

  const avg = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    red: avg(redValues),
    blue: avg(blueValues),
    spread: {
      red: [Math.min(...redValues), Math.max(...redValues)],
      blue: [Math.min(...blueValues), Math.max(...blueValues)],
    },
    markets: perMarket.length,
  };
}
