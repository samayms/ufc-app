/**
 * Imports pre-event provider mappings into the collector's active registry.
 *
 * Upcoming sync records are intentionally scoped by both ESPN event and bout
 * id. This bridge accepts only records for the event currently loaded by the
 * collector, so an old card's provider identifiers can never leak into a new
 * live subscription set.
 */

import type { SourceId, UfcEvent } from "../src/schema.ts";
import {
  type BoutMappingRegistry,
} from "./mapping.ts";
import {
  UPCOMING_MAPPING_STREAM,
  type PersistedUpcomingMapping,
} from "./upcomingOddsStore.ts";
import type { Storage } from "./storage.ts";

export interface UpcomingMappingImportSummary {
  imported: number;
  alreadyPresent: number;
  rejected: number;
}

const PROVIDER_SOURCES: ReadonlySet<string> = new Set([
  "kalshi",
  "polymarket",
  "odds-api-io",
  "odds-api",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPersistedUpcomingMapping(
  value: unknown,
): value is PersistedUpcomingMapping {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.recordedAt === "string" &&
    typeof value.boutId === "string" &&
    value.boutId.length > 0 &&
    typeof value.espnEventId === "string" &&
    value.espnEventId.length > 0 &&
    typeof value.provider === "string" &&
    PROVIDER_SOURCES.has(value.provider) &&
    typeof value.externalId === "string" &&
    value.externalId.length > 0 &&
    (value.streamIds === undefined ||
      (Array.isArray(value.streamIds) &&
        value.streamIds.length === 2 &&
        value.streamIds.every(
          (streamId) =>
            typeof streamId === "string" && streamId.trim().length > 0,
        ))) &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    typeof value.cornersReversed === "boolean"
  );
}

function eventEspnId(event: UfcEvent): string | undefined {
  return event.externalRefs.find((ref) => ref.source === "espn")?.id;
}

function orderedStreamIds(
  record: PersistedUpcomingMapping,
): readonly [string, string] | undefined {
  if (record.streamIds === undefined) return undefined;
  const [first, second] = record.streamIds;
  if (first === undefined || second === undefined || first === second) {
    return undefined;
  }
  return record.cornersReversed ? [second, first] : [first, second];
}

/**
 * Reads the append-only upcoming-mapping stream and imports only references
 * that name the loaded ESPN event and one of its canonical bouts. Imported
 * records remain automatic mappings: no manual-override state is created.
 */
export async function importCurrentEventUpcomingMappings(options: {
  event: UfcEvent;
  registry: BoutMappingRegistry;
  storage: Storage;
}): Promise<UpcomingMappingImportSummary> {
  const currentEventId = eventEspnId(options.event);
  const currentBoutIds = new Set(options.event.bouts.map((bout) => bout.id));
  const summary: UpcomingMappingImportSummary = {
    imported: 0,
    alreadyPresent: 0,
    rejected: 0,
  };
  if (currentEventId === undefined) return summary;

  const records = await options.storage.read<unknown>(UPCOMING_MAPPING_STREAM);
  for (const record of records) {
    if (!isPersistedUpcomingMapping(record)) {
      summary.rejected += 1;
      continue;
    }
    if (
      record.espnEventId !== currentEventId ||
      !currentBoutIds.has(record.boutId)
    ) {
      summary.rejected += 1;
      continue;
    }

    const source = record.provider as SourceId;
    // Kalshi's externalId identifies a fight event, and Polymarket's identifies
    // a condition. Neither is a streamable fighter market: both transports
    // subscribe exclusively to their ordered per-outcome ids.
    const refs =
      source === "kalshi"
        ? orderedStreamIds(record)
        : source === "polymarket"
          ? orderedStreamIds(record)
          : [record.externalId];
    if (refs === undefined || refs.length === 0) {
      summary.rejected += 1;
      continue;
    }

    let recordImported = false;
    let recordRejected = false;
    for (const externalId of refs) {
      const existing = options.registry.findInternalBoutId(source, externalId);
      if (existing === record.boutId) continue;
      const imported = await options.registry.importExternalRef({
        internalBoutId: record.boutId,
        externalRef: { source, id: externalId },
        confidence: record.confidence,
      });
      if (imported === undefined) recordRejected = true;
      else recordImported = true;
    }
    if (recordRejected) summary.rejected += 1;
    else if (recordImported) summary.imported += 1;
    else summary.alreadyPresent += 1;
  }
  return summary;
}
