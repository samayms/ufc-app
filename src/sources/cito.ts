/**
 * Cito base URL, auth scheme, and the `GET /ufc/live` response envelope are
 * confirmed live (see src/fixtures/citoLiveLive.json / citoEventsLive.json).
 * Per-bout live-update shape and cadence during an actual event card are
 * still unverified — the captured response had empty `liveBouts`/
 * `nextBouts` arrays.
 */

import rawFixture from "../fixtures/cito.json" with { type: "json" };
import type {
  Bout,
  BoutResult,
  BoutStatus,
  Corner,
  Fighter,
  FinishMethod,
  PastBout,
  Provenance,
  RoundStats,
  RoundUpdate,
  UfcEvent,
  WeightClass,
} from "../schema.ts";
import type {
  FightDataSource,
  FighterRecordSource,
  SourceConfig,
} from "./contract.ts";

interface CitoBoutResult {
  winner_corner: "red" | "blue" | "draw" | "nc";
  method: string;
  round: number | null;
  time: string | null;
}

interface CitoBout {
  id: string;
  card_order: number;
  card_segment: string;
  weight_class: string;
  scheduled_rounds: number;
  title_fight: boolean;
  status: string;
  current_round: number | null;
  red_fighter_id: string;
  blue_fighter_id: string;
  result: CitoBoutResult | null;
}

interface CitoEvent {
  id: string;
  name: string;
  starts_at: string;
  venue: {
    name: string;
    city: string;
  } | null;
  status: string;
  bouts: CitoBout[];
}

interface CitoPastBout {
  opponent_name: string;
  result: string;
  method: string;
  round: number | null;
  date: string | null;
  event_name: string | null;
}

interface CitoFighter {
  id: string;
  full_name: string;
  nickname: string | null;
  record: {
    wins: number;
    losses: number;
    draws: number;
    no_contests: number;
  };
  stance: string | null;
  height_cm: number | null;
  reach_cm: number | null;
  age: number | null;
  country: string | null;
  recent_bouts: CitoPastBout[];
}

interface CitoRoundStats {
  significant_strikes: number;
  total_strikes: number;
  takedowns: number;
  takedowns_attempted: number;
  control_time_seconds: number;
  knockdowns: number;
}

export interface CitoFighterRoundStats {
  significantStrikes?: number;
  totalStrikes?: number;
  takedowns?: number;
  takedownsAttempted?: number;
  controlTimeSeconds?: number;
  knockdowns?: number;
}

export interface CitoRoundStatsPayload {
  boutId?: string;
  round: number;
  fighterA?: CitoFighterRoundStats;
  fighterB?: CitoFighterRoundStats;
  sourceUpdatedAt?: string;
}

export interface CitoRoundStatsFetcher {
  fetchRound(
    boutId: string,
    round: number,
  ): Promise<CitoRoundStatsPayload | null>;
  fetchAllRounds(boutId: string): Promise<CitoRoundStatsPayload[]>;
}

export type CitoRoundStatsErrorKind =
  | "auth"
  | "quota"
  | "transient"
  | "unavailable";

export class CitoRoundStatsRequestError extends Error {
  override readonly name = "CitoRoundStatsRequestError";

  readonly kind: CitoRoundStatsErrorKind;

  readonly status?: number;

  constructor(
    kind: CitoRoundStatsErrorKind,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    if (options?.status !== undefined) this.status = options.status;
  }
}

interface CitoRoundResult {
  round: number;
  status: string;
  score: Record<Corner, number> | null;
  stats: Record<Corner, CitoRoundStats>;
}

interface CitoFixture {
  meta: {
    fetched_at: string;
    plan: string;
  };
  canonical_ids: {
    events: Record<string, string>;
    bouts: Record<string, string>;
    fighters: Record<string, string>;
  };
  event_response: {
    data: CitoEvent;
  };
  round_results_responses: Array<{
    bout_id: string;
    data: CitoRoundResult[];
  }>;
  fighter_responses: Array<{
    data: CitoFighter;
  }>;
}

const fixture = rawFixture as unknown as CitoFixture;

