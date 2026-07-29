/**
 * Odds-API.io upcoming-fight discovery.
 *
 * Verified live 2026-07-29 against `GET api.odds-api.io/v3/events?sport=
 * mixed-martial-arts` and `GET api.odds-api.io/v3/odds?eventId=…&bookmakers=…`
 * (both HTTP 200).
 *
 * Two things about this API drive the shape of this module:
 *
 * 1. Discovery is one cheap call for every MMA fight across every promotion,
 *    but *prices* are one call per fight. The plan's rate limit is 100
 *    requests/hour (`x-ratelimit-limit`), so the sync must not walk every
 *    fight it can see. `maxPricedEvents` caps how many get priced, and events
 *    are prioritized by start time so the nearest card is always covered.
 *
 * 2. Bookmaker names are case-sensitive *display* names ("Bet365",
 *    "DraftKings"), not slugs. Sending "bet365" fails the whole request with
 *    `"bet365 is not a valid bookmaker"` rather than degrading, so the
 *    configured names are sent verbatim and only compared case-insensitively.
 *
 * Fighter names arrive surname-first ("de la Rosa, Montana"); the shared
 * matcher's token sorting handles that without special-casing here.
 */

import {
  fetchProviderJson,
  type UpcomingFetchOptions,
  type UpcomingOddsProvider,
  type UpcomingProviderMarket,
  type UpcomingQuote,
} from "./types.ts";
import { decimalToAmerican } from "../oddsApiIo.ts";

const ODDS_API_IO_BASE = "https://api.odds-api.io/v3";

export const ODDS_API_IO_SPORT_SLUG = "mixed-martial-arts";

/** Default cap on priced events per sync, well under the 100/hour limit. */
export const DEFAULT_MAX_PRICED_EVENTS = 20;

export interface OddsApiIoUpcomingOptions extends UpcomingFetchOptions {
  apiKey: string;
  /** Bookmaker display names, sent verbatim (case-sensitive upstream). */
  bookmakers: readonly string[];
  maxPricedEvents?: number;
  /** Only price fights whose league name matches, e.g. /ufc/i. */
  leaguePattern?: RegExp;
}

export function buildOddsApiIoEventsUrl(apiKey: string): string {
  const url = new URL(`${ODDS_API_IO_BASE}/events`);
  url.searchParams.set("sport", ODDS_API_IO_SPORT_SLUG);
  url.searchParams.set("apiKey", apiKey);
  return url.toString();
}

