/**
 * Builds the collector's live `DashboardState` from ESPN's public schedule.
 *
 * Before this existed, `DATA_MODE=live` threw at startup ("live transports are
 * not installed") because nothing could produce a live event, which meant the
 * live collector could not boot at all — and with it neither could
 * `/api/upcoming-odds` or anything else the live path needs.
 *
 * The scope here is deliberately narrow. It builds the *card*: the event, its
 * bouts, and each fighter's identity, all from the same public ESPN endpoints
 * the dashboard's own schedule screens already use. It does not invent any
 * live-fight data — every bout starts `upcoming` with an empty `BoutView`, and
 * the existing lifecycle driver, tick store and round pipelines fill those in
 * from real observations during an event. An empty odds panel here means no
 * odds have been collected yet, never a fabricated price.
 *
 * The full live ESPN *fight-data* source (createEspnSource in
 * src/sources/espn.ts) is still unimplemented; this does not change that, and
 * deliberately does not go through it.
 */

import type {
  Bout,
  BoutView,
  DashboardState,
  Fighter,
  FightRecord,
  UfcEvent,
  WeightClass,
} from "../src/schema.ts";
import {
  createEspnScheduleSource,
  eventWithinReviewWindow,
  type EspnScheduledCard,
  type EspnScheduledFight,
  type EspnScheduledFighter,
} from "../src/sources/espnSchedule.ts";

/** ESPN's free-text weight-class labels, mapped onto the schema's enum. */
const WEIGHT_CLASS_BY_LABEL: Record<string, WeightClass> = {
  strawweight: "strawweight",
  flyweight: "flyweight",
  bantamweight: "bantamweight",
  featherweight: "featherweight",
  lightweight: "lightweight",
  welterweight: "welterweight",
  middleweight: "middleweight",
  "light heavyweight": "light-heavyweight",
  heavyweight: "heavyweight",
  "women's strawweight": "womens-strawweight",
  "women's flyweight": "womens-flyweight",
  "women's bantamweight": "womens-bantamweight",
  "women's featherweight": "womens-featherweight",
  catchweight: "catchweight",
};

export function weightClassFromLabel(
  label: string | undefined,
): WeightClass {
  if (label === undefined) return "catchweight";
  const normalized = label.toLocaleLowerCase("en-US").replace(/[’]/gu, "'").trim();
  // Catchweight is the honest fallback for anything unrecognized: it is the
  // schema's own "this bout is not at a standard limit" value, and guessing a
  // division from an unknown label would be worse than saying so.
  return WEIGHT_CLASS_BY_LABEL[normalized] ?? "catchweight";
}

function parseDisplayRecord(record: string | undefined): FightRecord {
  if (record === undefined) {
    return { wins: 0, losses: 0, draws: 0, noContests: 0 };
  }
  const match = record.match(/^(\d+)-(\d+)-(\d+)/u);
  const noContests = record.match(/\((\d+)\s*NC\)/iu);
  return {
    wins: match?.[1] === undefined ? 0 : Number(match[1]),
    losses: match?.[2] === undefined ? 0 : Number(match[2]),
    draws: match?.[3] === undefined ? 0 : Number(match[3]),
    noContests: noContests?.[1] === undefined ? 0 : Number(noContests[1]),
  };
}

function toFighter(
  fighter: EspnScheduledFighter,
  fetchedAt: string,
): Fighter {
  const id =
    fighter.athleteId ??
    fighter.name.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-");
  return {
    id,
    externalRefs:
      fighter.athleteId === undefined
        ? []
        : [{ source: "espn", id: fighter.athleteId }],
    name: fighter.name,
    ...(fighter.nickname === undefined ? {} : { nickname: fighter.nickname }),
    record: parseDisplayRecord(fighter.record),
    ...(fighter.stance === undefined ? {} : { stance: fighter.stance }),
    ...(fighter.heightCm === undefined ? {} : { heightCm: fighter.heightCm }),
    ...(fighter.reachCm === undefined ? {} : { reachCm: fighter.reachCm }),
    ...(fighter.age === undefined ? {} : { age: fighter.age }),
    ...(fighter.country === undefined ? {} : { country: fighter.country }),
    ...(fighter.recentBouts === undefined
      ? {}
      : { recentBouts: fighter.recentBouts }),
    ...(fighter.ranking === undefined ? {} : { ranking: fighter.ranking }),
    provenance: { source: "espn", fetchedAt, synthetic: false },
  };
}