const weightClasses: Record<string, WeightClass> = {
  Bantamweight: "bantamweight",
  Heavyweight: "heavyweight",
  Lightweight: "lightweight",
  Middleweight: "middleweight",
  "Women's Flyweight": "womens-flyweight",
};

const statuses: Record<string, BoutStatus> = {
  scheduled: "upcoming",
  live: "in-round",
  between_rounds: "between-rounds",
  completed: "final",
};

function provenance(): Provenance {
  return {
    source: "cito",
    fetchedAt: fixture.meta.fetched_at,
    synthetic: true,
  };
}

function finishMethod(method: string): FinishMethod {
  switch (method.toUpperCase()) {
    case "KO":
    case "TKO":
    case "KO/TKO":
      return "ko-tko";
    case "SUB":
    case "SUBMISSION":
      return "submission";
    case "U-DEC":
    case "DEC-UNANIMOUS":
      return "decision-unanimous";
    case "S-DEC":
    case "DEC-SPLIT":
      return "decision-split";
    case "M-DEC":
    case "DEC-MAJORITY":
      return "decision-majority";
    case "DQ":
      return "dq";
    case "NC":
      return "nc";
    default:
      return "other";
  }
}

function pastBoutResult(result: string): PastBout["result"] {
  switch (result.toUpperCase()) {
    case "W":
      return "win";
    case "L":
      return "loss";
    case "D":
      return "draw";
    default:
      return "nc";
  }
}

function parsePastBout(raw: CitoPastBout): PastBout {
  return {
    opponentName: raw.opponent_name,
    result: pastBoutResult(raw.result),
    method: finishMethod(raw.method),
    ...(raw.round === null ? {} : { round: raw.round }),
    ...(raw.date === null ? {} : { date: raw.date }),
    ...(raw.event_name === null ? {} : { eventName: raw.event_name }),
  };
}

function findFighter(id: string): CitoFighter | undefined {
  return fixture.fighter_responses.find(({ data }) => data.id === id)?.data;
}

function parseFighter(raw: CitoFighter): Fighter | null {
  const canonicalId = fixture.canonical_ids.fighters[raw.id];
  if (canonicalId === undefined) {
    return null;
  }

  return {
    id: canonicalId,
    externalRefs: [{ source: "cito", id: raw.id }],
    name: raw.full_name,
    ...(raw.nickname === null ? {} : { nickname: raw.nickname }),
    record: {
      wins: raw.record.wins,
      losses: raw.record.losses,
      draws: raw.record.draws,
      noContests: raw.record.no_contests,
    },
    ...(raw.stance === null ? {} : { stance: raw.stance.toLowerCase() }),
    ...(raw.height_cm === null ? {} : { heightCm: raw.height_cm }),
    ...(raw.reach_cm === null ? {} : { reachCm: raw.reach_cm }),
    ...(raw.age === null ? {} : { age: raw.age }),
    ...(raw.country === null ? {} : { country: raw.country }),
    ...(raw.recent_bouts.length === 0
      ? {}
      : { recentBouts: raw.recent_bouts.map(parsePastBout) }),
    provenance: provenance(),
  };
}

function parseBoutResult(raw: CitoBoutResult): BoutResult {
  return {
    winner: raw.winner_corner,
    method: finishMethod(raw.method),
    ...(raw.round === null ? {} : { round: raw.round }),
    ...(raw.time === null ? {} : { time: raw.time }),
  };
}

function parseSegment(cardSegment: string): Bout["segment"] {
  switch (cardSegment) {
    case "main_card":
      return "main-card";
    case "early_prelims":
      return "early-prelims";
    default:
      return "prelims";
  }
}

