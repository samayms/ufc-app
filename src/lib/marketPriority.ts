import { isEventDay } from "./eventIdentity.ts";
import type { OddsSnapshot } from "../schema.ts";

/** Below this trading volume, Kalshi/Polymarket defer to sportsbook odds. */
export const MARKET_PRIORITY_VOLUME_THRESHOLD = 1000;

/**
 * Picks which market's odds to show when only one source can be shown at
 * once. Kalshi and Polymarket only outrank sportsbook odds once their
 * volume clears the threshold — thin markets are noisy, and de-vigged
 * sportsbook lines are the steadier read. If sportsbook data is also
 * unavailable, a thin Kalshi/Polymarket market still beats showing nothing.
 */
export function pickPriorityMarket(
  latestOdds: Partial<Record<OddsSnapshot["market"], OddsSnapshot>>,
  threshold: number = MARKET_PRIORITY_VOLUME_THRESHOLD,
): OddsSnapshot | null {
  const kalshi = latestOdds.kalshi;
  const polymarket = latestOdds.polymarket;
  if (kalshi !== undefined && (kalshi.volume ?? 0) >= threshold) return kalshi;
  if (polymarket !== undefined && (polymarket.volume ?? 0) >= threshold) {
    return polymarket;
  }
  return latestOdds.sportsbook ?? kalshi ?? polymarket ?? null;
}

/**
 * The Odds API ("sportsbook") only ever collects twice daily — on the
 * event's calendar day it stops updating, so the UI stops showing it
 * rather than displaying an increasingly stale price as though it were
 * current. Kalshi/Polymarket/Odds-API.io are unaffected.
 */
export function withoutSportsbookOnEventDay<
  T extends Partial<Record<OddsSnapshot["market"], OddsSnapshot>>,
>(odds: T, eventStartsAt: string, now: number = Date.now()): T {
  if (!isEventDay(eventStartsAt, now)) return odds;
  const { sportsbook: _sportsbook, ...rest } = odds;
  return rest as T;
}
