/**
 * Persistence for the upcoming-odds document.
 *
 * The document is written whole and atomically (temp file + rename) because
 * the collector serves it straight off disk while the sync may be rewriting
 * it — a partial read would blank every provider panel at once. The
 * append-only mapping stream beside it exists so every provider→bout
 * attachment the matcher made is reviewable after the fact, including the ones
 * it refused to make.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Storage } from "./storage.ts";
import type {
  UpcomingOddsDocument,
  UpcomingProviderId,
} from "../src/lib/upcomingOdds.ts";

export const UPCOMING_ODDS_FILENAME = "upcoming-odds.json";
export const UPCOMING_MAPPING_STREAM = "upcoming-bout-mappings";

export function upcomingOddsPath(dataDirectory: string): string {
  return join(dataDirectory, UPCOMING_ODDS_FILENAME);
}

function isUpcomingOddsDocument(
  value: unknown,
): value is UpcomingOddsDocument {
  if (typeof value !== "object" || value === null) return false;
  const document = value as Record<string, unknown>;
  return (
    document.version === 1 &&
    typeof document.generatedAt === "string" &&
    typeof document.synthetic === "boolean" &&
    Array.isArray(document.events) &&
    Array.isArray(document.unmatchedMarkets) &&
    typeof document.providerRuns === "object" &&
    document.providerRuns !== null
  );
}

/**
 * Reads the last written document. A missing or unreadable file is `null`,
 * not a throw: the very first sync has nothing to read, and a corrupt file
 * must not stop the run that would replace it.
 */
export async function readUpcomingOddsDocument(
  dataDirectory: string,
): Promise<UpcomingOddsDocument | null> {
  try {
    const raw = await readFile(upcomingOddsPath(dataDirectory), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isUpcomingOddsDocument(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeUpcomingOddsDocument(
  dataDirectory: string,
  document: UpcomingOddsDocument,
): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const target = upcomingOddsPath(dataDirectory);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

export interface PersistedUpcomingMapping {
  version: 1;
  recordedAt: string;
  boutId: string;
  espnEventId: string;
  provider: UpcomingProviderId;
  externalId: string;
  confidence: number;
  cornersReversed: boolean;
}

/**
 * Appends every attachment this run made, so the mapping history is auditable
 * independently of the current document (which only ever shows the latest
 * state).
 */
export async function persistUpcomingMappings(
  storage: Storage,
  document: UpcomingOddsDocument,
): Promise<number> {
  let written = 0;
  for (const event of document.events) {
    for (const bout of event.bouts) {
      for (const [provider, entry] of Object.entries(bout.providers)) {
        if (
          entry === undefined ||
          entry.status !== "loaded" ||
          entry.preserved === true ||
          entry.externalId === undefined
        ) {
          continue;
        }
        await storage.append(UPCOMING_MAPPING_STREAM, {
          version: 1,
          recordedAt: document.generatedAt,
          boutId: bout.boutId,
          espnEventId: bout.espnEventId,
          provider: provider as UpcomingProviderId,
          externalId: entry.externalId,
          confidence: entry.confidence ?? 0,
          cornersReversed: entry.cornersReversed ?? false,
        } satisfies PersistedUpcomingMapping);
        written += 1;
      }
    }
  }
  return written;
}
