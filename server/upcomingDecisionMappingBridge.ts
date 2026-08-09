/** Live binary distance subscriptions imported from upcoming-odds snapshots. */
import type { UfcEvent } from "../src/schema.ts";
import type { UpcomingOddsDocument } from "../src/lib/upcomingOdds.ts";
import type { MarketSubscription } from "./marketTransport.ts";
import {
  UPCOMING_DECISION_MAPPING_STREAM,
  type PersistedUpcomingDecisionMapping,
} from "./upcomingOddsStore.ts";
import type { Storage } from "./storage.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function valid(value: unknown): value is PersistedUpcomingDecisionMapping {
  return isRecord(value) && value.version === 1 &&
    typeof value.boutId === "string" && typeof value.espnEventId === "string" &&
    (value.provider === "kalshi" || value.provider === "polymarket") &&
    typeof value.externalId === "string" && Array.isArray(value.streamIds) &&
    value.streamIds.length === 2 && value.streamIds.every((id) => typeof id === "string" && id.length > 0);
}

/**
 * Binary distance books are deliberately not placed in BoutMapping: their
 * outcomes are Decision/Finish rather than fighter names.
 */
export async function currentEventDecisionSubscriptions(options: {
  event: UfcEvent;
  storage: Storage;
  /**
   * Lets a rolling deploy recover Kalshi's streamable binary ticker from the
   * already-persisted upcoming document before the new mapping stream has
   * ever been written. Polymarket still requires its explicit token pair.
   */
  document?: UpcomingOddsDocument | null;
}): Promise<MarketSubscription[]> {
  const eventId = options.event.externalRefs.find((ref) => ref.source === "espn")?.id;
  if (eventId === undefined) return [];
  const boutIds = new Set(options.event.bouts.map((bout) => bout.id));
  const latest = new Map<string, PersistedUpcomingDecisionMapping>();
  const matchingDocumentEvent = options.document?.events.find(
    (candidate) => candidate.espnEventId === eventId,
  );
  for (const bout of matchingDocumentEvent?.bouts ?? []) {
    if (!boutIds.has(bout.boutId) || bout.decision.state !== "loaded") continue;
    const decision = bout.decision;
    if (
      (decision.source !== "kalshi" && decision.source !== "polymarket") ||
      decision.externalId === undefined
    ) continue;
    const streamIds = decision.streamIds ??
      (decision.source === "kalshi"
        ? [decision.externalId, decision.externalId] as const
        : undefined);
    if (streamIds === undefined) continue;
    latest.set(`${decision.source}\u0000${bout.boutId}`, {
      version: 1,
      recordedAt: options.document?.generatedAt ?? decision.fetchedAt,
      boutId: bout.boutId,
      espnEventId: eventId,
      provider: decision.source,
      externalId: decision.externalId,
      streamIds,
    });
  }
  for (const value of await options.storage.read<unknown>(UPCOMING_DECISION_MAPPING_STREAM)) {
    if (!valid(value) || value.espnEventId !== eventId || !boutIds.has(value.boutId)) continue;
    latest.set(`${value.provider}\u0000${value.boutId}`, value);
  }
  const subscriptions: MarketSubscription[] = [];
  for (const record of latest.values()) {
    const [decisionId, finishId] = record.streamIds;
    if (decisionId === undefined || finishId === undefined) continue;
    // A Kalshi market is one YES/NO order book. One Decision tick retains both
    // sides through its bid/ask; subscribing twice would collide by ticker.
    if (record.provider === "kalshi") {
      subscriptions.push({
      source: "kalshi", boutId: record.boutId, externalId: decisionId,
      marketType: "fight-distance", outcome: "Decision",
      });
      continue;
    }
    subscriptions.push(
      { source: "polymarket", boutId: record.boutId, externalId: decisionId, marketId: record.externalId, marketType: "fight-distance", outcome: "Decision" },
      { source: "polymarket", boutId: record.boutId, externalId: finishId, marketId: record.externalId, marketType: "fight-distance", outcome: "Finish" },
    );
  }
  return subscriptions;
}