function parseBout(raw: CitoBout, eventId: string): Bout | null {
  const id = fixture.canonical_ids.bouts[raw.id];
  const weightClass = weightClasses[raw.weight_class];
  const status = statuses[raw.status];
  const redRaw = findFighter(raw.red_fighter_id);
  const blueRaw = findFighter(raw.blue_fighter_id);
  const red = redRaw === undefined ? null : parseFighter(redRaw);
  const blue = blueRaw === undefined ? null : parseFighter(blueRaw);

  if (
    id === undefined ||
    weightClass === undefined ||
    status === undefined ||
    red === null ||
    blue === null
  ) {
    return null;
  }

  return {
    id,
    externalRefs: [{ source: "cito", id: raw.id }],
    eventId,
    cardPosition: raw.card_order,
    segment: parseSegment(raw.card_segment),
    weightClass,
    scheduledRounds: raw.scheduled_rounds === 5 ? 5 : 3,
    titleFight: raw.title_fight,
    fighters: { red, blue },
    status,
    ...(raw.current_round === null ? {} : { currentRound: raw.current_round }),
    ...(raw.result === null ? {} : { result: parseBoutResult(raw.result) }),
    provenance: provenance(),
  };
}

function parseEvent(raw: CitoEvent): UfcEvent | null {
  const id = fixture.canonical_ids.events[raw.id];
  if (id === undefined) {
    return null;
  }

  const bouts: Bout[] = [];
  for (const rawBout of raw.bouts) {
    const bout = parseBout(rawBout, id);
    if (bout !== null) {
      bouts.push(bout);
    }
  }

  return {
    id,
    externalRefs: [{ source: "cito", id: raw.id }],
    name: raw.name,
    startsAt: raw.starts_at,
    ...(raw.venue === null
      ? {}
      : { venue: raw.venue.name, city: raw.venue.city }),
    bouts,
    provenance: provenance(),
  };
}

function parseRoundStats(raw: CitoRoundStats): RoundStats {
  return {
    significantStrikes: raw.significant_strikes,
    totalStrikes: raw.total_strikes,
    takedowns: raw.takedowns,
    takedownsAttempted: raw.takedowns_attempted,
    controlTimeSeconds: raw.control_time_seconds,
    knockdowns: raw.knockdowns,
  };
}

function parsePipelineRoundStats(
  raw: CitoRoundStats,
): CitoFighterRoundStats {
  return {
    significantStrikes: raw.significant_strikes,
    totalStrikes: raw.total_strikes,
    takedowns: raw.takedowns,
    takedownsAttempted: raw.takedowns_attempted,
    controlTimeSeconds: raw.control_time_seconds,
    knockdowns: raw.knockdowns,
  };
}

function fixtureRoundPayloads(
  boutId: string,
): CitoRoundStatsPayload[] {
  const externalBoutId = Object.entries(
    fixture.canonical_ids.bouts,
  ).find(([, canonicalId]) => canonicalId === boutId)?.[0];
  if (externalBoutId === undefined) return [];

  const response = fixture.round_results_responses.find(
    ({ bout_id }) => bout_id === externalBoutId,
  );
  if (response === undefined) return [];

  return response.data
    .filter(({ status }) => status === "completed")
    .map((round) => ({
      boutId,
      round: round.round,
      fighterA: parsePipelineRoundStats(round.stats.red),
      fighterB: parsePipelineRoundStats(round.stats.blue),
      sourceUpdatedAt: fixture.meta.fetched_at,
    }))
    .sort((left, right) => left.round - right.round);
}

