/**
 * The upcoming-odds sync: ESPN card in, one reviewable document out.
 *
 * ```
 *   ESPN upcoming bouts ─┐
 *   Kalshi markets ──────┤
 *   Polymarket markets ──┼─> shared matcher ─> persist ─> /api/upcoming-odds ─> UI
 *   Odds-API.io odds ────┤
 *   The Odds API odds ───┘
 * ```
 *
 * Three properties this is built around:
 *
 * 1. **One provider's failure is not the sync's failure.** Providers run
 *    independently and a thrown error becomes `provider_error` on that
 *    provider's entries only. The sync always produces a document and always
 *    exits 0 unless it could not read ESPN at all.
 *
 * 2. **An empty result is a result.** A provider that answers with no market
 *    for a fight yields `not_listed`, which is different from having failed.
 *    Only an empty *response* (or an outright failure) falls back to the
 *    previously persisted snapshot.
 *
 * 3. **Odds are never attached on a guess.** Everything goes through
 *    `matchBout`; ambiguity is recorded as `unmatched` with the candidates
 *    that caused it, so the owner can pin a manual override and re-run.
 *
 * Nothing here opens a WebSocket. Streams belong to the live collector during
 * an active fight; a twice-daily one-shot must exit cleanly.
 */

import {
  matchBout,
  type MatchableBout,
} from "../src/lib/boutMatch.ts";
import {
  emptyUpcomingOddsDocument,
  type UpcomingBoutOdds,
  type UpcomingDecisionOdds,
  type UpcomingEventOdds,
  type UpcomingOddsDocument,
  type UpcomingProviderEntry,
  type UpcomingProviderRun,
  type UpcomingUnmatchedMarket,
} from "../src/lib/upcomingOdds.ts";
import type {
  UpcomingOddsProvider,
  UpcomingProviderId,
  UpcomingProviderMarket,
} from "../src/sources/upcoming/types.ts";
import type { Corner, OddsQuote, OddsSnapshot } from "../src/schema.ts";

/** One ESPN card, flattened to what matching actually needs. */
export interface UpcomingCard {
  espnEventId: string;
  name: string;
  startsAt?: string;
  bouts: UpcomingCardBout[];
}

export interface UpcomingCardBout {
  boutId: string;
  redFighter: string;
  blueFighter: string;
  weightClassLabel?: string;
  startsAt?: string;
  titleFight?: boolean;
}

/** Pin one provider market to one ESPN bout, bypassing name scoring. */
export interface UpcomingMappingOverride {
  provider: UpcomingProviderId;
  externalId: string;
  boutId: string;
}

export interface SyncUpcomingOddsOptions {
  cards: readonly UpcomingCard[];
  providers: readonly UpcomingOddsProvider[];
  /** The document from the previous run, for last-valid preservation. */
  previous?: UpcomingOddsDocument | null;
  overrides?: readonly UpcomingMappingOverride[];
  synthetic?: boolean;
  now?: () => Date;
  /** Per-provider progress, for the CLI's operator output. */
  onProviderResult?: (
    provider: UpcomingProviderId,
    run: UpcomingProviderRun,
  ) => void;
}

