/**
 * ESPN "future cards" schedule source: the public scoreboard (list of
 * upcoming events) and fightcenter (full fight card for one event)
 * endpoints. Unlike espn.ts's live lifecycle fetcher, this source is NOT
 * gated behind `mode: "live"` / DATA_MODE=live. Both endpoints below are
 * ESPN's public, unauthenticated "site API" surface (no API key, no
 * credentials, same class of endpoint sports sites embed on public pages)
 * — there is nothing to mock and no licensing concern, so the feature
 * fetches them directly even in the default fixture-mode `npm run dev`
 * app. If that ever changes, gate this the same way
 * createLiveEspnLifecycleFetcher gates on SourceConfig.
 */

/** Recognized fight-card sections, in display order. */
export type ScheduledSegment = "main-card" | "prelims" | "early-prelims";

export interface EspnScheduledEventSummary {
  eventId: string;
  name: string;
  shortName?: string;
  startsAt: string;
}

export interface EspnScheduledFighter {
  athleteId?: string;
  name: string;
  record?: string;
  country?: string;
  headshotUrl?: string;
}

export interface EspnScheduledFight {
  competitionId: string;
  matchNumber?: number;
  startsAt?: string;
  weightClassLabel?: string;
  note?: string;
  titleFight: boolean;
  mainEvent: boolean;
  red: EspnScheduledFighter;
  blue: EspnScheduledFighter;
}

export interface EspnScheduledSection {
  key: string;
  displayName: string;
  segment?: ScheduledSegment;
  startsAt?: string;
  fights: EspnScheduledFight[];
}

export interface EspnScheduledCard {
  eventId: string;
  name: string;
  startsAt?: string;
  venue?: string;
  city?: string;
  sections: EspnScheduledSection[];
}

export interface EspnScheduleSource {
  listUpcomingEvents(): Promise<EspnScheduledEventSummary[]>;
  getCard(eventId: string): Promise<EspnScheduledCard | null>;
}

// ---------------------------------------------------------------------------
// Raw ESPN shapes (local, non-exported — see CONTRACT.md for verified facts)
// ---------------------------------------------------------------------------

interface RawEspnScheduleSeason {
  year?: number;
  type?: number;
  slug?: string;
}

interface RawEspnScheduleStatusType {
  name?: string;
  completed?: boolean;
}

interface RawEspnScheduleStatus {
  type?: RawEspnScheduleStatusType;
}

interface RawEspnScheduleEvent {
  id?: string;
  uid?: string;
  date?: string;
  name?: string;
  shortName?: string;
  season?: RawEspnScheduleSeason;
  status?: RawEspnScheduleStatus;
  competitions?: unknown[];
}

interface RawEspnScheduleResponse {
  events?: RawEspnScheduleEvent[];
}

interface RawEspnFightcenterVenueAddress {
  city?: string;
  state?: string;
  country?: string;
}

interface RawEspnFightcenterVenue {
  id?: string;
  fullName?: string;
  displayNameLocation?: string;
  address?: RawEspnFightcenterVenueAddress;
}

interface RawEspnFightcenterEvent {
  id?: string;
  uid?: string;
  date?: string;
  name?: string;
  shortName?: string;
}

interface RawEspnAthleteWeightClass {
  id?: string;
  text?: string;
  shortName?: string;
  slug?: string;
}

interface RawEspnAthleteHeadshot {
  href?: string;
  alt?: string;
}

interface RawEspnFightcenterAthlete {
  id?: string;
  displayName?: string;
  fullName?: string;
  country?: string;
  headshot?: RawEspnAthleteHeadshot;
  weightClass?: RawEspnAthleteWeightClass;
}

interface RawEspnFightcenterCompetitor {
  id?: string;
  order?: number;
  winner?: boolean;
  displayRecord?: string;
  athlete?: RawEspnFightcenterAthlete;
}

interface RawEspnFightcenterCompetitionType {
  id?: string;
  text?: string;
  abbreviation?: string;
}

interface RawEspnFightcenterCompetitionTypesEntry {
  id?: string;
  text?: string;
}

interface RawEspnFightcenterCardSegmentObject {
  id?: string;
  name?: string;
  description?: string;
}

interface RawEspnFightcenterCompetition {
  id?: string;
  date?: string;
  type?: RawEspnFightcenterCompetitionType | null;
  types?: RawEspnFightcenterCompetitionTypesEntry[];
  cardSegment?: RawEspnFightcenterCardSegmentObject;
  matchNumber?: number;
  note?: string | null;
  competitors?: RawEspnFightcenterCompetitor[];
}

interface RawEspnFightcenterSection {
  name?: string;
  displayName?: string;
  cardSegment?: string;
  competitions?: RawEspnFightcenterCompetition[];
}