export function createFixtureCitoRoundStatsFetcher(): CitoRoundStatsFetcher {
  return {
    async fetchRound(boutId, round) {
      return (
        fixtureRoundPayloads(boutId).find(
          (payload) => payload.round === round,
        ) ?? null
      );
    },
    async fetchAllRounds(boutId) {
      return fixtureRoundPayloads(boutId);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function roundNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function property(
  record: Record<string, unknown>,
  names: readonly string[],
): unknown {
  for (const name of names) {
    if (record[name] !== undefined) return record[name];
  }
  return undefined;
}

const STAT_FIELDS = [
  ["significantStrikes", ["significantStrikes", "significant_strikes"]],
  ["totalStrikes", ["totalStrikes", "total_strikes"]],
  ["takedowns", ["takedowns"]],
  ["takedownsAttempted", ["takedownsAttempted", "takedowns_attempted"]],
  ["controlTimeSeconds", ["controlTimeSeconds", "control_time_seconds"]],
  ["knockdowns", ["knockdowns"]],
] as const;

type FighterPosition = "A" | "B";

function cumulativeMarker(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const [key, raw] of Object.entries(value)) {
    const normalized = key.replace(/[-_]/g, "").toLowerCase();
    if (
      (normalized === "iscumulative" && raw === true) ||
      normalized.includes("cumulative") ||
      normalized.includes("overallstats") ||
      normalized.includes("fighttotals") ||
      normalized.includes("throughround") ||
      (normalized === "scope" &&
        typeof raw === "string" &&
        /^(?:fight|cumulative|overall|total)$/iu.test(raw))
    ) {
      return true;
    }
  }
  return false;
}

function fighterStats(value: unknown): CitoFighterRoundStats | undefined {
  if (!isRecord(value) || cumulativeMarker(value)) return undefined;

  const nested = property(value, [
    "stats",
    "statistics",
    "roundStats",
    "round_stats",
  ]);
  const source = isRecord(nested) ? nested : value;
  if (cumulativeMarker(source)) return undefined;

  const stats: CitoFighterRoundStats = {};
  for (const [normalizedName, names] of STAT_FIELDS) {
    const parsed = finiteNumber(property(source, names));
    if (parsed !== undefined && parsed >= 0) {
      stats[normalizedName] = parsed;
    }
  }
  return Object.keys(stats).length === 0 ? undefined : stats;
}

const POSITION_NAMES: Record<FighterPosition, readonly string[]> = {
  A: ["fighterA", "fighter_a", "red", "redFighter", "red_fighter"],
  B: ["fighterB", "fighter_b", "blue", "blueFighter", "blue_fighter"],
};

function positionFor(value: unknown): FighterPosition | undefined {
  if (!isRecord(value)) return undefined;
  const raw = property(value, [
    "corner",
    "fighterCorner",
    "fighter_corner",
    "side",
    "color",
  ]);
  if (typeof raw !== "string") {
    const fighter = value.fighter;
    return positionFor(fighter);
  }
  const normalized = raw.toLowerCase();
  if (normalized === "red" || normalized === "r") return "A";
  if (normalized === "blue" || normalized === "b") return "B";
  return undefined;
}

function addStats(
  target: CitoFighterRoundStats | undefined,
  next: CitoFighterRoundStats | undefined,
): CitoFighterRoundStats | undefined {
  if (target === undefined) return next;
  if (next === undefined) return target;
  return { ...target, ...next };
}

function boutIdFrom(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return nonEmptyString(property(value, ["boutId", "bout_id"]));
}

function sourceUpdatedAtFrom(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return nonEmptyString(
    property(value, ["sourceUpdatedAt", "source_updated_at", "updatedAt", "updated_at"]),
  );
}

function roundFrom(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  return roundNumber(property(value, ["round", "roundNumber", "round_number"]));
}

function dataWrapper(value: unknown): unknown {
  if (!isRecord(value) || value.data === undefined) return value;
  return value.data;
}

function findRoundRows(payload: unknown, round: number): Record<string, unknown>[] {
  const wrapped = dataWrapper(payload);
  if (Array.isArray(wrapped)) {
    return wrapped.filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) && roundFrom(item) === round,
    );
  }
  if (!isRecord(wrapped)) return [];

  const nestedRows = property(wrapped, ["rounds", "rows"]);
  if (Array.isArray(nestedRows)) {
    return nestedRows.filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) && roundFrom(item) === round,
    );
  }
  return roundFrom(wrapped) === round ? [wrapped] : [];
}

function parseRoundRows(
  rows: readonly Record<string, unknown>[],
): {
  fighterA?: CitoFighterRoundStats;
  fighterB?: CitoFighterRoundStats;
} {
  let fighterA: CitoFighterRoundStats | undefined;
  let fighterB: CitoFighterRoundStats | undefined;

  for (const row of rows) {
    const container = property(row, ["stats", "statistics"]);
    const source = isRecord(container) ? container : row;
    const direct = fighterStats(row) ?? fighterStats(row.fighter);
    for (const position of ["A", "B"] as const) {
      const candidate = property(source, POSITION_NAMES[position]);
      const parsed = fighterStats(candidate);
      if (parsed === undefined) continue;
      if (position === "A") fighterA = addStats(fighterA, parsed);
      else fighterB = addStats(fighterB, parsed);
    }

    const position = positionFor(row) ?? positionFor(source);
    if (position === "A") fighterA = addStats(fighterA, direct);
    if (position === "B") fighterB = addStats(fighterB, direct);
  }

  return {
    ...(fighterA === undefined ? {} : { fighterA }),
    ...(fighterB === undefined ? {} : { fighterB }),
  };
}

