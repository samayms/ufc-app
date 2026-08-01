/**
 * The one shape every provider reduces to before matching.
 *
 * Discovery is deliberately separate from the live-fight clients in
 * `src/sources/*.ts`. Those clients answer "what is this *known* bout priced
 * at right now" and are built around a resolved `Bout`. Upcoming odds ask the
 * opposite question — "what fights does this provider even list?" — and must
 * work before any bout id exists. Keeping them apart is what lets the sync run
 * as a one-shot script with no collector, no event, and no mappings loaded.
 *
 * Providers report a fighter *pair*, not corners: none of them share ESPN's
 * red/blue assignment. `firstFighter`/`secondFighter` are whatever order the
 * provider used, and the shared matcher decides whether they need flipping.
 */

import type { NativePrice } from "../../schema.ts";

export type UpcomingProviderId =
  | "kalshi"
  | "polymarket"
  | "odds-api-io"
  | "odds-api";

export const UPCOMING_PROVIDER_IDS: readonly UpcomingProviderId[] = [
  "kalshi",
  "polymarket",
  "odds-api-io",
  "odds-api",
];

export const UPCOMING_PROVIDER_LABEL: Record<UpcomingProviderId, string> = {
  kalshi: "Kalshi",
  polymarket: "Polymarket",
  "odds-api-io": "Odds-API.io",
  "odds-api": "The Odds API",
};

/** Which of the provider's two listed fighters a price belongs to. */
export type ProviderSide = "first" | "second";

export interface UpcomingQuote {
  side: ProviderSide;
  native: NativePrice;
  /** Mechanically converted from `native`; still carries vig for sportsbooks. */
  impliedProbability: number;
}

/** Optional provider-native context captured alongside the win market. */
export interface UpcomingMarketMetadata {
  /** Kalshi volume, Polymarket volume, or another provider's total volume. */
  volume?: number;
  /** Polymarket's 24-hour volume. */
  volume24hr?: number;
  /** Polymarket liquidity. */
  liquidity?: number;
  /** Kalshi open interest. */
  openInterest?: number;
  /** Number of sportsbook books quoting the win market. */
  bookmakerCount?: number;
}

/** A normalized binary fight-distance market: YES means decision. */
export interface UpcomingDecisionMarket {
  externalId: string;
  decisionProbability: number;
  finishProbability: number;
  marketUpdatedAt?: string;
}

export interface UpcomingProviderMarket {
  /** Provider-native id: Kalshi event ticker, Polymarket condition id, … */
  externalId: string;
  /**
   * Provider-native stream ids ordered as `firstFighter`/`secondFighter`.
   * Present only for sources whose live transport subscribes per outcome.
   */
  streamIds?: readonly [string, string];
  firstFighter: string;
  secondFighter: string;
  /** ISO 8601 scheduled start, when the provider publishes one. */
  startsAt?: string;
  /** Free-text weight class when the provider names one. */
  weightClass?: string;
  /** Lowercase promotion slug, e.g. "ufc". Absent when unknowable. */
  promotion?: string;
  /** Provider's own name for the card, for review output. */
  eventName?: string;
  /** When the provider says the price last moved. */
  marketUpdatedAt?: string;
  quotes: UpcomingQuote[];
  /** Optional metadata for the provider's existing win market. */
  metadata?: UpcomingMarketMetadata;
  /** Optional fight-level decision market discovered with this win market. */
  decision?: UpcomingDecisionMarket;
}

/**
 * A provider's whole upcoming surface. `listMarkets` returning `[]` is a
 * legitimate answer ("nothing listed yet"), never an error — the sync
 * distinguishes the two, and only a thrown error becomes `provider_error`.
 */
export interface UpcomingOddsProvider {
  readonly id: UpcomingProviderId;
  listMarkets(): Promise<UpcomingProviderMarket[]>;
}

export interface UpcomingFetchOptions {
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Providers must never hang the whole sync. */
  timeoutMs?: number;
}

export const DEFAULT_UPCOMING_TIMEOUT_MS = 15_000;

/** Cap on a discovery response body, so a hostile payload can't exhaust memory. */
export const MAX_DISCOVERY_BYTES = 12 * 1024 * 1024;

export class UpcomingProviderError extends Error {
  readonly provider: UpcomingProviderId;

  readonly status?: number;

  constructor(
    provider: UpcomingProviderId,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "UpcomingProviderError";
    this.provider = provider;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Shared JSON GET with a timeout and a size cap. Every provider goes through
 * it so one provider's slow endpoint cannot stall the twice-daily sync, and so
 * no provider accidentally grows its own error vocabulary.
 */
export async function fetchProviderJson(
  provider: UpcomingProviderId,
  url: string,
  options: UpcomingFetchOptions = {},
  init?: RequestInit,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPCOMING_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      headers: { accept: "application/json", ...init?.headers },
    });
    if (!response.ok) {
      throw new UpcomingProviderError(
        provider,
        `HTTP ${response.status} from ${redactUrl(url)}`,
        response.status,
      );
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_DISCOVERY_BYTES) {
      throw new UpcomingProviderError(
        provider,
        "discovery response exceeded the maximum allowed size",
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new UpcomingProviderError(
        provider,
        `response from ${redactUrl(url)} was not JSON`,
      );
    }
  } catch (error) {
    if (error instanceof UpcomingProviderError) throw error;
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? `timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new UpcomingProviderError(
      provider,
      `${redactUrl(url)} failed: ${reason}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Strips query values from a URL before it can reach a log, a persisted
 * snapshot, or a test transcript. Odds-API.io and The Odds API both carry the
 * API key in the query string, so the raw URL must never be stringified into
 * an error message.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const keys = [...parsed.searchParams.keys()];
    for (const key of keys) parsed.searchParams.set(key, "…");
    return parsed.toString();
  } catch {
    return "<invalid url>";
  }
}
