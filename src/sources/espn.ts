import rawFixture from "../fixtures/espn.json" with { type: "json" };
import type {
  Bout,
  BoutResult,
  BoutStatus,
  Corner,
  ExternalRef,
  Fighter,
  FightRecord,
  FinishMethod,
  PastBout,
  Provenance,
  RoundUpdate,
  UfcEvent,
  WeightClass,
} from "../schema.ts";
import type {
  FighterRecordSource,
  FightDataSource,
  SourceConfig,
} from "./contract.ts";

interface EspnRecord {
  type?: string;
  summary?: string;
}

interface EspnAthleteProfile {
  id?: string;
  displayName?: string;
  nickname?: string;
  age?: number;
  height?: number;
  reach?: number;
  stance?: {
    text?: string;
  };
  citizenship?: string;
  records?: {
    items?: EspnRecord[];
  };
  recentBouts?: Array<{
    opponent?: string;
    outcome?: string;
    method?: string;
    period?: number;
    date?: string;
    event?: string;
  }>;
}

interface EspnCompetitor {
  id?: string;
  order?: number;
  winner?: boolean;
  athlete?: {
    id?: string;
    displayName?: string;
  };
  records?: EspnRecord[];
  statistics?: Array<{ name?: string; displayValue?: string; value?: number }>;
}

interface EspnCompetition {
  id?: string;
  cardPosition?: number;
  segment?: {
    slug?: string;
  };
  type?: {
    slug?: string;
  };
  format?: {
    regulation?: {
      periods?: number;
    };
  };
  titleFight?: boolean;
  status?: {
    period?: number;
    displayClock?: string;
    type?: {
      name?: string;
      state?: string;
      completed?: boolean;
      description?: string;
    };
    result?: {
      name?: string;
      displayName?: string;
    };
  };
  result?: {
    method?: {
      name?: string;
      displayName?: string;
    };
  };
  competitors?: EspnCompetitor[];
}

interface EspnRawPayload {
  fetchedAt?: string;
  canonicalIds?: {
    events?: Record<string, string>;
    bouts?: Record<string, string>;
    fighters?: Record<string, string>;
  };
  event?: {
    header?: {
      id?: string;
      name?: string;
      date?: string;
      venue?: {
        fullName?: string;
        address?: {
          city?: string;
          state?: string;
        };
      };
      competitions?: EspnCompetition[];
    };
  };
  rounds?: Array<{
    competitionId?: string;
    period?: number;
    status?: {
      type?: {
        completed?: boolean;
      };
    };
    summary?: string;
  }>;
  athletes?: EspnAthleteProfile[];
}

const payload = rawFixture as EspnRawPayload;

function provenance(raw: EspnRawPayload): Provenance {
  return {
    source: "espn",
    fetchedAt: raw.fetchedAt ?? "",
    synthetic: true,
  };
}

function espnRef(id: string): ExternalRef {
  return { source: "espn", id };
}

function parseRecord(summary: string | undefined): FightRecord {
  const match = summary?.match(
    /^(\d+)-(\d+)-(\d+)(?:\s*\((\d+)\s*NC\))?$/i,
  );

  return {
    wins: Number(match?.[1] ?? 0),
    losses: Number(match?.[2] ?? 0),
    draws: Number(match?.[3] ?? 0),
    noContests: Number(match?.[4] ?? 0),
  };
}

