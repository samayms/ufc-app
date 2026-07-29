/**
 * ESPN "future cards" schedule source: the public scoreboard (list of
 * upcoming events), fightcenter (full fight card for one event), and
 * per-athlete bio endpoints. Unlike espn.ts's live lifecycle fetcher, this
 * source is NOT gated behind `mode: "live"` / DATA_MODE=live. All endpoints
 * below are ESPN's public, unauthenticated "site API" surface (no API key,
 * no credentials, same class of endpoint sports sites embed on public
 * pages) — there is nothing to mock and no licensing concern, so the
 * feature fetches them directly even in the default fixture-mode
 * `npm run dev` app. If that ever changes, gate this the same way
 * createLiveEspnLifecycleFetcher gates on SourceConfig.
 */

import type { BoutResult, BoutStatus, FinishMethod, PastBout } from "../schema.ts";

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
  /** Fightcenter's per-competitor career-average stat line, ESPN's labels verbatim. */
  stats?: { name: string; label: string; displayValue: string }[];
  /** From the per-athlete bio endpoint, merged in by getCard(); absent when that fetch failed or the fighter has no athleteId. */
  nickname?: string;
  age?: number;
  heightCm?: number;
  reachCm?: number;
  /** e.g. "Orthodox" | "Southpaw" | "Switch" — ESPN's label verbatim. */
  stance?: string;
  /** From the per-athlete bio endpoint, newest first, capped at 5. */
  recentBouts?: PastBout[];
  /**
   * Divisional UFC ranking from the rankings endpoint, e.g. "#3
   * Welterweight" or "Welterweight Champion" — absent when the fighter
   * isn't ranked or the rankings fetch failed.
   */
  ranking?: string;
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
  /**
   * ESPN's fightcenter payload carries live competition status regardless
   * of this app's own collector — a user who drills into an event's card
   * before it starts and stays on that screen will see fights go live and
   * final in place, not a stale "upcoming" forever. Always present;
   * "upcoming" is the default when ESPN hasn't started the clock yet.
   */
  status: BoutStatus;
  /** Only present while status is "in-round"/"between-rounds". */
  currentRound?: number;
  /** Only present once status is "final". */
  result?: BoutResult;
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

interface RawEspnFightcenterAthleteStance {
  text?: string;
}

interface RawEspnFightcenterAthlete {
  id?: string;
  displayName?: string;
  fullName?: string;
  country?: string;
  headshot?: RawEspnAthleteHeadshot;
  weightClass?: RawEspnAthleteWeightClass;
  age?: number;
  displayHeight?: string;
  displayReach?: string;
  stance?: RawEspnFightcenterAthleteStance;
}

interface RawEspnFightcenterCompetitorStat {
  name?: string;
  shortDisplayName?: string;
  displayValue?: string;
}