/**
 * Parses only explicitly per-round-looking data. The exact Cito round-stats
 * response has not been captured, so this accepts documented-ish wrappers and
 * corner-labeled rows while leaving unrecognized fighters absent.
 */
export function parseCitoRoundStatsResponse(
  payload: unknown,
  round: number,
): CitoRoundStatsPayload | null {
  const rows = findRoundRows(payload, round);
  if (rows.length === 0) return null;

  if (cumulativeMarker(payload) || rows.some(cumulativeMarker)) {
    return { round };
  }

  const parsed = parseRoundRows(rows);
  const first = rows[0];
  return {
    ...(boutIdFrom(first) === undefined ? {} : { boutId: boutIdFrom(first) }),
    round,
    ...(parsed.fighterA === undefined ? {} : { fighterA: parsed.fighterA }),
    ...(parsed.fighterB === undefined ? {} : { fighterB: parsed.fighterB }),
    ...(sourceUpdatedAtFrom(first) === undefined
      ? {}
      : { sourceUpdatedAt: sourceUpdatedAtFrom(first) }),
  };
}

function mergeRoundPayloads(
  boutId: string,
  round: number,
  left: CitoRoundStatsPayload | null,
  right: CitoRoundStatsPayload | null,
): CitoRoundStatsPayload | null {
  if (left === null && right === null) return null;
  return {
    boutId,
    round,
    ...(left?.fighterA === undefined && right?.fighterA === undefined
      ? {}
      : { fighterA: { ...left?.fighterA, ...right?.fighterA } }),
    ...(left?.fighterB === undefined && right?.fighterB === undefined
      ? {}
      : { fighterB: { ...left?.fighterB, ...right?.fighterB } }),
    ...(right?.sourceUpdatedAt ?? left?.sourceUpdatedAt) === undefined
      ? {}
      : {
          sourceUpdatedAt:
            right?.sourceUpdatedAt ?? left?.sourceUpdatedAt,
        },
  };
}

export interface LiveCitoRoundStatsFetcherOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

export function createLiveCitoRoundStatsFetcher(
  options: LiveCitoRoundStatsFetcherOptions,
): CitoRoundStatsFetcher {
  if (options.baseUrl.trim().length === 0) {
    throw new Error(
      "Cito live round-stats fetcher requires a configured base URL",
    );
  }
  const apiKey = options.apiKey.trim();
  if (apiKey.length === 0) {
    throw new Error("Cito live round-stats fetcher requires CITO_API_KEY");
  }
  const timeoutMs = options.timeoutMs ?? CITO_ROUND_STATS_REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? CITO_ROUND_STATS_MAX_RESPONSE_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Cito round-stats timeout must be positive");
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new TypeError("Cito round-stats maximum response size must be positive");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const request = (url: string): Promise<unknown> =>
    fetchJsonWithLimits(url, {
      timeoutMs,
      maxBytes,
      fetchImpl,
      headers: { "x-api-key": apiKey },
    });

  return {
    async fetchRound(boutId, round) {
      const statsPayload = await request(
        buildCitoRoundStatsUrl(options.baseUrl, boutId, round),
      );
      const rowsPayload = await request(
        buildCitoRoundRowsUrl(options.baseUrl, boutId, round),
      );
      return mergeRoundPayloads(
        boutId,
        round,
        parseCitoRoundStatsResponse(statsPayload, round),
        parseCitoRoundStatsResponse(rowsPayload, round),
      );
    },
    async fetchAllRounds(boutId) {
      const payloads: CitoRoundStatsPayload[] = [];
      for (let round = 1; round <= 5; round += 1) {
        const payload = parseCitoRoundStatsResponse(
          await request(buildCitoRoundStatsUrl(options.baseUrl, boutId, round)),
          round,
        );
        if (payload !== null) payloads.push({ ...payload, boutId });
      }
      return payloads;
    },
  };
}