function parseMethod(method: string | undefined): FinishMethod {
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

function parsePastBoutResult(
  outcome: string | undefined,
): PastBout["result"] | null {
  switch (outcome?.toLowerCase()) {
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

function parsePastBout(
  rawBout: NonNullable<EspnAthleteProfile["recentBouts"]>[number],
): PastBout | null {
  if (!rawBout.opponent) return null;

  const result = parsePastBoutResult(rawBout.outcome);
  if (!result) return null;

  return {
    opponentName: rawBout.opponent,
    result,
    method: parseMethod(rawBout.method),
    ...(rawBout.period === undefined ? {} : { round: rawBout.period }),
    ...(rawBout.date === undefined ? {} : { date: rawBout.date }),
    ...(rawBout.event === undefined ? {} : { eventName: rawBout.event }),
  };
}

function parseFighter(
  raw: EspnRawPayload,
  profile: EspnAthleteProfile,
): Fighter | null {
  if (!profile.id || !profile.displayName) return null;

  const canonicalId = raw.canonicalIds?.fighters?.[profile.id];
  if (!canonicalId) return null;

  const totalRecord = profile.records?.items?.find(
    (record) => record.type === "total",
  );
  const recentBouts = profile.recentBouts
    ?.map(parsePastBout)
    .filter((bout): bout is PastBout => bout !== null);

  return {
    id: canonicalId,
    externalRefs: [espnRef(profile.id)],
    name: profile.displayName,
    ...(profile.nickname === undefined ? {} : { nickname: profile.nickname }),
    record: parseRecord(totalRecord?.summary),
    ...(profile.stance?.text === undefined
      ? {}
      : { stance: profile.stance.text }),
    ...(profile.height === undefined
      ? {}
      : { heightCm: Math.round(profile.height * 2.54) }),
    ...(profile.reach === undefined
      ? {}
      : { reachCm: Math.round(profile.reach * 2.54) }),
    ...(profile.age === undefined ? {} : { age: profile.age }),
    ...(profile.citizenship === undefined
      ? {}
      : { country: profile.citizenship }),
    ...(recentBouts === undefined ? {} : { recentBouts }),
    provenance: provenance(raw),
  };
}

function parseWeightClass(value: string | undefined): WeightClass | null {
  switch (value) {
    case "strawweight":
    case "flyweight":
    case "bantamweight":
    case "featherweight":
    case "lightweight":
    case "welterweight":
    case "middleweight":
    case "light-heavyweight":
    case "heavyweight":
    case "womens-strawweight":
    case "womens-flyweight":
    case "womens-bantamweight":
    case "womens-featherweight":
    case "catchweight":
      return value;
    default:
      return null;
  }
}

function parseStatus(competition: EspnCompetition): BoutStatus {
  const status = competition.status;

  if (status?.type?.completed || status?.type?.state === "post") return "final";
  if (status?.type?.name === "STATUS_HALFTIME") return "between-rounds";
  if (status?.type?.state === "in") return "in-round";
  return "upcoming";
}

function cornerForCompetitor(competitor: EspnCompetitor): Corner {
  return competitor.order === 2 ? "blue" : "red";
}

function parseSegment(slug: string | undefined): Bout["segment"] {
  switch (slug) {
    case "early-prelims":
      return "early-prelims";
    case "prelims":
      return "prelims";
    default:
      return "main-card";
  }
}

function fighterForCorner(
  raw: EspnRawPayload,
  competition: EspnCompetition,
  corner: Corner,
): Fighter | null {
  const competitor = competition.competitors?.find(
    (candidate) => cornerForCompetitor(candidate) === corner,
  );
  const profile = raw.athletes?.find(
    (candidate) => candidate.id === (competitor?.athlete?.id ?? competitor?.id),
  );

  return profile ? parseFighter(raw, profile) : null;
}

function parseResult(competition: EspnCompetition): BoutResult | undefined {
  if (parseStatus(competition) !== "final") return undefined;

  const winner = competition.competitors?.find(
    (competitor) => competitor.winner,
  );
  const winnerCorner = winner ? cornerForCompetitor(winner) : "draw";
  const method = parseMethod(
    competition.status?.result?.displayName ??
      competition.status?.result?.name ??
      competition.result?.method?.displayName ??
      competition.result?.method?.name,
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

function parseBout(
  raw: EspnRawPayload,
  competition: EspnCompetition,
  eventId: string,
): Bout | null {
  if (!competition.id) return null;

  const canonicalId = raw.canonicalIds?.bouts?.[competition.id];
  const weightClass = parseWeightClass(competition.type?.slug);
  const redFighter = fighterForCorner(raw, competition, "red");
  const blueFighter = fighterForCorner(raw, competition, "blue");
  const scheduledPeriods = competition.format?.regulation?.periods;

  if (
    !canonicalId ||
    !weightClass ||
    !redFighter ||
    !blueFighter ||
    competition.cardPosition === undefined ||
    (scheduledPeriods !== 3 && scheduledPeriods !== 5)
  ) {
    return null;
  }

  const status = parseStatus(competition);
  const result = parseResult(competition);
  const currentRound = competition.status?.period;

  return {
    id: canonicalId,
    externalRefs: [espnRef(competition.id)],
    eventId,
    cardPosition: competition.cardPosition,
    segment: parseSegment(competition.segment?.slug),
    weightClass,
    scheduledRounds: scheduledPeriods,
    titleFight: competition.titleFight ?? false,
    fighters: {
      red: redFighter,
      blue: blueFighter,
    },
    status,
    ...((status === "in-round" || status === "between-rounds") &&
    currentRound !== undefined
      ? { currentRound }
      : {}),
    ...(result === undefined ? {} : { result }),
    provenance: provenance(raw),
  };
}

function parseEvent(raw: EspnRawPayload, ref: ExternalRef): UfcEvent | null {
  const header = raw.event?.header;
  if (ref.source !== "espn" || !header?.id || header.id !== ref.id) return null;

  const canonicalId = raw.canonicalIds?.events?.[header.id];
  if (!canonicalId || !header.name || !header.date) return null;

  const bouts = (header.competitions ?? [])
    .map((competition) => parseBout(raw, competition, canonicalId))
    .filter((bout): bout is Bout => bout !== null)
    .sort((left, right) => left.cardPosition - right.cardPosition);
  const city = header.venue?.address?.city;
  const state = header.venue?.address?.state;

  return {
    id: canonicalId,
    externalRefs: [espnRef(header.id)],
    name: header.name,
    startsAt: header.date,
    ...(header.venue?.fullName === undefined
      ? {}
      : { venue: header.venue.fullName }),
    ...(city === undefined
      ? {}
      : { city: state === undefined ? city : `${city}, ${state}` }),
    bouts,
    provenance: provenance(raw),
  };
}

function parseRoundUpdates(raw: EspnRawPayload, bout: Bout): RoundUpdate[] {
  const ref = bout.externalRefs.find(({ source }) => source === "espn");
  if (!ref) return [];

  const knownCompetition = raw.event?.header?.competitions?.some(
    (competition) => competition.id === ref.id,
  );
  if (!knownCompetition) return [];

  return (raw.rounds ?? [])
    .flatMap((round): RoundUpdate[] => {
      if (
        round.competitionId !== ref.id ||
        round.status?.type?.completed !== true ||
        round.period === undefined
      ) {
        return [];
      }

      return [
        {
          boutId: bout.id,
          round: round.period,
          ...(round.summary === undefined ? {} : { summary: round.summary }),
          provenance: provenance(raw),
        },
      ];
    })
    .sort((left, right) => left.round - right.round);
}

export function createEspnSource(
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
      return parseEvent(payload, ref);
    },
    async getRoundUpdates(bout) {
      return parseRoundUpdates(payload, bout);
    },
    async getFighter(ref) {
      if (ref.source !== "espn") return null;

      const profile = payload.athletes?.find((athlete) => athlete.id === ref.id);
      return profile ? parseFighter(payload, profile) : null;
    },
  };
}

/**
 * Lifecycle-only ESPN seam: a normalized per-bout snapshot (state, period,
 * completed, clock) used to drive server/lifecycleDriver.ts. This is
 * intentionally narrower than FightDataSource — it does not attempt live
 * event/fighter discovery, which stays unimplemented (see createEspnSource
 * above) until real credentials and verified endpoints exist.
 */
export interface EspnLifecycleEntry {
  externalId: string;
  state: "pre" | "in" | "post";
  period: number;
  completed: boolean;
  clockSeconds?: number;
  cumulativeStats?: { fighterA: EspnCumulativeStats; fighterB: EspnCumulativeStats };
}

export interface EspnCumulativeStats {
  significantStrikesLanded: number; significantStrikesAttempted: number;
  totalStrikesLanded: number; totalStrikesAttempted: number;
  takedownsLanded: number; takedownsAttempted: number;
  submissionsAttempted: number; reversals: number; controlTimeSeconds: number;
  knockdowns: number; headStrikesLanded: number; headStrikesAttempted: number;
  bodyStrikesLanded: number; bodyStrikesAttempted: number;
  legStrikesLanded: number; legStrikesAttempted: number;
}

export interface EspnLifecycleFetcher {
  fetchLifecycle(eventExternalId: string): Promise<EspnLifecycleEntry[]>;
}

/**
 * ESPN's public "site API" host, used for unauthenticated scoreboard reads.
 * This is the same path `espnSchedule.ts` reads the card from.
 *
 * **ESPN ignores an `event` query parameter.** Verified 2026-07-30: a request
 * for `?event=999999999` returns the current scoreboard byte-for-byte
 * identically to `?event=<a real id>`. An earlier note here claimed addressing
 * was verified and only timing was open; that was wrong in both directions.
 *
 * The parameter appeared to work only because a single UFC event is usually on
 * the board at a time. On a day with more than one — or any time the requested
 * event is not the current one — the caller would silently receive a different
 * event's bouts and drive the lifecycle machine from the wrong fight. That is
 * exactly the confidently-wrong-data failure the freshness design exists to
 * prevent, so this addresses by date (`dates` IS honored) and filters the
 * payload by event id, failing loudly when the requested event is absent.
 */
const ESPN_SCOREBOARD_BASE_URL =
  "https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard";
const ESPN_SCOREBOARD_REQUEST_TIMEOUT_MS = 8_000;
const ESPN_SCOREBOARD_MAX_RESPONSE_BYTES = 2_000_000;

/** ESPN's `dates` parameter format. */
function formatEspnDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

/**
 * Builds a scoreboard URL. Pass `date` to address a specific card; omit it to
 * read whatever is on the board now. There is deliberately no event-id
 * parameter — see the note above.
 */
export function buildEspnScoreboardUrl(
  options: { date?: Date } = {},
): string {
  const url = new URL(ESPN_SCOREBOARD_BASE_URL);
  if (options.date !== undefined) {
    if (Number.isNaN(options.date.getTime())) {
      throw new TypeError("ESPN scoreboard URL requires a valid date");
    }
    url.searchParams.set("dates", formatEspnDate(options.date));
  }
  return url.toString();
}

function parseDisplayClockSeconds(
  displayClock: string | undefined,
): number | undefined {
  const match = displayClock?.trim().match(/^(\d+):(\d{2})$/);
  if (!match?.[1] || !match[2]) return undefined;

  return Number(match[1]) * 60 + Number(match[2]);
}

function parseLifecycleState(
  status: EspnCompetition["status"],
): "pre" | "in" | "post" {
  if (status?.type?.completed || status?.type?.state === "post") return "post";
  if (status?.type?.state === "in") return "in";
  return "pre";
}

function parseStatPair(value: string | undefined): [number, number] {
  const match = value?.match(/(\d+)\s*\/\s*(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

function parseControlSeconds(value: string | undefined): number {
  const match = value?.match(/^(\d+):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

function parseCumulativeStats(competitor: EspnCompetitor): EspnCumulativeStats | undefined {
  if (competitor.statistics === undefined || competitor.statistics.length === 0) return undefined;
  const values = new Map(competitor.statistics.map((stat) => [stat.name?.toLowerCase(), stat.displayValue]));
  const pair = (name: string) => parseStatPair(values.get(name));
  const scalar = (name: string) => Number(values.get(name) ?? 0) || 0;
  const [significantStrikesLanded, significantStrikesAttempted] = pair("significant strikes");
  const [totalStrikesLanded, totalStrikesAttempted] = pair("total strikes");
  const [takedownsLanded, takedownsAttempted] = pair("takedowns");
  const [headStrikesLanded, headStrikesAttempted] = pair("head");
  const [bodyStrikesLanded, bodyStrikesAttempted] = pair("body");
  const [legStrikesLanded, legStrikesAttempted] = pair("leg");
  return { significantStrikesLanded, significantStrikesAttempted, totalStrikesLanded, totalStrikesAttempted, takedownsLanded, takedownsAttempted, submissionsAttempted: scalar("submission attempts"), reversals: scalar("reversals"), controlTimeSeconds: parseControlSeconds(values.get("control time")), knockdowns: scalar("knockdowns"), headStrikesLanded, headStrikesAttempted, bodyStrikesLanded, bodyStrikesAttempted, legStrikesLanded, legStrikesAttempted };
}

/**
 * Pure normalization: raw ESPN scoreboard JSON -> per-bout lifecycle entries.
 *
 * `eventExternalId` selects one event from the payload. It is required in
 * practice because ESPN ignores the `event` query parameter and may return
 * several events; passing it is what keeps the lifecycle machine from being
 * driven by an unrelated card. Omit it only when the caller genuinely wants
 * every competition on the board (the schedule reader's use).
 */
export function parseEspnScoreboardLifecycle(
  payload: unknown,
  eventExternalId?: string,
): EspnLifecycleEntry[] {
  if (typeof payload !== "object" || payload === null) {
    throw new TypeError("ESPN scoreboard response was not a JSON object");
  }

  // The scoreboard returns `events[].competitions[]` (one competition per
  // bout). The `event.header.competitions` path below is the *summary*
  // endpoint's shape, which the bundled fixture uses; it is retained as a
  // fallback so either payload normalizes correctly.
  const raw = payload as EspnRawPayload & {
    events?: Array<{ id?: string; competitions?: EspnCompetition[] }>;
  };

  let competitions: EspnCompetition[];
  if (raw.events !== undefined) {
    const events =
      eventExternalId === undefined
        ? raw.events
        : raw.events.filter((event) => event.id === eventExternalId);

    if (eventExternalId !== undefined && events.length === 0) {
      throw new Error(
        `ESPN scoreboard did not contain event ${eventExternalId}; ` +
          `it returned [${raw.events
            .map((event) => event.id ?? "?")
            .join(", ")}]`,
      );
    }
    competitions = events.flatMap((event) => event.competitions ?? []);
  } else {
    const header = raw.event?.header;
    if (
      eventExternalId !== undefined &&
      header?.id !== undefined &&
      header.id !== eventExternalId
    ) {
      throw new Error(
        `ESPN summary payload was for event ${header.id}, not ${eventExternalId}`,
      );
    }
    competitions = header?.competitions ?? [];
  }

  return competitions.flatMap((competition): EspnLifecycleEntry[] => {
    if (typeof competition.id !== "string") return [];

    const status = competition.status;
    const clockSeconds = parseDisplayClockSeconds(status?.displayClock);
    const competitors = [...(competition.competitors ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const fighterA = competitors[0] === undefined ? undefined : parseCumulativeStats(competitors[0]);
    const fighterB = competitors[1] === undefined ? undefined : parseCumulativeStats(competitors[1]);

    return [
      {
        externalId: competition.id,
        state: parseLifecycleState(status),
        period: status?.period ?? 0,
        completed: status?.type?.completed === true,
        ...(clockSeconds === undefined ? {} : { clockSeconds }),
        ...(fighterA === undefined || fighterB === undefined ? {} : { cumulativeStats: { fighterA, fighterB } }),
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
 * Constructs the live ESPN scoreboard fetcher. Fails closed unless
 * DATA_MODE=live — never constructed in fixture mode, never invoked by
 * tests (which exercise buildEspnScoreboardUrl/parseEspnScoreboardLifecycle
 * as pure functions instead).
 */
export function createLiveEspnLifecycleFetcher(
  config: SourceConfig,
  fetchImpl: typeof fetch = fetch,
): EspnLifecycleFetcher {
  if (config.mode !== "live") {
    throw new Error("ESPN live lifecycle fetcher requires DATA_MODE=live");
  }

  return {
    async fetchLifecycle(eventExternalId) {
      const payload = await fetchJsonWithLimits(buildEspnScoreboardUrl(), {
        timeoutMs: ESPN_SCOREBOARD_REQUEST_TIMEOUT_MS,
        maxBytes: ESPN_SCOREBOARD_MAX_RESPONSE_BYTES,
        fetchImpl,
      });
      // Filtering happens here, not in the query string: ESPN ignores `event`.
      return parseEspnScoreboardLifecycle(payload, eventExternalId);
    },
  };
}