function toBout(
  fight: EspnScheduledFight,
  segment: Bout["segment"],
  eventId: string,
  cardPosition: number,
  fetchedAt: string,
  outlookByBoutId: ReadonlyMap<string, string>,
): Bout {
  // ESPN's fightcenter payload carries no scheduled-rounds field for a future
  // fight; modern UFC convention is five rounds for title fights and main
  // events, three for everything else.
  const scheduledRounds: 3 | 5 =
    fight.titleFight || fight.mainEvent ? 5 : 3;
  return {
    id: fight.competitionId,
    externalRefs: [{ source: "espn", id: fight.competitionId }],
    eventId,
    cardPosition,
    segment,
    weightClass: weightClassFromLabel(fight.weightClassLabel),
    scheduledRounds,
    titleFight: fight.titleFight,
    fighters: {
      red: toFighter(fight.red, fetchedAt),
      blue: toFighter(fight.blue, fetchedAt),
    },
    status: fight.status,
    ...(fight.currentRound === undefined
      ? {}
      : { currentRound: fight.currentRound }),
    ...(fight.result === undefined ? {} : { result: fight.result }),
    ...(outlookByBoutId.get(fight.competitionId) === undefined
      ? {}
      : { outlook: outlookByBoutId.get(fight.competitionId) }),
    provenance: { source: "espn", fetchedAt, synthetic: false },
  };
}

function emptyBoutView(bout: Bout): BoutView {
  return {
    bout,
    rounds: {},
    latestOdds: {},
    oddsHistory: {},
    marketMoves: {},
    preFightOdds: {},
  };
}

/**
 * Converts one ESPN card into the dashboard's event shape. Exported for tests
 * so the mapping can be checked against a fixture card without a network.
 */
export function espnCardToDashboardState(
  card: EspnScheduledCard,
  fetchedAt: string,
  /** Injectable for fixtures; production outlooks are restored by discovery. */
  outlookByBoutId: ReadonlyMap<string, string> = new Map(),
): DashboardState {
  const bouts: Bout[] = [];
  for (const section of card.sections) {
    for (const fight of section.fights) {
      // Announced-but-unbooked slots have no fighters to show.
      if (/\bTBA\b/iu.test(fight.red.name) || /\bTBA\b/iu.test(fight.blue.name)) {
        continue;
      }
      bouts.push(
        toBout(
          fight,
          section.segment ?? "main-card",
          card.eventId,
          bouts.length + 1,
          fetchedAt,
          outlookByBoutId,
        ),
      );
    }
  }

  const event: UfcEvent = {
    id: card.eventId,
    externalRefs: [{ source: "espn", id: card.eventId }],
    name: card.name,
    startsAt: card.startsAt ?? fetchedAt,
    ...(card.venue === undefined ? {} : { venue: card.venue }),
    ...(card.city === undefined ? {} : { city: card.city }),
    bouts,
    provenance: { source: "espn", fetchedAt, synthetic: false },
  };

  const boutViews: Record<string, BoutView> = {};
  for (const bout of bouts) boutViews[bout.id] = emptyBoutView(bout);

  return {
    event,
    boutViews,
  };
}

export interface LoadLiveEventStateOptions {
  now?: () => Date;
  scheduleSource?: ReturnType<typeof createEspnScheduleSource>;
  /** Persisted/recent event ids to try before ESPN's upcoming-only list. */
  preferredEventIds?: readonly string[];
}

/**
 * Loads the nearest upcoming ESPN UFC card as the live dashboard state.
 *
 * "Nearest upcoming" is what the owner is watching: during an event ESPN keeps
 * that event at the head of the schedule until its last bout is final, so this
 * naturally follows the live card without needing separate in-progress
 * detection.
 */
export async function loadLiveEventState(
  options: LoadLiveEventStateOptions,
): Promise<DashboardState> {
  const source = options.scheduleSource ?? createEspnScheduleSource();
  const now = options.now?.() ?? new Date();
  const fetchedAt = now.toISOString();
  for (const eventId of options.preferredEventIds ?? []) {
    const card = await source.getCard(eventId);
    if (
      card === null ||
      card.startsAt === undefined ||
      !eventWithinReviewWindow(card.startsAt, now)
    ) {
      continue;
    }
    const state = espnCardToDashboardState(card, fetchedAt);
    if (state.event.bouts.length > 0) return state;
  }
  const events = await source.listUpcomingEvents();

  for (const summary of events) {
    const card = await source.getCard(summary.eventId);
    if (card === null) continue;
    const state = espnCardToDashboardState(card, fetchedAt);
    if (state.event.bouts.length > 0) return state;
  }

  throw new Error(
    "No upcoming ESPN UFC card with booked bouts was available for live mode",
  );
}
