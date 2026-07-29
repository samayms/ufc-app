/**
 * Kalshi upcoming-fight discovery.
 *
 * Verified live 2026-07-29 against
 * `GET api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXUFCFIGHT
 * &status=open&with_nested_markets=true` (HTTP 200, no auth — public market
 * data reads are unauthenticated; kalshiAuth.ts covers the endpoints that
 * aren't).
 *
 * One Kalshi *event* is one fight, carrying exactly two binary markets — one
 * per fighter, each priced in dollars-as-strings. The fighter's name lives in
 * `yes_sub_title`, and `occurrence_datetime` is the scheduled fight time. The
 * event ticker (`KXUFCFIGHT-26AUG01REBPRE`) is the stable id we map to an ESPN
 * bout; the per-fighter market tickers are what the live WebSocket subscribes
 * to, so both are carried.
 *
 * Kalshi data is licensed for personal use only and is never redisplayed
 * publicly.
 */

import {
  fetchProviderJson,
  type UpcomingFetchOptions,
  type UpcomingOddsProvider,
  type UpcomingProviderMarket,
  type UpcomingQuote,
} from "./types.ts";

export const KALSHI_UFC_SERIES_TICKER = "KXUFCFIGHT";

const KALSHI_EVENTS_URL =
  "https://api.elections.kalshi.com/trade-api/v2/events";

export function buildKalshiUpcomingUrl(limit = 200): string {
  const url = new URL(KALSHI_EVENTS_URL);
  url.searchParams.set("series_ticker", KALSHI_UFC_SERIES_TICKER);
  url.searchParams.set("status", "open");
  url.searchParams.set("with_nested_markets", "true");
  url.searchParams.set("limit", String(limit));
  return url.toString();
}

/** "0.6300" -> 63 cents. Returns null for absent or unparseable prices. */
function dollarsToCents(value: unknown): number | null {
  const parsed =
    typeof value === "string"
      ? Number(value)
      : typeof value === "number"
        ? value
        : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 100 * 1e6) / 1e6;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

interface KalshiMarketRow {
  ticker: string;
  fighter: string;
  yesCents: number | null;
  occurrenceDatetime?: string;
  status?: string;
}

function parseMarketRow(raw: unknown): KalshiMarketRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const market = raw as Record<string, unknown>;
  const ticker = readString(market.ticker);
  // `yes_sub_title` is the fighter the YES side pays out on. Without it the
  // market cannot be attributed to a fighter, so it is not usable.
  const fighter = readString(market.yes_sub_title);
  if (ticker === undefined || fighter === undefined) return null;

  const bid = dollarsToCents(market.yes_bid_dollars);
  const ask = dollarsToCents(market.yes_ask_dollars);
  const mid =
    bid !== null && ask !== null
      ? Math.round(((bid + ask) / 2) * 1e6) / 1e6
      : dollarsToCents(market.last_price_dollars);

  return {
    ticker,
    fighter,
    yesCents: mid,
    ...(readString(market.occurrence_datetime) === undefined
      ? {}
      : { occurrenceDatetime: readString(market.occurrence_datetime) as string }),
    ...(readString(market.status) === undefined
      ? {}
      : { status: readString(market.status) as string }),
  };
}

/**
 * Normalizes the `/events` envelope into one market per fight.
 *
 * Events that do not carry exactly two attributable fighter markets are
 * dropped rather than guessed at — a three-way or partially-listed fight has
 * no unambiguous red/blue pair, and attaching a wrong price is worse than
 * showing "not listed".
 */
export function parseKalshiUpcomingMarkets(
  payload: unknown,
): UpcomingProviderMarket[] {
  if (typeof payload !== "object" || payload === null) {
    throw new TypeError("Kalshi events response was not a JSON object");
  }
  const events = (payload as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];

  return events.flatMap((raw): UpcomingProviderMarket[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const event = raw as Record<string, unknown>;
    const eventTicker = readString(event.event_ticker);
    if (eventTicker === undefined) return [];

    const rows = Array.isArray(event.markets)
      ? event.markets.flatMap((market) => {
          const parsed = parseMarketRow(market);
          return parsed === null ? [] : [parsed];
        })
      : [];
    if (rows.length !== 2) return [];

    const [first, second] = rows as [KalshiMarketRow, KalshiMarketRow];
    const quotes: UpcomingQuote[] = [];
    for (const [side, row] of [
      ["first", first],
      ["second", second],
    ] as const) {
      if (row.yesCents === null) continue;
      quotes.push({
        side,
        native: {
          kind: "kalshi-cents",
          yesCents: row.yesCents,
          noCents: Math.round((100 - row.yesCents) * 1e6) / 1e6,
        },
        impliedProbability: row.yesCents / 100,
      });
    }

    const startsAt = first.occurrenceDatetime ?? second.occurrenceDatetime;
    return [
      {
        externalId: eventTicker,
        firstFighter: first.fighter,
        secondFighter: second.fighter,
        ...(startsAt === undefined ? {} : { startsAt }),
        promotion: "ufc",
        ...(readString(event.title) === undefined
          ? {}
          : { eventName: readString(event.title) as string }),
        quotes,
      },
    ];
  });
}

/**
 * The per-fighter market tickers behind one discovered Kalshi fight, ordered
 * to match `firstFighter`/`secondFighter`. The live WebSocket subscribes to
 * these, not to the event ticker, so the sync persists them alongside the
 * mapping.
 */
export function kalshiMarketTickers(payload: unknown): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (typeof payload !== "object" || payload === null) return result;
  const events = (payload as { events?: unknown }).events;
  if (!Array.isArray(events)) return result;

  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) continue;
    const event = raw as Record<string, unknown>;
    const eventTicker = readString(event.event_ticker);
    if (eventTicker === undefined || !Array.isArray(event.markets)) continue;
    const tickers = event.markets.flatMap((market) => {
      const parsed = parseMarketRow(market);
      return parsed === null ? [] : [parsed.ticker];
    });
    if (tickers.length === 2) result.set(eventTicker, tickers);
  }
  return result;
}

export function createKalshiUpcomingProvider(
  options: UpcomingFetchOptions = {},
): UpcomingOddsProvider & {
  lastMarketTickers(): Map<string, string[]>;
} {
  let tickers = new Map<string, string[]>();
  return {
    id: "kalshi",
    async listMarkets() {
      const payload = await fetchProviderJson(
        "kalshi",
        buildKalshiUpcomingUrl(),
        options,
      );
      tickers = kalshiMarketTickers(payload);
      return parseKalshiUpcomingMarkets(payload);
    },
    lastMarketTickers: () => tickers,
  };
}
