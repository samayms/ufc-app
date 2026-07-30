import type { UfcEvent } from "../src/schema.ts";
import {
  DEFAULT_EVENT_DATE_WINDOW_MS,
  fighterNameTokens,
} from "../src/lib/boutMatch.ts";
import type {
  BoutMappingRegistry,
  DiscoveredBoutIdentity,
} from "./mapping.ts";

/** Minimal seam for Cito discovery; tests can serve captured JSON without HTTP. */
export interface CitoDiscoveryTransport {
  get(path: string): Promise<unknown>;
}

export interface LiveCitoDiscoveryTransportOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface CitoDiscoveryOptions {
  event: UfcEvent;
  registry: Pick<BoutMappingRegistry, "matchDiscoveredBout">;
  transport: CitoDiscoveryTransport;
  configuredEventSlug?: string;
}

export interface CitoDiscoverySummary {
  eventSlug: string | undefined;
  matched: number;
  unmatched: string[];
}

interface CitoEventCandidate {
  id: string;
  slug: string;
  title: string;
  startsAt: string;
}

interface CitoBoutFighter {
  fighterName: string;
  corner: "red" | "blue";
}

interface CitoBoutCandidate {
  id: string;
  fighters: CitoBoutFighter[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function dataArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.data)) {
    return payload.data;
  }
  return [];
}

function parseEventCandidate(value: unknown): CitoEventCandidate | null {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const slug = nonEmptyString(value.slug);
  const title = nonEmptyString(value.title);
  const startsAt = nonEmptyString(value.startsAt);
  if (id === undefined || slug === undefined || title === undefined || startsAt === undefined) {
    return null;
  }
  return { id, slug, title, startsAt };
}

function parseBoutCandidate(value: unknown): CitoBoutCandidate | null {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  if (id === undefined || !Array.isArray(value.fighters)) return null;

  const fighters: CitoBoutFighter[] = [];
  for (const fighter of value.fighters) {
    if (!isRecord(fighter)) continue;
    const fighterName = nonEmptyString(fighter.fighterName);
    const corner = fighter.corner;
    if (
      fighterName !== undefined &&
      (corner === "red" || corner === "blue")
    ) {
      fighters.push({ fighterName, corner });
    }
  }
  return { id, fighters };
}

