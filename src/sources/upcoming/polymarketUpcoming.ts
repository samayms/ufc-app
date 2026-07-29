/**
 * Polymarket upcoming-fight discovery via the Gamma API.
 *
 * Verified live 2026-07-29 against
 * `GET gamma-api.polymarket.com/events?closed=false&tag_slug=ufc&limit=200`
 * (HTTP 200, no auth).
 *
 * One Gamma *event* is one fight, titled
 * `UFC Fight Night: A vs. B (Weightclass, Segment)`, and carries a dozen prop
 * markets. Only one of them is the fight-winner market: the one whose
 * `question` repeats the event title and whose `outcomes` are the two fighter
 * names rather than Yes/No. Everything else ("Fight to Go the Distance?",
 * "Will the fight be won by KO or TKO?") is deliberately ignored — this
 * dashboard shows the moneyline, and a prop price attached to a fighter would
 * be actively misleading.
 *
 * `outcomes`, `outcomePrices` and `clobTokenIds` arrive as JSON-encoded
 * *strings* containing arrays, which is why each is parsed defensively.
 */

import {
  fetchProviderJson,
  type UpcomingFetchOptions,
  type UpcomingOddsProvider,
  type UpcomingProviderMarket,
  type UpcomingQuote,
} from "./types.ts";

const POLYMARKET_GAMMA_EVENTS_URL =
  "https://gamma-api.polymarket.com/events";

export function buildPolymarketUpcomingUrl(limit = 200): string {
  const url = new URL(POLYMARKET_GAMMA_EVENTS_URL);
  url.searchParams.set("closed", "false");
  url.searchParams.set("tag_slug", "ufc");
  url.searchParams.set("order", "startDate");
  url.searchParams.set("ascending", "true");
  url.searchParams.set("limit", String(limit));
  return url.toString();
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Gamma sends arrays as JSON strings; accept either form. */
function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function readNumber(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed)
    ? parsed
    : undefined;
}

/**
 * Pulls the weight class out of a Gamma title's trailing parenthetical,
 * e.g. "… (Welterweight, Main Card)" -> "Welterweight". Returns undefined
 * rather than guessing when the title has no parenthetical.
 */
export function polymarketTitleWeightClass(
  title: string,
): string | undefined {
  const match = title.match(/\(([^)]*)\)\s*$/u);
  const inside = match?.[1];
  if (inside === undefined) return undefined;
  const first = inside.split(",")[0]?.trim();
  return first !== undefined && first.length > 0 ? first : undefined;
}

/**
 * Mid of best bid/ask, falling back to the listed outcome price and then the
 * last trade. A price of exactly 0 or 1 is treated as no price: Gamma reports
 * an empty book that way and it would render as a fabricated certainty.
 */
function priceFor(
  market: Record<string, unknown>,
  index: number,
  outcomePrices: string[],
): number | undefined {
  if (index === 0) {
    const bid = readNumber(market.bestBid);
    const ask = readNumber(market.bestAsk);
    if (bid !== undefined && ask !== undefined && bid > 0 && ask < 1) {
      return (bid + ask) / 2;
    }
  }
  const listed = readNumber(outcomePrices[index]);
  if (listed !== undefined && listed > 0 && listed < 1) return listed;
  if (index === 0) {
    const last = readNumber(market.lastTradePrice);
    if (last !== undefined && last > 0 && last < 1) return last;
  }
  return undefined;
}

/**
 * True for the moneyline market. Gamma attaches a dozen prop markets to every
 * fight; the winner market is the only one whose outcomes are fighter names
 * rather than Yes/No.
 */
function isFightWinnerMarket(outcomes: string[]): boolean {
  if (outcomes.length !== 2) return false;
  const [first, second] = outcomes;
  if (first === undefined || second === undefined) return false;
  const yesNo = new Set(["yes", "no"]);
  return (
    !yesNo.has(first.toLocaleLowerCase("en-US")) &&
    !yesNo.has(second.toLocaleLowerCase("en-US"))
  );
}