interface RawEspnFightcenterResponse {
  event?: RawEspnFightcenterEvent;
  venue?: RawEspnFightcenterVenue;
  cards?: Record<string, RawEspnFightcenterSection>;
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

const ESPN_SCHEDULE_BASE_URL =
  "https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard";
const ESPN_FIGHTCENTER_BASE_URL =
  "https://site.web.api.espn.com/apis/common/v3/sports/mma/ufc/fightcenter";

function formatUtcYyyyMmDd(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

/**
 * ESPN's scoreboard hard-caps the `dates` range at 366 days (verified live
 * 2026-07-28: a 366-day span 200s, a 367-day span 400s). Callers are
 * responsible for keeping (end - start) within that cap; this only rejects
 * an inverted range.
 */
export function buildEspnScheduleUrl(start: Date, end: Date): string {
  if (end.getTime() < start.getTime()) {
    throw new TypeError("ESPN schedule URL requires end >= start");
  }

  const url = new URL(ESPN_SCHEDULE_BASE_URL);
  url.searchParams.set(
    "dates",
    `${formatUtcYyyyMmDd(start)}-${formatUtcYyyyMmDd(end)}`,
  );
  url.searchParams.set("limit", "1000");
  return url.toString();
}

export function buildEspnFightcenterUrl(eventId: string): string {
  if (eventId.trim().length === 0) {
    throw new TypeError("ESPN fightcenter URL requires a non-empty event id");
  }

  return `${ESPN_FIGHTCENTER_BASE_URL}/${encodeURIComponent(eventId)}`;
}

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

const CONTENDER_SERIES_PATTERN = /contender series/i;

/**
 * Parses the ESPN scoreboard payload into upcoming, non-Contender-Series
 * event summaries. Never throws on malformed input — an unrecognized shape
 * just yields an empty list, matching every other source client's
 * "no data" convention.
 */
export function parseEspnScheduleEvents(
  payload: unknown,
  now: Date,
): EspnScheduledEventSummary[] {
  if (typeof payload !== "object" || payload === null) return [];

  const raw = payload as RawEspnScheduleResponse;
  if (!Array.isArray(raw.events)) return [];

  const nowMs = now.getTime();
  const seenIds = new Set<string>();
  const results: EspnScheduledEventSummary[] = [];

  for (const event of raw.events) {
    if (typeof event !== "object" || event === null) continue;

    const id = event.id;
    const date = event.date;
    const name = event.name;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof date !== "string" || typeof name !== "string") continue;
    if (seenIds.has(id)) continue;

    const eventTime = new Date(date).getTime();
    if (Number.isNaN(eventTime) || eventTime < nowMs) continue;

    const statusType = event.status?.type;
    if (statusType?.name === "STATUS_FINAL" || statusType?.completed === true) {
      continue;
    }

    const shortName = event.shortName;
    if (CONTENDER_SERIES_PATTERN.test(`${name} ${shortName ?? ""}`)) continue;

    seenIds.add(id);
    results.push({
      eventId: id,
      name,
      ...(shortName === undefined ? {} : { shortName }),
      startsAt: date,
    });
  }

  results.sort(
    (left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime(),
  );
  return results;
}

function cornerForRawCompetitor(
  competitor: RawEspnFightcenterCompetitor,
): "red" | "blue" {
  return competitor.order === 2 ? "blue" : "red";
}

function buildFighter(
  competitor: RawEspnFightcenterCompetitor | undefined,
): EspnScheduledFighter | null {
  if (competitor === undefined) return null;

  const athlete = competitor.athlete;
  const name = athlete?.displayName ?? athlete?.fullName;
  if (typeof name !== "string" || name.length === 0) return null;

  return {
    ...(athlete?.id === undefined ? {} : { athleteId: athlete.id }),
    name,
    ...(competitor.displayRecord === undefined
      ? {}
      : { record: competitor.displayRecord }),
    ...(athlete?.country === undefined ? {} : { country: athlete.country }),
    ...(athlete?.headshot?.href === undefined
      ? {}
      : { headshotUrl: athlete.headshot.href }),
  };
}

function buildFight(raw: RawEspnFightcenterCompetition): EspnScheduledFight | null {
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;

  const competitors = raw.competitors ?? [];
  const redRaw = competitors.find(
    (competitor) => cornerForRawCompetitor(competitor) === "red",
  );
  const blueRaw = competitors.find(
    (competitor) => cornerForRawCompetitor(competitor) === "blue",
  );
  const red = buildFighter(redRaw);
  const blue = buildFighter(blueRaw);
  if (!red || !blue) return null;

  const weightClassLabel =
    raw.type?.text ??
    redRaw?.athlete?.weightClass?.text ??
    blueRaw?.athlete?.weightClass?.text;

  const hasTitleTypeEntry = raw.types?.some(
    (entry) => typeof entry.text === "string" && /title/i.test(entry.text),
  );
  const noteMentionsTitle =
    typeof raw.note === "string" && /title fight/i.test(raw.note);
  const titleFight = hasTitleTypeEntry === true || noteMentionsTitle;

  return {
    competitionId: raw.id,
    ...(raw.matchNumber === undefined ? {} : { matchNumber: raw.matchNumber }),
    ...(raw.date === undefined ? {} : { startsAt: raw.date }),
    ...(weightClassLabel === undefined ? {} : { weightClassLabel }),
    ...(typeof raw.note === "string" ? { note: raw.note } : {}),
    titleFight,
    mainEvent: raw.matchNumber === 1,
    red,
    blue,
  };
}

const SEGMENT_BY_SLUG: Record<string, ScheduledSegment> = {
  main: "main-card",
  prelims1: "prelims",
  prelims2: "early-prelims",
};

const SEGMENT_RANK: Record<ScheduledSegment, number> = {
  "main-card": 0,
  prelims: 1,
  "early-prelims": 2,
};
const UNRECOGNIZED_SEGMENT_RANK = 3;

const FALLBACK_DISPLAY_NAME: Record<ScheduledSegment, string> = {
  "main-card": "Main Card",
  prelims: "Prelims",
  "early-prelims": "Early Prelims",
};

function earliestCompetitionDate(
  competitions: RawEspnFightcenterCompetition[],
): string | undefined {
  let earliest: string | undefined;
  let earliestMs = Number.POSITIVE_INFINITY;

  for (const competition of competitions) {
    if (typeof competition.date !== "string") continue;
    const ms = new Date(competition.date).getTime();
    if (Number.isNaN(ms) || ms >= earliestMs) continue;
    earliestMs = ms;
    earliest = competition.date;
  }

  return earliest;
}

function buildSection(
  key: string,
  raw: RawEspnFightcenterSection,
): EspnScheduledSection {
  const segment = SEGMENT_BY_SLUG[raw.cardSegment ?? ""];
  const competitions = raw.competitions ?? [];
  // Preserve ESPN's own competition order verbatim (matchNumber ascending,
  // main event first) — never sort or reverse it here.
  const fights = competitions
    .map(buildFight)
    .filter((fight): fight is EspnScheduledFight => fight !== null);
  const startsAt = earliestCompetitionDate(competitions);

  return {
    key,
    displayName:
      raw.displayName ?? (segment ? FALLBACK_DISPLAY_NAME[segment] : key),
    ...(segment === undefined ? {} : { segment }),
    ...(startsAt === undefined ? {} : { startsAt }),
    fights,
  };
}

/**
 * Parses one event's ESPN fightcenter payload into a scheduled card.
 * `eventId` guards against accidentally normalizing a payload for the
 * wrong event, mirroring espn.ts's parseEvent(raw, ref) convention. Never
 * throws on malformed input — returns null instead.
 */
export function parseEspnFightcenterCard(
  payload: unknown,
  eventId: string,
): EspnScheduledCard | null {
  if (typeof payload !== "object" || payload === null) return null;

  const raw = payload as RawEspnFightcenterResponse;
  const event = raw.event;
  if (typeof event?.id !== "string" || event.id !== eventId) return null;
  if (typeof event.name !== "string") return null;

  const cardsValue = raw.cards;
  const sectionEntries =
    typeof cardsValue === "object" && cardsValue !== null
      ? Object.entries(cardsValue)
      : [];

  const sections = sectionEntries
    .filter(
      (entry): entry is [string, RawEspnFightcenterSection] =>
        typeof entry[1] === "object" && entry[1] !== null,
    )
    .map(([key, section]) => buildSection(key, section));

  // Array.prototype.sort is stable (ES2019+): sections that tie on rank
  // (all unrecognized ones) keep ESPN's own object order.
  sections.sort((left, right) => {
    const leftRank = left.segment ? SEGMENT_RANK[left.segment] : UNRECOGNIZED_SEGMENT_RANK;
    const rightRank = right.segment ? SEGMENT_RANK[right.segment] : UNRECOGNIZED_SEGMENT_RANK;
    return leftRank - rightRank;
  });

  const venue = raw.venue;
  const city = venue?.address?.city;
  const state = venue?.address?.state;

  return {
    eventId: event.id,
    name: event.name,
    ...(event.date === undefined ? {} : { startsAt: event.date }),
    ...(venue?.fullName === undefined ? {} : { venue: venue.fullName }),
    ...(city === undefined
      ? {}
      : { city: state === undefined ? city : `${city}, ${state}` }),
    sections,
  };
}

// ---------------------------------------------------------------------------
// Fetch plumbing (copied from espn.ts — not exported there, kept local here)
// ---------------------------------------------------------------------------

async function readWithByteLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("response exceeded the maximum allowed size");
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;

    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("response exceeded the maximum allowed size");
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function fetchJsonWithLimits(
  url: string,
  options: {
    timeoutMs: number;
    maxBytes: number;
    fetchImpl: typeof fetch;
    headers?: Record<string, string>;
  },
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    options.timeoutMs,
  );

  try {
    const response = await options.fetchImpl(url, {
      signal: controller.signal,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    });
    if (!response.ok) {
      throw new Error(`request failed with HTTP ${response.status}`);
    }

    const text = await readWithByteLimit(response, options.maxBytes);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("response was not valid JSON");
    }
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// TTL-cached source
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 5 * 60_000;
const SCHEDULE_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_REQUEST_TIMEOUT_MS = 8_000;
const SCHEDULE_MAX_RESPONSE_BYTES = 4_000_000;
const FIGHTCENTER_REQUEST_TIMEOUT_MS = 8_000;
const FIGHTCENTER_MAX_RESPONSE_BYTES = 4_000_000;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds a fresh ESPN schedule source with its own in-memory TTL cache.
 * The cache is deliberately kept local to this factory closure (not a
 * module-level singleton, not a separate cache module/database) — one
 * instance per `createEspnScheduleSource()` call, one cache entry for the
 * event list plus one per event id for cards. Concurrent calls for the
 * same key share a single in-flight request instead of firing duplicates.
 * A failed fetch is never cached — the next call retries.
 */
export function createEspnScheduleSource(options?: {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  ttlMs?: number;
}): EspnScheduleSource {
  // Browsers require `fetch` to be invoked with `window` as its receiver, and
  // calling it through a stored reference drops that binding ("Illegal
  // invocation"). Wrap the default so the receiver survives.
  const fetchImpl: typeof fetch =
    options?.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const now = options?.now ?? (() => new Date());
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;

  let eventListEntry: CacheEntry<EspnScheduledEventSummary[]> | undefined;
  let eventListInFlight: Promise<EspnScheduledEventSummary[]> | undefined;

  const cardCache = new Map<string, CacheEntry<EspnScheduledCard | null>>();
  const cardInFlight = new Map<string, Promise<EspnScheduledCard | null>>();

  async function fetchEventList(): Promise<EspnScheduledEventSummary[]> {
    const start = now();
    const end = new Date(start.getTime() + SCHEDULE_WINDOW_DAYS * DAY_MS);

    try {
      const payload = await fetchJsonWithLimits(
        buildEspnScheduleUrl(start, end),
        {
          timeoutMs: SCHEDULE_REQUEST_TIMEOUT_MS,
          maxBytes: SCHEDULE_MAX_RESPONSE_BYTES,
          fetchImpl,
        },
      );
      return parseEspnScheduleEvents(payload, start);
    } catch (error) {
      throw new Error(
        `Failed to load the ESPN UFC schedule: ${messageOf(error)}`,
        { cause: error },
      );
    }
  }

  async function fetchCard(eventId: string): Promise<EspnScheduledCard | null> {
    try {
      const payload = await fetchJsonWithLimits(
        buildEspnFightcenterUrl(eventId),
        {
          timeoutMs: FIGHTCENTER_REQUEST_TIMEOUT_MS,
          maxBytes: FIGHTCENTER_MAX_RESPONSE_BYTES,
          fetchImpl,
        },
      );
      return parseEspnFightcenterCard(payload, eventId);
    } catch (error) {
      throw new Error(
        `Failed to load the ESPN fight card for event ${eventId}: ${messageOf(error)}`,
        { cause: error },
      );
    }
  }

  return {
    async listUpcomingEvents() {
      const nowMs = now().getTime();
      if (eventListEntry !== undefined && eventListEntry.expiresAt > nowMs) {
        return eventListEntry.value;
      }
      if (eventListInFlight !== undefined) {
        return eventListInFlight;
      }

      const promise = fetchEventList()
        .then((value) => {
          eventListEntry = { expiresAt: now().getTime() + ttlMs, value };
          return value;
        })
        .finally(() => {
          eventListInFlight = undefined;
        });
      eventListInFlight = promise;
      return promise;
    },

    async getCard(eventId: string) {
      const nowMs = now().getTime();
      const cached = cardCache.get(eventId);
      if (cached !== undefined && cached.expiresAt > nowMs) {
        return cached.value;
      }
      const inFlight = cardInFlight.get(eventId);
      if (inFlight !== undefined) {
        return inFlight;
      }

      const promise = fetchCard(eventId)
        .then((value) => {
          cardCache.set(eventId, { expiresAt: now().getTime() + ttlMs, value });
          return value;
        })
        .finally(() => {
          cardInFlight.delete(eventId);
        });
      cardInFlight.set(eventId, promise);
      return promise;
    },
  };
}
