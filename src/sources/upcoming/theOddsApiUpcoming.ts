/**
 * The Odds API upcoming-fight discovery.
 *
 * Verified live 2026-07-29 against
 * `GET api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds
 * ?regions=us&markets=h2h&oddsFormat=american` (HTTP 200).
 *
 * One request returns every upcoming MMA event across every promotion with all
 * its books attached, so discovery costs exactly one quota unit per sync —
 * which matters, because the account's plan allows 500 requests a *month*. The
 * response carries no promotion field (`sport_title` is just "MMA"), so
 * `promotion` is left undefined here and the shared matcher falls back to
 * fighter names plus the event-date window. Bellator and PFL fights therefore
 * appear in the candidate pool and are rejected on names, not on a label.
 *
 * The remaining-quota header is surfaced so the sync can record it and back
 * off before the plan is exhausted.
 */

import { americanToImpliedProb } from "../../lib/oddsMath.ts";
import {
  DEFAULT_UPCOMING_TIMEOUT_MS,
  redactUrl,
  UpcomingProviderError,
  type UpcomingFetchOptions,
  type UpcomingOddsProvider,
  type UpcomingProviderMarket,
  type UpcomingQuote,
} from "./types.ts";

export const THE_ODDS_API_SPORT = "mma_mixed_martial_arts";

export interface TheOddsApiUpcomingOptions extends UpcomingFetchOptions {
  apiKey: string;
  regions?: string;
}

export function buildTheOddsApiUpcomingUrl(
  apiKey: string,
  regions = "us",
): string {
  const url = new URL(
    `https://api.the-odds-api.com/v4/sports/${THE_ODDS_API_SPORT}/odds`,
  );
  url.searchParams.set("regions", regions);
  url.searchParams.set("markets", "h2h");
  url.searchParams.set("oddsFormat", "american");
  url.searchParams.set("apiKey", apiKey);
  return url.toString();
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Normalizes a `/odds` array into one market per event.
 *
 * `home_team`/`away_team` set the pair order, and every book's h2h outcome is
 * attributed by name against those two. An outcome naming neither fighter (a
 * draw line, or a book listing a replacement) is dropped rather than assigned
 * to a side.
 */
export function parseTheOddsApiUpcomingMarkets(
  payload: unknown,
): UpcomingProviderMarket[] {
  if (!Array.isArray(payload)) {
    throw new TypeError("The Odds API response was not an array");
  }

  return payload.flatMap((raw): UpcomingProviderMarket[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const event = raw as Record<string, unknown>;
    const id = readString(event.id);
    const home = readString(event.home_team);
    const away = readString(event.away_team);
    if (id === undefined || home === undefined || away === undefined) return [];

    const quotes: UpcomingQuote[] = [];
    const updates: string[] = [];
    const bookmakers = Array.isArray(event.bookmakers) ? event.bookmakers : [];

    for (const rawBook of bookmakers) {
      if (typeof rawBook !== "object" || rawBook === null) continue;
      const book = rawBook as Record<string, unknown>;
      const bookKey = readString(book.key);
      if (bookKey === undefined) continue;
      const markets = Array.isArray(book.markets) ? book.markets : [];

      for (const rawMarket of markets) {
        if (typeof rawMarket !== "object" || rawMarket === null) continue;
        const market = rawMarket as Record<string, unknown>;
        if (readString(market.key) !== "h2h") continue;
        const lastUpdate = readString(market.last_update);
        if (lastUpdate !== undefined) updates.push(lastUpdate);

        const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
        for (const rawOutcome of outcomes) {
          if (typeof rawOutcome !== "object" || rawOutcome === null) continue;
          const outcome = rawOutcome as Record<string, unknown>;
          const name = readString(outcome.name);
          const price = outcome.price;
          if (
            name === undefined ||
            typeof price !== "number" ||
            !Number.isFinite(price) ||
            price === 0
          ) {
            continue;
          }
          const side =
            name === home ? "first" : name === away ? "second" : undefined;
          if (side === undefined) continue;

          quotes.push({
            side,
            native: {
              kind: "american-moneyline",
              moneyline: price,
              book: bookKey.toLocaleLowerCase("en-US"),
            },
            impliedProbability: americanToImpliedProb(price),
          });
        }
      }
    }

    const marketUpdatedAt = updates.sort().at(-1);
    return [
      {
        externalId: id,
        firstFighter: home,
        secondFighter: away,
        ...(readString(event.commence_time) === undefined
          ? {}
          : { startsAt: readString(event.commence_time) as string }),
        ...(marketUpdatedAt === undefined ? {} : { marketUpdatedAt }),
        quotes,
      },
    ];
  });
}

export interface TheOddsApiQuota {
  remaining?: number;
  used?: number;
}

export function createTheOddsApiUpcomingProvider(
  options: TheOddsApiUpcomingOptions,
): UpcomingOddsProvider & { lastQuota(): TheOddsApiQuota } {
  let quota: TheOddsApiQuota = {};

  return {
    id: "odds-api",
    async listMarkets() {
      if (options.apiKey.trim().length === 0) {
        throw new UpcomingProviderError(
          "odds-api",
          "live mode requires THE_ODDS_API_KEY",
        );
      }
      const url = buildTheOddsApiUpcomingUrl(
        options.apiKey,
        options.regions ?? "us",
      );
      const fetchImpl = options.fetchImpl ?? fetch;
      const timeoutMs = options.timeoutMs ?? DEFAULT_UPCOMING_TIMEOUT_MS;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        const remaining = Number(
          response.headers.get("x-requests-remaining") ?? "",
        );
        const used = Number(response.headers.get("x-requests-used") ?? "");
        quota = {
          ...(Number.isFinite(remaining) ? { remaining } : {}),
          ...(Number.isFinite(used) ? { used } : {}),
        };
        if (!response.ok) {
          throw new UpcomingProviderError(
            "odds-api",
            `HTTP ${response.status} from ${redactUrl(url)}`,
          );
        }
        return parseTheOddsApiUpcomingMarkets(
          (await response.json()) as unknown,
        );
      } catch (error) {
        if (error instanceof UpcomingProviderError) throw error;
        if (error instanceof TypeError) throw error;
        const reason =
          error instanceof Error && error.name === "AbortError"
            ? `timed out after ${timeoutMs}ms`
            : error instanceof Error
              ? error.message
              : String(error);
        throw new UpcomingProviderError(
          "odds-api",
          `${redactUrl(url)} failed: ${reason}`,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
    lastQuota: () => quota,
  };
}