function eventDate(candidate: CitoEventCandidate): number | undefined {
  const timestamp = Date.parse(candidate.startsAt);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function titleSurnameTokens(title: string): Set<string> {
  const afterPromotion = title.split(":", 2).at(-1) ?? title;
  return new Set(
    fighterNameTokens(afterPromotion).filter((token) => token !== "vs"),
  );
}

function sharedSurnameTokenCount(left: string, right: string): number {
  const rightTokens = titleSurnameTokens(right);
  return [...titleSurnameTokens(left)].filter((token) =>
    rightTokens.has(token),
  ).length;
}

function selectEventCandidate(
  event: UfcEvent,
  candidates: readonly CitoEventCandidate[],
): CitoEventCandidate | undefined {
  const eventTimestamp = Date.parse(event.startsAt);
  if (!Number.isFinite(eventTimestamp)) return undefined;

  const withinWindow = candidates.filter((candidate) => {
    const candidateTimestamp = eventDate(candidate);
    return (
      candidateTimestamp !== undefined &&
      Math.abs(candidateTimestamp - eventTimestamp) <=
        DEFAULT_EVENT_DATE_WINDOW_MS
    );
  });
  if (withinWindow.length === 0) return undefined;
  if (withinWindow.length === 1) return withinWindow[0];

  const scored = withinWindow.map((candidate) => ({
    candidate,
    score: sharedSurnameTokenCount(event.name, candidate.title),
  }));
  const bestScore = Math.max(...scored.map(({ score }) => score));
  const best = scored.filter(({ score }) => score === bestScore);
  return best.length === 1 ? best[0]?.candidate : undefined;
}

async function resolveEvent(
  event: UfcEvent,
  transport: CitoDiscoveryTransport,
  configuredEventSlug: string | undefined,
): Promise<CitoEventCandidate | undefined> {
  if (configuredEventSlug !== undefined && configuredEventSlug.length > 0) {
    return {
      id: configuredEventSlug,
      slug: configuredEventSlug,
      title: event.name,
      startsAt: event.startsAt,
    };
  }

  const payload = await transport.get("ufc/events/upcoming?limit=25");
  const candidates = dataArray(payload).flatMap((value) => {
    const candidate = parseEventCandidate(value);
    return candidate === null ? [] : [candidate];
  });
  return selectEventCandidate(event, candidates);
}

function attachEventRef(event: UfcEvent, eventId: string): void {
  if (event.externalRefs.some((ref) => ref.source === "cito")) return;
  event.externalRefs.push({ source: "cito", id: eventId });
}

function identityForBout(
  bout: CitoBoutCandidate,
): DiscoveredBoutIdentity | undefined {
  const red = bout.fighters.filter(({ corner }) => corner === "red");
  const blue = bout.fighters.filter(({ corner }) => corner === "blue");
  // A malformed corner assignment cannot be safely reconciled to a canonical bout.
  if (red.length !== 1 || blue.length !== 1) return undefined;
  const redFighter = red[0]?.fighterName;
  const blueFighter = blue[0]?.fighterName;
  if (redFighter === undefined || blueFighter === undefined) return undefined;
  return {
    externalRef: { source: "cito", id: bout.id },
    redFighter,
    blueFighter,
  };
}

/** Resolves a Cito card and attaches every confidently matched Cito bout ref. */
export async function discoverCitoBouts(
  options: CitoDiscoveryOptions,
): Promise<CitoDiscoverySummary> {
  const resolved = await resolveEvent(
    options.event,
    options.transport,
    options.configuredEventSlug,
  );
  if (resolved === undefined) {
    return { eventSlug: undefined, matched: 0, unmatched: [] };
  }

  // Persist the event's Cito identity on the loaded state so the lifecycle
  // fallback can be constructed from the same resolved card. A pinned slug is
  // the only identity available without the optional upcoming-event lookup.
  attachEventRef(options.event, resolved.id);
  const payload = await options.transport.get(
    `ufc/events/${encodeURIComponent(resolved.slug)}/bouts`,
  );
  const bouts = dataArray(payload).flatMap((value) => {
    const bout = parseBoutCandidate(value);
    return bout === null ? [] : [bout];
  });

  let matched = 0;
  const unmatched: string[] = [];
  for (const bout of bouts) {
    const identity = identityForBout(bout);
    if (identity === undefined) {
      // Corner-less payloads are ignored rather than sent to fuzzy matching;
      // there is no safe identity to attach and the capture documents this
      // as an incomplete Cito bout record, not an ambiguous fight.
      continue;
    }
    const mapping = await options.registry.matchDiscoveredBout(identity);
    if (mapping === undefined) unmatched.push(bout.id);
    else matched += 1;
  }

  return { eventSlug: resolved.slug, matched, unmatched };
}

/** Cito's discovery API uses the same base URL and API-key header as stats. */
export function createLiveCitoDiscoveryTransport(
  options: LiveCitoDiscoveryTransportOptions,
): CitoDiscoveryTransport {
  const baseUrl = options.baseUrl.trim();
  const apiKey = options.apiKey.trim();
  if (baseUrl.length === 0) {
    throw new TypeError("Cito discovery requires a non-empty base URL");
  }
  if (apiKey.length === 0) {
    throw new Error("Cito discovery requires CITO_API_KEY");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

  return {
    async get(path) {
      const response = await fetchImpl(
        new URL(path, base).toString(),
        { headers: { "x-api-key": apiKey } },
      );
      if (!response.ok) {
        throw new Error(`Cito discovery request failed with HTTP ${response.status}`);
      }
      return JSON.parse(await response.text()) as unknown;
    },
  };
}