/**
 * Lifecycle-only Cito seam: a normalized per-bout snapshot used as the
 * fallback source for server/lifecycleDriver.ts when ESPN is unavailable.
 * Narrower than FightDataSource — full live event/fighter discovery stays
 * unimplemented (see createCitoSource below) until real credentials and a
 * verified API exist.
 */
export interface CitoLifecycleEntry {
  externalId: string;
  state: "pre" | "in" | "post";
  period: number;
  completed: boolean;
  clockSeconds?: number;
}

export interface CitoLifecycleFetcher {
  fetchLifecycle(eventExternalId: string): Promise<CitoLifecycleEntry[]>;
}

/**
 * Shape of a single item in `data.liveBouts` / `data.nextBouts` on the
 * verified `GET /ufc/live` response. The captured live response (see
 * src/fixtures/citoLiveLive.json) had both arrays empty, so the per-bout
 * field names below are inferred from the naming conventions used
 * elsewhere in that same payload (camelCase, e.g. `eventSlug`,
 * `currentLiveFmid`) rather than confirmed against a populated example.
 * Parsing is deliberately defensive (accepts either camelCase or the
 * snake_case used by the unrelated /ufc/events bout shape) and skips
 * anything that doesn't match instead of throwing, so an unverified guess
 * here degrades safely rather than crashing the poll loop.
 */
interface CitoLiveStateBout {
  id?: unknown;
  boutId?: unknown;
  status?: unknown;
  current_round?: unknown;
  currentRound?: unknown;
  final_round?: unknown;
  finalRound?: unknown;
}

/** Real envelope confirmed from a live GET /ufc/live response (HTTP 200). */
interface CitoLiveStateEnvelope {
  success?: unknown;
  data?: {
    liveBouts?: unknown[];
    nextBouts?: unknown[];
    nextArmedBout?: unknown;
    events?: unknown[];
  };
  meta?: {
    recommendedPollSeconds?: unknown;
    health?: unknown;
    [key: string]: unknown;
  };
}

const CITO_LIVE_STATE_REQUEST_TIMEOUT_MS = 8_000;
const CITO_LIVE_STATE_MAX_RESPONSE_BYTES = 500_000;
const CITO_ROUND_STATS_REQUEST_TIMEOUT_MS = 8_000;
const CITO_ROUND_STATS_MAX_RESPONSE_BYTES = 500_000;

/**
 * Builds the URL for Cito's verified `GET /ufc/live` card-overview
 * endpoint. `baseUrl` is expected to include the `/api/v1` prefix (e.g.
 * `https://api.citoapi.com/api/v1`); resolution is done relative to the
 * base (trailing slash added, no leading slash on the path) so that
 * prefix is preserved instead of being discarded by root-relative
 * resolution. Verified live: `https://api.citoapi.com/api/v1` resolves to
 * `https://api.citoapi.com/api/v1/ufc/live`, which returned HTTP 200.
 *
 * There is no per-event path for the live card overview — Cito's only
 * documented live-state endpoints are this global overview and
 * `ufc/live/{boutId}/state` (per-bout, keyed by bout id, not event id).
 * Selecting a specific event out of the overview response is left to the
 * caller/parser, not the URL.
 */
export function buildCitoLiveStateUrl(baseUrl: string): string {
  if (baseUrl.trim().length === 0) {
    throw new TypeError("Cito live-state URL requires a non-empty base URL");
  }

  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("ufc/live", base).toString();
}

