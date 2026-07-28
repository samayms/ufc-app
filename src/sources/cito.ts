/**
 * Cito free-tier live-update behavior is unverified until tested during a real event.
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
  boutId: string;
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

export function createLiveCitoRoundStatsFetcher(): CitoRoundStatsFetcher {
  return {
    async fetchRound() {
      throw new Error("Cito live round-stats transport is not installed");
    },
    async fetchAllRounds() {
      throw new Error("Cito live round-stats transport is not installed");
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

interface CitoLiveStateBout {
  id?: string;
  status?: string;
  current_round?: number | null;
  final_round?: number | null;
}

interface CitoLiveStatePayload {
  bouts?: CitoLiveStateBout[];
}

const CITO_LIVE_STATE_REQUEST_TIMEOUT_MS = 8_000;
const CITO_LIVE_STATE_MAX_RESPONSE_BYTES = 500_000;

/**
 * Cito's live-state endpoint shape and host are unverified — no confirmed
 * API documentation exists (see the file-level note above). `baseUrl` must
 * be supplied explicitly (e.g. from CITO_API_BASE_URL) once real access is
 * provisioned; there is no built-in default.
 */
export function buildCitoLiveStateUrl(
  baseUrl: string,
  eventExternalId: string,
): string {
  if (baseUrl.trim().length === 0) {
    throw new TypeError("Cito live-state URL requires a non-empty base URL");
  }
  if (eventExternalId.trim().length === 0) {
    throw new TypeError("Cito live-state URL requires a non-empty event id");
  }

  return new URL(
    `/events/${encodeURIComponent(eventExternalId)}/live`,
    baseUrl,
  ).toString();
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

/** Pure normalization: raw Cito live-state JSON -> per-bout lifecycle entries. */
export function parseCitoLiveStateLifecycle(
  payload: unknown,
): CitoLifecycleEntry[] {
  if (typeof payload !== "object" || payload === null) {
    throw new TypeError("Cito live-state response was not a JSON object");
  }

  const bouts = (payload as CitoLiveStatePayload).bouts ?? [];

  return bouts.flatMap((bout): CitoLifecycleEntry[] => {
    if (typeof bout.id !== "string") return [];

    const completed = bout.status === "completed";
    const period = (completed ? bout.final_round : bout.current_round) ?? 0;

    return [
      {
        externalId: bout.id,
        state: citoLifecycleState(bout.status),
        period,
        completed,
        ...(bout.status === "between_rounds" ? { clockSeconds: 0 } : {}),
      },
    ];
  });
}

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
      const payload = await fetchJsonWithLimits(
        buildCitoLiveStateUrl(baseUrl, eventExternalId),
        {
          timeoutMs: CITO_LIVE_STATE_REQUEST_TIMEOUT_MS,
          maxBytes: CITO_LIVE_STATE_MAX_RESPONSE_BYTES,
          fetchImpl,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      );
      return parseCitoLiveStateLifecycle(payload);
    },
  };
}

export function createCitoSource(
  config: SourceConfig,
): FightDataSource & FighterRecordSource {
  if (config.mode === "live") {
    throw new Error("cito live mode not available yet");
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