interface ProviderOutcome {
  markets: UpcomingProviderMarket[];
  error?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runProvider(
  provider: UpcomingOddsProvider,
): Promise<ProviderOutcome> {
  try {
    const markets = await provider.listMarkets();
    return { markets };
  } catch (error) {
    return { markets: [], error: messageOf(error) };
  }
}

/**
 * Converts a provider's side-keyed quotes into corner-keyed ones. When the
 * matcher reports reversed corners, `first` is the *blue* fighter — this is
 * the single place that flip happens, so a provider listing the underdog
 * first can never invert a price.
 */
export function providerQuotesToCorners(
  market: UpcomingProviderMarket,
  cornersReversed: boolean,
): OddsQuote[] {
  return market.quotes.map((quote) => {
    const corner: Corner =
      quote.side === "first"
        ? cornersReversed
          ? "blue"
          : "red"
        : cornersReversed
          ? "red"
          : "blue";
    return {
      corner,
      native: quote.native,
      impliedProbability: quote.impliedProbability,
    };
  });
}

const SNAPSHOT_MARKET: Record<
  UpcomingProviderId,
  OddsSnapshot["market"]
> = {
  kalshi: "kalshi",
  polymarket: "polymarket",
  "odds-api-io": "sportsbook",
  "odds-api": "sportsbook",
};

const DECISION_PROVIDER_ORDER = [
  "kalshi",
  "polymarket",
  "odds-api-io",
] as const;

/** Maximum combined implied probability accepted from Polymarket (110%). */
export const POLYMARKET_MAX_IMPLIED_SUM = 1.1;

function toSnapshot(
  provider: UpcomingProviderId,
  boutId: string,
  market: UpcomingProviderMarket,
  cornersReversed: boolean,
  fetchedAt: string,
  synthetic: boolean,
): OddsSnapshot {
  return {
    boutId,
    market: SNAPSHOT_MARKET[provider],
    quotes: providerQuotesToCorners(market, cornersReversed),
    ...(market.marketUpdatedAt === undefined
      ? {}
      : { marketUpdatedAt: market.marketUpdatedAt }),
    ...(market.metadata?.volume === undefined
      ? {}
      : { volume: market.metadata.volume }),
    provenance: {
      source: provider === "odds-api" ? "odds-api" : provider,
      fetchedAt,
      synthetic,
    },
  };
}

function cardToMatchable(card: UpcomingCard): MatchableBout[] {
  return card.bouts.map((bout) => ({
    boutId: bout.boutId,
    redFighter: bout.redFighter,
    blueFighter: bout.blueFighter,
    ...(bout.startsAt ?? card.startsAt
      ? { startsAt: (bout.startsAt ?? card.startsAt) as string }
      : {}),
    ...(bout.weightClassLabel === undefined
      ? {}
      : { weightClass: bout.weightClassLabel }),
    promotion: "ufc",
  }));
}

function previousEntry(
  previous: UpcomingOddsDocument | null | undefined,
  boutId: string,
  provider: UpcomingProviderId,
): UpcomingProviderEntry | undefined {
  if (previous === null || previous === undefined) return undefined;
  for (const event of previous.events) {
    for (const bout of event.bouts) {
      if (bout.boutId !== boutId) continue;
      return bout.providers[provider];
    }
  }
  return undefined;
}

/**
 * Retains a previously loaded price when the current run produced nothing
 * usable. `preserved` marks it so the UI can say the number is real but not
 * from this run; `fetchedAt` stays at the last *successful* fetch so the
 * derived staleness reflects the price's real age.
 */
function preserveOrDefault(
  previous: UpcomingProviderEntry | undefined,
  fallback: UpcomingProviderEntry,
): UpcomingProviderEntry {
  if (previous?.status !== "loaded" || previous.snapshot === undefined) {
    return fallback;
  }
  return {
    ...previous,
    preserved: true,
    ...(fallback.message === undefined ? {} : { message: fallback.message }),
  };
}

function resolveDecision(
  boutId: string,
  fetchedAt: string,
  synthetic: boolean,
  outcomes: ReadonlyMap<UpcomingProviderId, ProviderOutcome>,
  attachments: ReadonlyMap<
    string,
    { market: UpcomingProviderMarket; cornersReversed: boolean; confidence: number }
  >,
): UpcomingDecisionOdds {
  let providerError: string | undefined;

  for (const providerId of DECISION_PROVIDER_ORDER) {
    const outcome = outcomes.get(providerId);
    if (outcome?.error !== undefined) {
      providerError ??= outcome.error;
      continue;
    }

    const attachment = attachments.get(`${providerId}\u0000${boutId}`);
    const decision = attachment?.market.decision;
    if (attachment === undefined || decision === undefined) continue;

    if (providerId === "polymarket") {
      const impliedValues = attachment.market.quotes.map(
        (quote) => quote.impliedProbability,
      );
      const impliedSum = impliedValues.reduce((sum, value) => sum + value, 0);
      if (
        impliedValues.length !== 2 ||
        impliedValues.some((value) => !Number.isFinite(value)) ||
        impliedSum >= POLYMARKET_MAX_IMPLIED_SUM
      ) {
        continue;
      }
    }

    return {
      state: "loaded",
      decisionProbability: decision.decisionProbability,
      finishProbability: decision.finishProbability,
      source: providerId,
      fetchedAt,
      synthetic,
      ...(decision.marketUpdatedAt === undefined
        ? {}
        : { updatedAt: decision.marketUpdatedAt }),
      externalId: decision.externalId,
    };
  }

  return {
    state: providerError === undefined ? "not_listed" : "provider_error",
    fetchedAt,
    synthetic,
    ...(providerError === undefined ? {} : { message: providerError }),
  };
}

export async function syncUpcomingOdds(
  options: SyncUpcomingOddsOptions,
): Promise<UpcomingOddsDocument> {
  const now = options.now ?? (() => new Date());
  const synthetic = options.synthetic ?? false;
  const generatedAt = now().toISOString();
  const document = emptyUpcomingOddsDocument(generatedAt, synthetic);

  const outcomes = new Map<UpcomingProviderId, ProviderOutcome>();
  // Providers are independent, so they run concurrently; each one's failure is
  // captured inside runProvider and can never reject the whole batch.
  const results = await Promise.all(
    options.providers.map(async (provider) => ({
      id: provider.id,
      outcome: await runProvider(provider),
    })),
  );
  for (const { id, outcome } of results) outcomes.set(id, outcome);

  const overrideIndex = new Map<string, string>();
  for (const override of options.overrides ?? []) {
    overrideIndex.set(
      `${override.provider} ${override.externalId}`,
      override.boutId,
    );
  }

  const matchedCounts = new Map<UpcomingProviderId, number>();

  for (const card of options.cards) {
    const matchable = cardToMatchable(card);
    // Provider market -> the bout it matched on this card.
    const attachments = new Map<
      string,
      { market: UpcomingProviderMarket; cornersReversed: boolean; confidence: number }
    >();

    for (const [providerId, outcome] of outcomes) {
      for (const market of outcome.markets) {
        const overrideBoutId = overrideIndex.get(
          `${providerId} ${market.externalId}`,
        );
        const result = matchBout(
          matchable,
          {
            redFighter: market.firstFighter,
            blueFighter: market.secondFighter,
            ...(market.startsAt === undefined
              ? {}
              : { startsAt: market.startsAt }),
            ...(market.weightClass === undefined
              ? {}
              : { weightClass: market.weightClass }),
            ...(market.promotion === undefined
              ? {}
              : { promotion: market.promotion }),
          },
          overrideBoutId === undefined ? {} : { overrideBoutId },
        );

        if (result.status === "matched") {
          const key = `${providerId} ${result.boutId}`;
          const existing = attachments.get(key);
          // Two provider markets can plausibly hit the same bout (a relisted
          // fight). Keep the more confident one rather than the later one.
          if (
            existing === undefined ||
            result.confidence > existing.confidence
          ) {
            attachments.set(key, {
              market,
              cornersReversed: result.cornersReversed,
              confidence: result.confidence,
            });
          }
          continue;
        }

        // Only record a miss when the market plausibly belongs to this card at
        // all — otherwise every other promotion's fight would be logged
        // against every UFC card.
        const best = result.candidates[0];
        if (best === undefined || best.confidence < 0.6) continue;
        const unmatched: UpcomingUnmatchedMarket = {
          provider: providerId,
          externalId: market.externalId,
          firstFighter: market.firstFighter,
          secondFighter: market.secondFighter,
          ...(market.startsAt === undefined
            ? {}
            : { startsAt: market.startsAt }),
          reason: result.status === "ambiguous" ? "ambiguous" : "no-candidate",
          bestConfidence: best.confidence,
          candidateBoutIds: result.candidates
            .slice(0, 3)
            .map((candidate) => candidate.boutId),
        };
        document.unmatchedMarkets.push(unmatched);
      }
    }

    const bouts: UpcomingBoutOdds[] = card.bouts.map((bout) => {
      const providers: UpcomingBoutOdds["providers"] = {};

      for (const [providerId, outcome] of outcomes) {
        const fetchedAt = generatedAt;
        const previous = previousEntry(options.previous, bout.boutId, providerId);

        if (outcome.error !== undefined) {
          providers[providerId] = preserveOrDefault(previous, {
            status: "provider_error",
            fetchedAt,
            message: outcome.error,
          });
          continue;
        }

        const attachment = attachments.get(
          `${providerId} ${bout.boutId}`,
        );
        if (attachment === undefined) {
          // The provider answered but has nothing for this fight. That is a
          // real answer, so it is only overridden by a retained snapshot when
          // the provider returned nothing at all.
          const emptyResponse = outcome.markets.length === 0;
          const fallback: UpcomingProviderEntry = {
            status: "not_listed",
            fetchedAt,
          };
          providers[providerId] = emptyResponse
            ? preserveOrDefault(previous, fallback)
            : fallback;
          continue;
        }

        if (attachment.market.quotes.length === 0) {
          providers[providerId] = preserveOrDefault(previous, {
            status: "not_listed",
            fetchedAt,
            externalId: attachment.market.externalId,
            message: "Market is listed but has no priced side",
          });
          continue;
        }

        matchedCounts.set(
          providerId,
          (matchedCounts.get(providerId) ?? 0) + 1,
        );
        providers[providerId] = {
          status: "loaded",
          fetchedAt,
          updatedAt: attachment.market.marketUpdatedAt ?? fetchedAt,
          externalId: attachment.market.externalId,
          ...(attachment.market.streamIds === undefined
            ? {}
            : { streamIds: attachment.market.streamIds }),
          confidence: attachment.confidence,
          cornersReversed: attachment.cornersReversed,
          ...(attachment.market.metadata === undefined
            ? {}
            : { metadata: attachment.market.metadata }),
          snapshot: toSnapshot(
            providerId,
            bout.boutId,
            attachment.market,
            attachment.cornersReversed,
            fetchedAt,
            synthetic,
          ),
        };
      }

      return {
        boutId: bout.boutId,
        espnEventId: card.espnEventId,
        redFighter: bout.redFighter,
        blueFighter: bout.blueFighter,
        ...(bout.weightClassLabel === undefined
          ? {}
          : { weightClassLabel: bout.weightClassLabel }),
        ...(bout.startsAt === undefined ? {} : { startsAt: bout.startsAt }),
        ...(bout.titleFight === undefined
          ? {}
          : { titleFight: bout.titleFight }),
        providers,
        decision: resolveDecision(
          bout.boutId,
          generatedAt,
          synthetic,
          outcomes,
          attachments,
        ),
      };
    });

    const event: UpcomingEventOdds = {
      espnEventId: card.espnEventId,
      name: card.name,
      ...(card.startsAt === undefined ? {} : { startsAt: card.startsAt }),
      bouts,
    };
    document.events.push(event);
  }

  for (const [providerId, outcome] of outcomes) {
    const run: UpcomingProviderRun = {
      status: outcome.error === undefined ? "ok" : "error",
      fetchedAt: generatedAt,
      marketCount: outcome.markets.length,
      matchedCount: matchedCounts.get(providerId) ?? 0,
      ...(outcome.error === undefined ? {} : { message: outcome.error }),
    };
    document.providerRuns[providerId] = run;
    options.onProviderResult?.(providerId, run);
  }

  return document;
}