function buildCitoBoutRoundUrl(
  baseUrl: string,
  boutId: string,
  endpoint: "stats" | "rounds",
  round: number,
): string {
  if (baseUrl.trim().length === 0) {
    throw new TypeError("Cito round-stats URL requires a non-empty base URL");
  }
  if (boutId.trim().length === 0) {
    throw new TypeError("Cito round-stats URL requires a non-empty bout id");
  }
  if (!Number.isSafeInteger(round) || round < 1) {
    throw new TypeError("Cito round-stats URL requires a positive round");
  }

  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const path = `ufc/bouts/${encodeURIComponent(boutId)}/${endpoint}`;
  return `${new URL(path, base).toString()}?round=${round}`;
}

export function buildCitoRoundStatsUrl(
  baseUrl: string,
  boutId: string,
  round: number,
): string {
  return buildCitoBoutRoundUrl(baseUrl, boutId, "stats", round);
}

export function buildCitoRoundRowsUrl(
  baseUrl: string,
  boutId: string,
  round: number,
): string {
  return buildCitoBoutRoundUrl(baseUrl, boutId, "rounds", round);
}

function citoLifecycleState(status: string | undefined): "pre" | "in" | "post" {
  switch (status) {
    case "live":
    case "between_rounds":
      return "in";
    case "completed":
      return "post";
    default:
      return "pre";
  }
}

function citoLiveStateBoutEntry(raw: unknown): CitoLifecycleEntry[] {
  if (typeof raw !== "object" || raw === null) return [];
  const bout = raw as CitoLiveStateBout;

  const externalId =
    typeof bout.boutId === "string"
      ? bout.boutId
      : typeof bout.id === "string"
        ? bout.id
        : undefined;
  if (externalId === undefined) return [];

  const status = typeof bout.status === "string" ? bout.status : undefined;
  const currentRound =
    typeof bout.currentRound === "number"
      ? bout.currentRound
      : typeof bout.current_round === "number"
        ? bout.current_round
        : null;
  const finalRound =
    typeof bout.finalRound === "number"
      ? bout.finalRound
      : typeof bout.final_round === "number"
        ? bout.final_round
        : null;

  const completed = status === "completed";
  const period = (completed ? finalRound : currentRound) ?? 0;

  return [
    {
      externalId,
      state: citoLifecycleState(status),
      period,
      completed,
      ...(status === "between_rounds" ? { clockSeconds: 0 } : {}),
    },
  ];
}

/**
 * Pure normalization: raw Cito `GET /ufc/live` JSON -> per-bout lifecycle
 * entries. Real envelope verified live: `{ success, data: { liveBouts,
 * nextBouts, nextArmedBout, events }, meta }` (see
 * src/fixtures/citoLiveLive.json, captured with both bout arrays empty).
 *
 * Only `data.liveBouts` feeds lifecycle entries — those are the bouts
 * actually in progress. `data.nextBouts` are upcoming/armed candidates,
 * not yet in a lifecycle state worth reporting, so they're intentionally
 * excluded. Per-bout field names inside `liveBouts` are unverified (the
 * captured response had none), so extraction is defensive and skips
 * anything that doesn't parse instead of throwing — this must degrade
 * safely (empty arrays, null/missing fields) without crashing the poll
 * loop.
 */
export function parseCitoLiveStateLifecycle(
  payload: unknown,
): CitoLifecycleEntry[] {
  if (typeof payload !== "object" || payload === null) {
    throw new TypeError("Cito live-state response was not a JSON object");
  }

  const envelope = payload as CitoLiveStateEnvelope;
  const data = typeof envelope.data === "object" ? envelope.data : null;
  const liveBouts = Array.isArray(data?.liveBouts) ? data.liveBouts : [];

  return liveBouts.flatMap(citoLiveStateBoutEntry);
}

