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
    throw new Error("espn live mode not available yet");
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