interface RawEspnFightcenterCompetitor {
  id?: string;
  order?: number;
  winner?: boolean;
  displayRecord?: string;
  athlete?: RawEspnFightcenterAthlete;
  stats?: RawEspnFightcenterCompetitorStat[];
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

interface RawEspnFightcenterStatusType {
  name?: string;
  state?: string;
  completed?: boolean;
}

interface RawEspnFightcenterStatus {
  period?: number;
  displayClock?: string;
  type?: RawEspnFightcenterStatusType;
}

interface RawEspnFightcenterResultMethod {
  name?: string;
  displayName?: string;
}

interface RawEspnFightcenterResult {
  method?: RawEspnFightcenterResultMethod;
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
  status?: RawEspnFightcenterStatus;
  result?: RawEspnFightcenterResult;
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

interface RawEspnAthleteBioAthlete {
  id?: string;
  nickname?: string;
}

interface RawEspnAthleteBioStatusResult {
  name?: string;
  displayName?: string;
}

interface RawEspnAthleteBioStatus {
  period?: number;
  result?: RawEspnAthleteBioStatusResult;
}

interface RawEspnAthleteBioOpponent {
  displayName?: string;
}

interface RawEspnAthleteBioEvent {
  name?: string;
  gameDate?: string;
  gameResult?: string;
  status?: RawEspnAthleteBioStatus;
  opponent?: RawEspnAthleteBioOpponent;
}

interface RawEspnAthleteBioResponse {
  athlete?: RawEspnAthleteBioAthlete;
  eventsMap?: Record<string, RawEspnAthleteBioEvent>;
}

interface RawEspnRankingsAthlete {
  id?: string;
}

interface RawEspnRankingsEntry {
  current?: number;
  athlete?: RawEspnRankingsAthlete;
}

interface RawEspnRankingsWeightClass {
  text?: string;
}

interface RawEspnRankingsGroup {
  /**
   * e.g. "welterweight-champions" / "welterweight" / "pound-for-pound" —
   * champion groups (single-entry) always end in "-champions"; numbered
   * divisional groups share the same weightClass but no suffix. Verified
   * live 2026-07-28.
   */
  type?: string;
  /** Absent on the two pound-for-pound groups — that's how they're skipped. */
  weightClass?: RawEspnRankingsWeightClass;
  ranks?: RawEspnRankingsEntry[];
}

interface RawEspnRankingsResponse {
  rankings?: RawEspnRankingsGroup[];
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

const ESPN_SCHEDULE_BASE_URL =
  "https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard";
const ESPN_FIGHTCENTER_BASE_URL =
  "https://site.web.api.espn.com/apis/common/v3/sports/mma/ufc/fightcenter";
const ESPN_ATHLETE_BIO_BASE_URL =
  "https://site.web.api.espn.com/apis/common/v3/sports/mma/ufc/athletes";
/**
 * Returns every division's rankings (plus both pound-for-pound lists) in a
 * single response — no query params needed or honored (verified live
 * 2026-07-28: `?rankingId=6` made no difference). CORS-open, unauthenticated
 * "site API" surface, same class of endpoint as the rest of this file.
 */
const ESPN_RANKINGS_URL = "https://site.api.espn.com/apis/site/v2/sports/mma/ufc/rankings";

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

export function buildEspnAthleteUrl(athleteId: string): string {
  if (athleteId.trim().length === 0) {
    throw new TypeError("ESPN athlete URL requires a non-empty athlete id");
  }

  return `${ESPN_ATHLETE_BIO_BASE_URL}/${encodeURIComponent(athleteId)}`;
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

const DISPLAY_HEIGHT_PATTERN = /^(\d+)'\s*(\d+)"?$/;

/**
 * Fightcenter gives height as `6' 1"` (feet/inches), not the raw-inches
 * number espn.ts's parseFighter gets from the athlete-profile endpoint —
 * this is the only form available here, so it's parsed from the string
 * directly. Mirrors espn.ts's `Math.round(profile.height * 2.54)` rounding
 * style. Never throws on malformed/missing input — omits the field instead.
 */
function parseDisplayHeightCm(displayHeight: string | undefined): number | undefined {
  if (typeof displayHeight !== "string") return undefined;

  const match = displayHeight.trim().match(DISPLAY_HEIGHT_PATTERN);
  const feet = Number(match?.[1]);
  const inches = Number(match?.[2]);
  if (!match || !Number.isFinite(feet) || !Number.isFinite(inches)) return undefined;

  return Math.round(feet * 30.48 + inches * 2.54);
}

const DISPLAY_REACH_PATTERN = /^([\d.]+)"?$/;

/**
 * Fightcenter gives reach as `74"` (inches, occasionally fractional like
 * `74.5"`). Never throws on malformed/missing input — omits the field
 * instead.
 */
function parseDisplayReachCm(displayReach: string | undefined): number | undefined {
  if (typeof displayReach !== "string") return undefined;

  const match = displayReach.trim().match(DISPLAY_REACH_PATTERN);
  const inches = Number(match?.[1]);
  if (!match || !Number.isFinite(inches)) return undefined;

  return Math.round(inches * 2.54);
}

function buildFighter(
  competitor: RawEspnFightcenterCompetitor | undefined,
): EspnScheduledFighter | null {
  if (competitor === undefined) return null;

  const athlete = competitor.athlete;
  const name = athlete?.displayName ?? athlete?.fullName;
  if (typeof name !== "string" || name.length === 0) return null;

  const heightCm = parseDisplayHeightCm(athlete?.displayHeight);
  const reachCm = parseDisplayReachCm(athlete?.displayReach);

  const stats = (competitor.stats ?? [])
    .filter(
      (stat): stat is Required<Pick<RawEspnFightcenterCompetitorStat, "name" | "shortDisplayName" | "displayValue">> =>
        typeof stat.name === "string" &&
        typeof stat.shortDisplayName === "string" &&
        typeof stat.displayValue === "string",
    )
    .map((stat) => ({
      name: stat.name,
      label: stat.shortDisplayName,
      displayValue: stat.displayValue,
    }));

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
    ...(stats.length === 0 ? {} : { stats }),
    ...(athlete?.age === undefined ? {} : { age: athlete.age }),
    ...(heightCm === undefined ? {} : { heightCm }),
    ...(reachCm === undefined ? {} : { reachCm }),
    ...(athlete?.stance?.text === undefined
      ? {}
      : { stance: athlete.stance.text }),
  };
}

/**
 * Mirrors espn.ts's private parseStatus — same status.type.state/completed
 * checks, duplicated locally per this file's established convention rather
 * than imported.
 */
function parseFightStatus(competition: RawEspnFightcenterCompetition): BoutStatus {
  const status = competition.status;

  if (status?.type?.completed || status?.type?.state === "post") return "final";
  if (status?.type?.name === "STATUS_HALFTIME") return "between-rounds";
  if (status?.type?.state === "in") return "in-round";
  return "upcoming";
}

/**
 * Mirrors espn.ts's private parseResult, reusing this file's own
 * parseAthleteBioMethod (defined below) for method normalization instead
 * of a third local copy of the same lowercase/substring matching.
 */
function parseFightResult(
  competition: RawEspnFightcenterCompetition,
): BoutResult | undefined {
  if (parseFightStatus(competition) !== "final") return undefined;

  const winnerRaw = (competition.competitors ?? []).find(
    (competitor) => competitor.winner === true,
  );
  const winnerCorner = winnerRaw ? cornerForRawCompetitor(winnerRaw) : "draw";
  const method = parseAthleteBioMethod(
    competition.result?.method?.displayName ?? competition.result?.method?.name,
  );

  return {
    winner: method === "nc" ? "nc" : winnerCorner,
    method,
    ...(competition.status?.period === undefined
      ? {}
      : { round: competition.status.period }),
    ...(competition.status?.displayClock === undefined
      ? {}
      : { time: competition.status.displayClock }),
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

  const status = parseFightStatus(raw);
  const result = parseFightResult(raw);
  const currentRound = raw.status?.period;

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
    status,
    ...((status === "in-round" || status === "between-rounds") &&
    currentRound !== undefined
      ? { currentRound }
      : {}),
    ...(result === undefined ? {} : { result }),
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

/**
 * Maps ESPN's "W"/"L"/"D"/"NC" game-result letter codes to this project's
 * PastBout result vocabulary. Mirrors espn.ts's private parsePastBoutResult
 * (not exported there, duplicated here per this file's own "Fetch plumbing
 * (copied from espn.ts...)" convention). Unrecognized/missing -> null so
 * the caller drops the entry instead of fabricating a result.
 */
function parseAthleteBioResult(gameResult: string | undefined): PastBout["result"] | null {
  switch (gameResult?.toLowerCase()) {
    case "w":
      return "win";
    case "l":
      return "loss";
    case "d":
      return "draw";
    case "nc":
      return "nc";
    default:
      return null;
  }
}

/**
 * Normalizes ESPN's finish-method strings (e.g. "decision---unanimous",
 * "kotko", "submission") into this project's FinishMethod union. Mirrors
 * espn.ts's private parseMethod — same lowercase + substring checks,
 * duplicated locally rather than imported.
 */
function parseAthleteBioMethod(method: string | undefined): FinishMethod {
  const normalized = method?.toLowerCase() ?? "";

  if (normalized.includes("unanimous")) return "decision-unanimous";
  if (normalized.includes("split")) return "decision-split";
  if (normalized.includes("majority")) return "decision-majority";
  if (normalized.includes("submission")) return "submission";
  if (normalized.includes("tko") || normalized === "ko") return "ko-tko";
  if (normalized.includes("disqualification") || normalized === "dq") {
    return "dq";
  }
  if (normalized.includes("no contest") || normalized === "nc") return "nc";
  return "other";
}

const ATHLETE_BIO_MAX_RECENT_BOUTS = 5;

/**
 * Parses one athlete's ESPN bio payload into a nickname plus up to the 5
 * most recent bouts. `athleteId` guards against normalizing a payload for
 * the wrong athlete when the response happens to carry its own id,
 * mirroring parseEspnFightcenterCard's eventId guard — but tolerates a
 * response with no id field at all (this endpoint's sample payload didn't
 * show one). `eventsMap`'s entries are already newest-first per the live
 * sample captured 2026-07-28, so insertion order is preserved verbatim
 * rather than re-sorted. Never throws on malformed input — returns
 * `{ recentBouts: [] }` instead.
 */
export function parseEspnAthleteBio(
  payload: unknown,
  athleteId: string,
): { nickname?: string; recentBouts: PastBout[] } {
  if (typeof payload !== "object" || payload === null) {
    return { recentBouts: [] };
  }

  const raw = payload as RawEspnAthleteBioResponse;
  const bioAthlete = raw.athlete;
  if (bioAthlete?.id !== undefined && bioAthlete.id !== athleteId) {
    return { recentBouts: [] };
  }

  const eventsMapValue = raw.eventsMap;
  const entries =
    typeof eventsMapValue === "object" && eventsMapValue !== null
      ? Object.values(eventsMapValue)
      : [];

  const recentBouts: PastBout[] = [];
  for (const entry of entries) {
    if (recentBouts.length >= ATHLETE_BIO_MAX_RECENT_BOUTS) break;
    if (typeof entry !== "object" || entry === null) continue;

    const opponentName = entry.opponent?.displayName;
    if (typeof opponentName !== "string" || opponentName.length === 0) {
      continue;
    }

    const result = parseAthleteBioResult(entry.gameResult);
    if (result === null) continue;

    recentBouts.push({
      opponentName,
      result,
      method: parseAthleteBioMethod(
        entry.status?.result?.displayName ?? entry.status?.result?.name,
      ),
      ...(entry.status?.period === undefined
        ? {}
        : { round: entry.status.period }),
      ...(entry.gameDate === undefined ? {} : { date: entry.gameDate }),
      ...(entry.name === undefined ? {} : { eventName: entry.name }),
    });
  }

  return {
    ...(bioAthlete?.nickname === undefined ? {} : { nickname: bioAthlete.nickname }),
    recentBouts,
  };
}

const CHAMPION_TYPE_SUFFIX = "-champions";

/**
 * Parses ESPN's rankings payload into a lookup from athlete id to a short,
 * display-ready divisional ranking string ("#3 Welterweight" / "Welterweight
 * Champion"). Pound-for-pound groups are skipped entirely (they carry no
 * `weightClass`) — divisional rank is what's meaningful for "ranking at the
 * time of this fight". When an athlete id somehow appears in more than one
 * group, the first one wins; ESPN's own payload always lists a division's
 * champion group ahead of its numbered-contenders group, so this naturally
 * prefers "Champion" over a numbered rank. Never throws on malformed input —
 * an unrecognized shape just yields an empty map, matching this file's other
 * parsers' "no data" convention.
 *
 * Quirk: for most divisions, ESPN's numbered "ranks" list redundantly
 * includes that division's own champion (usually at `current: 1`, but not
 * always) ahead of the real numbered contenders. Because the champion group
 * is always processed first, that duplicate entry gets skipped here (its id
 * is already in `result`) — but its raw `current` field is NOT a reliable
 * display rank for the contenders that follow it, since trusting `current`
 * verbatim would shift every real contender's number up by one. Instead,
 * the display rank is derived from each entry's position among the
 * non-duplicate entries, numbered 1, 2, 3... in ESPN's existing (correct)
 * array order.
 */
export function parseEspnRankings(payload: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (typeof payload !== "object" || payload === null) return result;

  const raw = payload as RawEspnRankingsResponse;
  if (!Array.isArray(raw.rankings)) return result;

  for (const group of raw.rankings) {
    if (typeof group !== "object" || group === null) continue;

    const division = group.weightClass?.text;
    if (typeof division !== "string" || division.length === 0) continue;

    const isChampion = typeof group.type === "string" && group.type.endsWith(CHAMPION_TYPE_SUFFIX);
    const ranks = Array.isArray(group.ranks) ? group.ranks : [];

    if (isChampion) {
      for (const entry of ranks) {
        if (typeof entry !== "object" || entry === null) continue;
        const athleteId = entry.athlete?.id;
        if (typeof athleteId !== "string" || athleteId.length === 0) continue;
        if (result.has(athleteId)) continue;
        result.set(athleteId, `${division} Champion`);
      }
      continue;
    }

    let displayRank = 0;
    for (const entry of ranks) {
      if (typeof entry !== "object" || entry === null) continue;

      const athleteId = entry.athlete?.id;
      if (typeof athleteId !== "string" || athleteId.length === 0) continue;

      const current = entry.current;
      if (typeof current !== "number" || !Number.isFinite(current)) continue;
      if (result.has(athleteId)) continue;

      displayRank += 1;
      result.set(athleteId, `#${displayRank} ${division}`);
    }
  }

  return result;
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
const ATHLETE_BIO_REQUEST_TIMEOUT_MS = 8_000;
const ATHLETE_BIO_MAX_RESPONSE_BYTES = 4_000_000;
const RANKINGS_REQUEST_TIMEOUT_MS = 8_000;
const RANKINGS_MAX_RESPONSE_BYTES = 4_000_000;
/**
 * Rankings move at most weekly, nothing like the minute-to-minute data the
 * rest of this file caches — a noticeably longer TTL than `DEFAULT_TTL_MS`
 * keeps this from being re-fetched on every card load.
 */
const RANKINGS_TTL_MS = 45 * 60_000;

type AthleteBio = ReturnType<typeof parseEspnAthleteBio>;

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

  // Per-athlete bio cache (nickname + recent-fight history), independent of
  // the card cache above: a card's shape rarely changes, but an athlete's
  // bio is shared across every card that athlete appears on and is worth
  // caching on its own key. Same TTL-plus-inflight-dedup shape as the card
  // cache; a failed bio fetch is never cached, matching that cache's
  // "failure is never cached — the next call retries" convention.
  const athleteBioCache = new Map<string, CacheEntry<AthleteBio>>();
  const athleteBioInFlight = new Map<string, Promise<AthleteBio>>();

  // Single-entry cache for the rankings lookup (one GET returns every
  // division), independent of the caches above and on its own longer TTL.
  // A failed fetch is never cached, same "next call retries" convention as
  // the rest of this file — enrichCardWithRankings is the one that swallows
  // the failure so it never blocks or fails card loading.
  let rankingsEntry: CacheEntry<Map<string, string>> | undefined;
  let rankingsInFlight: Promise<Map<string, string>> | undefined;

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

  async function fetchAthleteBio(athleteId: string): Promise<AthleteBio> {
    const payload = await fetchJsonWithLimits(buildEspnAthleteUrl(athleteId), {
      timeoutMs: ATHLETE_BIO_REQUEST_TIMEOUT_MS,
      maxBytes: ATHLETE_BIO_MAX_RESPONSE_BYTES,
      fetchImpl,
    });
    return parseEspnAthleteBio(payload, athleteId);
  }

  function getAthleteBio(athleteId: string): Promise<AthleteBio> {
    const nowMs = now().getTime();
    const cached = athleteBioCache.get(athleteId);
    if (cached !== undefined && cached.expiresAt > nowMs) {
      return Promise.resolve(cached.value);
    }
    const inFlight = athleteBioInFlight.get(athleteId);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const promise = fetchAthleteBio(athleteId)
      .then((value) => {
        athleteBioCache.set(athleteId, { expiresAt: now().getTime() + ttlMs, value });
        return value;
      })
      .finally(() => {
        athleteBioInFlight.delete(athleteId);
      });
    athleteBioInFlight.set(athleteId, promise);
    return promise;
  }

  async function fetchRankings(): Promise<Map<string, string>> {
    try {
      const payload = await fetchJsonWithLimits(ESPN_RANKINGS_URL, {
        timeoutMs: RANKINGS_REQUEST_TIMEOUT_MS,
        maxBytes: RANKINGS_MAX_RESPONSE_BYTES,
        fetchImpl,
      });
      return parseEspnRankings(payload);
    } catch (error) {
      throw new Error(
        `Failed to load ESPN UFC rankings: ${messageOf(error)}`,
        { cause: error },
      );
    }
  }

  function getRankingsMap(): Promise<Map<string, string>> {
    const nowMs = now().getTime();
    if (rankingsEntry !== undefined && rankingsEntry.expiresAt > nowMs) {
      return Promise.resolve(rankingsEntry.value);
    }
    if (rankingsInFlight !== undefined) {
      return rankingsInFlight;
    }

    const promise = fetchRankings()
      .then((value) => {
        rankingsEntry = { expiresAt: now().getTime() + RANKINGS_TTL_MS, value };
        return value;
      })
      .finally(() => {
        rankingsInFlight = undefined;
      });
    rankingsInFlight = promise;
    return promise;
  }

  /**
   * Merges each fighter's nickname/recent-fight-history bio onto an
   * already-built card. Every athlete's bio is fetched independently
   * (`Promise.allSettled`) so one athlete's slow or failing bio request
   * never fails or stalls the whole card — a fighter simply keeps
   * whichever fightcenter-only fields it already had (age/height/reach/
   * stance/stats, parsed for free out of the payload `fetchCard` already
   * has) when its bio can't be fetched.
   */
  async function enrichCardWithAthleteBios(
    card: EspnScheduledCard,
  ): Promise<EspnScheduledCard> {
    const athleteIds = new Set<string>();
    for (const section of card.sections) {
      for (const fight of section.fights) {
        if (fight.red.athleteId !== undefined) athleteIds.add(fight.red.athleteId);
        if (fight.blue.athleteId !== undefined) athleteIds.add(fight.blue.athleteId);
      }
    }
    if (athleteIds.size === 0) return card;

    const bios = new Map<string, AthleteBio>();
    await Promise.allSettled(
      Array.from(athleteIds, async (athleteId) => {
        bios.set(athleteId, await getAthleteBio(athleteId));
      }),
    );
    if (bios.size === 0) return card;

    const enrichFighter = (fighter: EspnScheduledFighter): EspnScheduledFighter => {
      const bio = fighter.athleteId !== undefined ? bios.get(fighter.athleteId) : undefined;
      if (bio === undefined) return fighter;
      return {
        ...fighter,
        ...(bio.nickname === undefined ? {} : { nickname: bio.nickname }),
        ...(bio.recentBouts.length === 0 ? {} : { recentBouts: bio.recentBouts }),
      };
    };

    return {
      ...card,
      sections: card.sections.map((section) => ({
        ...section,
        fights: section.fights.map((fight) => ({
          ...fight,
          red: enrichFighter(fight.red),
          blue: enrichFighter(fight.blue),
        })),
      })),
    };
  }

  /**
   * Merges each fighter's divisional ranking onto an already-built card.
   * The rankings fetch is a single shared lookup (not per-athlete), so a
   * failure here means no ranking data for the whole card rather than a
   * per-fighter gap — but exactly like the bio enrichment above, that
   * failure is swallowed rather than propagated: a rankings outage must
   * never fail or block card loading.
   */
  async function enrichCardWithRankings(
    card: EspnScheduledCard,
  ): Promise<EspnScheduledCard> {
    let rankings: Map<string, string>;
    try {
      rankings = await getRankingsMap();
    } catch {
      return card;
    }
    if (rankings.size === 0) return card;

    const enrichFighter = (fighter: EspnScheduledFighter): EspnScheduledFighter => {
      const ranking = fighter.athleteId !== undefined ? rankings.get(fighter.athleteId) : undefined;
      return ranking === undefined ? fighter : { ...fighter, ranking };
    };

    return {
      ...card,
      sections: card.sections.map((section) => ({
        ...section,
        fights: section.fights.map((fight) => ({
          ...fight,
          red: enrichFighter(fight.red),
          blue: enrichFighter(fight.blue),
        })),
      })),
    };
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
      const card = parseEspnFightcenterCard(payload, eventId);
      if (card === null) return null;
      const withBios = await enrichCardWithAthleteBios(card);
      return await enrichCardWithRankings(withBios);
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