/** Normalizes a Gamma `/events` array into one fight-winner market per fight. */
export function parsePolymarketUpcomingMarkets(
  payload: unknown,
): UpcomingProviderMarket[] {
  if (!Array.isArray(payload)) {
    throw new TypeError("Polymarket events response was not an array");
  }

  return payload.flatMap((raw): UpcomingProviderMarket[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const event = raw as Record<string, unknown>;
    if (event.closed === true) return [];

    const title = readString(event.title);
    const markets = Array.isArray(event.markets) ? event.markets : [];

    for (const rawMarket of markets) {
      if (typeof rawMarket !== "object" || rawMarket === null) continue;
      const market = rawMarket as Record<string, unknown>;
      if (market.closed === true) continue;

      const outcomes = readStringArray(market.outcomes);
      if (!isFightWinnerMarket(outcomes)) continue;

      const conditionId = readString(market.conditionId);
      if (conditionId === undefined) continue;

      const [first, second] = outcomes as [string, string];
      const outcomePrices = readStringArray(market.outcomePrices);
      const quotes: UpcomingQuote[] = [];
      for (const [side, index] of [
        ["first", 0],
        ["second", 1],
      ] as const) {
        const price = priceFor(market, index, outcomePrices);
        if (price === undefined) continue;
        quotes.push({
          side,
          native: { kind: "polymarket-price", price },
          impliedProbability: price,
        });
      }

      const weightClass =
        title === undefined ? undefined : polymarketTitleWeightClass(title);
      // Gamma's `startDate` is when the *market* was listed, not when the
      // fight happens — observed live at 13 days before the bout, which is far
      // outside the matcher's event-date window and rejected every Polymarket
      // market outright. `endDate` is the resolution deadline, which sits a
      // few hours after the fight and is the only date in the payload that
      // tracks it.
      const startsAt =
        readString(market.endDateIso) ??
        readString(market.endDate) ??
        readString(event.endDate);

      return [
        {
          externalId: conditionId,
          firstFighter: first,
          secondFighter: second,
          ...(startsAt === undefined ? {} : { startsAt }),
          ...(weightClass === undefined ? {} : { weightClass }),
          promotion: "ufc",
          ...(title === undefined ? {} : { eventName: title }),
          ...(readString(market.updatedAt) === undefined
            ? {}
            : { marketUpdatedAt: readString(market.updatedAt) as string }),
          quotes,
        },
      ];
    }

    return [];
  });
}

/**
 * CLOB outcome-token ids per condition id, ordered to match
 * `firstFighter`/`secondFighter`. The live WebSocket subscribes to these
 * tokens, so the sync persists them with the mapping.
 */
export function polymarketOutcomeTokens(
  payload: unknown,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!Array.isArray(payload)) return result;

  for (const raw of payload) {
    if (typeof raw !== "object" || raw === null) continue;
    const markets = (raw as Record<string, unknown>).markets;
    if (!Array.isArray(markets)) continue;
    for (const rawMarket of markets) {
      if (typeof rawMarket !== "object" || rawMarket === null) continue;
      const market = rawMarket as Record<string, unknown>;
      const outcomes = readStringArray(market.outcomes);
      if (!isFightWinnerMarket(outcomes)) continue;
      const conditionId = readString(market.conditionId);
      const tokens = readStringArray(market.clobTokenIds);
      if (conditionId !== undefined && tokens.length === 2) {
        result.set(conditionId, tokens);
      }
      break;
    }
  }
  return result;
}

export function createPolymarketUpcomingProvider(
  options: UpcomingFetchOptions = {},
): UpcomingOddsProvider & { lastOutcomeTokens(): Map<string, string[]> } {
  let tokens = new Map<string, string[]>();
  return {
    id: "polymarket",
    async listMarkets() {
      const payload = await fetchProviderJson(
        "polymarket",
        buildPolymarketUpcomingUrl(),
        options,
      );
      tokens = polymarketOutcomeTokens(payload);
      return parsePolymarketUpcomingMarkets(payload);
    },
    lastOutcomeTokens: () => tokens,
  };
}