export function buildOddsApiIoOddsUrl(
  apiKey: string,
  eventId: string,
  bookmakers: readonly string[],
): string {
  const url = new URL(`${ODDS_API_IO_BASE}/odds`);
  url.searchParams.set("eventId", eventId);
  url.searchParams.set("bookmakers", bookmakers.join(","));
  url.searchParams.set("apiKey", apiKey);
  return url.toString();
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export interface OddsApiIoUpcomingEvent {
  eventId: string;
  firstFighter: string;
  secondFighter: string;
  startsAt?: string;
  leagueName?: string;
  promotion?: string;
}

/**
 * The promotion slug for a league name like "UFC - UFC Fight Night: Medic vs.
 * Rodriguez". Everything before the first " - " is the promotion.
 */
export function oddsApiIoPromotion(
  leagueName: string | undefined,
): string | undefined {
  if (leagueName === undefined) return undefined;
  const head = leagueName.split(" - ")[0]?.trim();
  return head === undefined || head.length === 0
    ? undefined
    : head.toLocaleLowerCase("en-US");
}

/** Normalizes the flat `/events` array. Each element is one bout. */
export function parseOddsApiIoUpcomingEvents(
  payload: unknown,
): OddsApiIoUpcomingEvent[] {
  if (!Array.isArray(payload)) {
    throw new TypeError("Odds-API.io /events response was not an array");
  }

  return payload.flatMap((raw): OddsApiIoUpcomingEvent[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const event = raw as Record<string, unknown>;
    const id =
      typeof event.id === "number" ? String(event.id) : readString(event.id);
    const home = readString(event.home);
    const away = readString(event.away);
    if (id === undefined || home === undefined || away === undefined) return [];

    const league = (event.league ?? {}) as Record<string, unknown>;
    const leagueName = readString(league.name);
    const promotion = oddsApiIoPromotion(leagueName);

    return [
      {
        eventId: id,
        firstFighter: home,
        secondFighter: away,
        ...(readString(event.date) === undefined
          ? {}
          : { startsAt: readString(event.date) as string }),
        ...(leagueName === undefined ? {} : { leagueName }),
        ...(promotion === undefined ? {} : { promotion }),
      },
    ];
  });
}

/**
 * Normalizes one `/odds` response into quotes.
 *
 * `bookmakers` is an object keyed by display name; each entry's "ML" market
 * carries a single positional `{ home, away }` pair of decimal strings.
 * Implied probability is taken straight from the decimal rather than round-
 * tripping through American, which would round twice.
 */
export function parseOddsApiIoUpcomingOdds(payload: unknown): {
  quotes: UpcomingQuote[];
  marketUpdatedAt?: string;
} {
  if (typeof payload !== "object" || payload === null) {
    throw new TypeError("Odds-API.io /odds response was not a JSON object");
  }
  const books = (payload as Record<string, unknown>).bookmakers;
  if (typeof books !== "object" || books === null) return { quotes: [] };

  const quotes: UpcomingQuote[] = [];
  let marketUpdatedAt: string | undefined;

  for (const [bookName, markets] of Object.entries(
    books as Record<string, unknown>,
  )) {
    if (!Array.isArray(markets)) continue;
    const moneyline = markets.find(
      (market: unknown) =>
        typeof market === "object" &&
        market !== null &&
        readString(
          (market as Record<string, unknown>).name,
        )?.toUpperCase() === "ML",
    ) as Record<string, unknown> | undefined;
    if (moneyline === undefined) continue;

    const entries = moneyline.odds;
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const entry = entries[0] as { home?: unknown; away?: unknown };

    const updatedAt = readString(moneyline.updatedAt);
    if (
      updatedAt !== undefined &&
      (marketUpdatedAt === undefined || updatedAt > marketUpdatedAt)
    ) {
      marketUpdatedAt = updatedAt;
    }

    for (const [side, key] of [
      ["first", "home"],
      ["second", "away"],
    ] as const) {
      const decimal = Number(entry[key]);
      const american = decimalToAmerican(decimal);
      if (american === null) continue;
      quotes.push({
        side,
        native: {
          kind: "american-moneyline",
          moneyline: american,
          book: bookName.toLocaleLowerCase("en-US"),
        },
        impliedProbability: 1 / decimal,
      });
    }
  }

  return {
    quotes,
    ...(marketUpdatedAt === undefined ? {} : { marketUpdatedAt }),
  };
}

/**
 * Chooses which discovered events are worth a priced request. Nearest start
 * time first, filtered to the wanted promotion, capped at `limit` — this is
 * the whole quota-protection story for discovery, and it is deliberately a
 * pure function so the cap is testable without touching the network.
 */
export function selectPricedEvents(
  events: readonly OddsApiIoUpcomingEvent[],
  limit: number,
  leaguePattern?: RegExp,
): OddsApiIoUpcomingEvent[] {
  return events
    .filter(
      (event) =>
        leaguePattern === undefined ||
        leaguePattern.test(event.leagueName ?? ""),
    )
    .slice()
    .sort((left, right) =>
      (left.startsAt ?? "").localeCompare(right.startsAt ?? ""),
    )
    .slice(0, Math.max(0, limit));
}

export function createOddsApiIoUpcomingProvider(
  options: OddsApiIoUpcomingOptions,
): UpcomingOddsProvider {
  return {
    id: "odds-api-io",
    async listMarkets(): Promise<UpcomingProviderMarket[]> {
      const events = parseOddsApiIoUpcomingEvents(
        await fetchProviderJson(
          "odds-api-io",
          buildOddsApiIoEventsUrl(options.apiKey),
          options,
        ),
      );

      const priced = selectPricedEvents(
        events,
        options.maxPricedEvents ?? DEFAULT_MAX_PRICED_EVENTS,
        options.leaguePattern ?? /ufc/iu,
      );

      const markets: UpcomingProviderMarket[] = [];
      // Sequential on purpose: a burst of parallel requests is the fastest way
      // to trip the 100/hour limit and lose the rest of the sync.
      for (const event of priced) {
        const odds = await fetchProviderJson(
          "odds-api-io",
          buildOddsApiIoOddsUrl(
            options.apiKey,
            event.eventId,
            options.bookmakers,
          ),
          options,
        );
        const { quotes, marketUpdatedAt } = parseOddsApiIoUpcomingOdds(odds);
        markets.push({
          externalId: event.eventId,
          firstFighter: event.firstFighter,
          secondFighter: event.secondFighter,
          ...(event.startsAt === undefined ? {} : { startsAt: event.startsAt }),
          ...(event.promotion === undefined
            ? {}
            : { promotion: event.promotion }),
          ...(event.leagueName === undefined
            ? {}
            : { eventName: event.leagueName }),
          ...(marketUpdatedAt === undefined ? {} : { marketUpdatedAt }),
          quotes,
        });
      }

      return markets;
    },
  };
}