async function readWithByteLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new CitoRoundStatsRequestError(
        "unavailable",
        "Cito response exceeded the maximum allowed size",
      );
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
      throw new CitoRoundStatsRequestError(
        "unavailable",
        "Cito response exceeded the maximum allowed size",
      );
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
    try {
      const response = await options.fetchImpl(url, {
        signal: controller.signal,
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      });
      if (!response.ok) {
        const kind: CitoRoundStatsErrorKind =
          response.status === 401 || response.status === 403
            ? "auth"
            : response.status === 429
              ? "quota"
              : response.status >= 500
                ? "transient"
                : "unavailable";
        throw new CitoRoundStatsRequestError(
          kind,
          `Cito request failed with HTTP ${response.status}`,
          { status: response.status },
        );
      }

      const text = await readWithByteLimit(response, options.maxBytes);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new CitoRoundStatsRequestError(
          "unavailable",
          "Cito response was not valid JSON",
        );
      }
    } catch (error) {
      if (error instanceof CitoRoundStatsRequestError) throw error;
      if (controller.signal.aborted) {
        throw new CitoRoundStatsRequestError(
          "transient",
          "Cito request timed out",
          { cause: error },
        );
      }
      throw new CitoRoundStatsRequestError(
        "transient",
        "Cito request failed",
        { cause: error },
      );
    }
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

/**
 * Constructs the live Cito live-state fetcher. Fails closed unless
 * DATA_MODE=live, CITO_API_KEY is present, and a base URL is configured —
 * never constructed in fixture mode, never invoked by tests (which exercise
 * buildCitoLiveStateUrl/parseCitoLiveStateLifecycle as pure functions
 * instead). The API key is used only as a request header; it is never
 * logged or included in thrown error messages.
 */
export function createLiveCitoLifecycleFetcher(
  config: SourceConfig,
  options: { baseUrl: string; fetchImpl?: typeof fetch },
): CitoLifecycleFetcher {
  const apiKey = config.credentials?.CITO_API_KEY?.trim();
  if (config.mode !== "live" || !apiKey) {
    throw new Error(
      "Cito live lifecycle fetcher requires DATA_MODE=live and CITO_API_KEY",
    );
  }
  if (options.baseUrl.trim().length === 0) {
    throw new Error(
      "Cito live lifecycle fetcher requires a configured base URL",
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl;

  return {
    async fetchLifecycle(eventExternalId) {
      if (eventExternalId.trim().length === 0) {
        throw new TypeError(
          "Cito live lifecycle fetch requires a non-empty event id",
        );
      }

      // The verified live-state endpoint (`ufc/live`) is a global card
      // overview, not a per-event lookup, so `eventExternalId` isn't part
      // of the URL — see buildCitoLiveStateUrl for why.
      const payload = await fetchJsonWithLimits(buildCitoLiveStateUrl(baseUrl), {
        timeoutMs: CITO_LIVE_STATE_REQUEST_TIMEOUT_MS,
        maxBytes: CITO_LIVE_STATE_MAX_RESPONSE_BYTES,
        fetchImpl,
        headers: { "x-api-key": apiKey },
      });
      return parseCitoLiveStateLifecycle(payload);
    },
  };
}

export function createCitoSource(
  config: SourceConfig,
): FightDataSource & FighterRecordSource {
  if (config.mode === "live") {
    return {
      async getEvent() {
        return null;
      },
      async getRoundUpdates() {
        return [];
      },
      async getFighter() {
        return null;
      },
    };
  }

  return {
    async getEvent(ref) {
      if (ref.source !== "cito") {
        return null;
      }

      const raw = fixture.event_response.data;
      return raw.id === ref.id ? parseEvent(raw) : null;
    },

    async getRoundUpdates(bout) {
      const ref = bout.externalRefs.find(({ source }) => source === "cito");
      if (ref === undefined) {
        return [];
      }

      const response = fixture.round_results_responses.find(
        ({ bout_id }) => bout_id === ref.id,
      );
      if (response === undefined) {
        return [];
      }

      return response.data
        .filter(({ status }) => status === "completed")
        .map(
          (raw): RoundUpdate => ({
            boutId: bout.id,
            round: raw.round,
            ...(raw.score === null ? {} : { score: raw.score }),
            stats: {
              red: parseRoundStats(raw.stats.red),
              blue: parseRoundStats(raw.stats.blue),
            },
            provenance: provenance(),
          }),
        )
        .sort((left, right) => left.round - right.round);
    },

    async getFighter(ref) {
      if (ref.source !== "cito") {
        return null;
      }

      const raw = findFighter(ref.id);
      return raw === undefined ? null : parseFighter(raw);
    },
  };
}
