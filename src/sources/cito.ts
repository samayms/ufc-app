/**
 * Cito free-tier live-update behavior is unverified until tested during a real event.
 */

import rawFixture from "../fixtures/cito/raw.json";
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
} from "../schema/types.ts";
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
