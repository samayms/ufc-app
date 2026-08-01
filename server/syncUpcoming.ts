/**
 * One-shot upcoming-odds sync.
 *
 *   npm run sync:upcoming        fixture payloads, no network
 *   npm run sync:upcoming:live   real ESPN + all four providers
 *
 * It loads the next few ESPN UFC cards, asks every provider what it lists,
 * matches through the shared matcher, merges with the previously persisted
 * document so a failed run never destroys good prices, writes the document
 * the dashboard reads, and exits. No WebSocket is ever opened here — streams
 * belong to the live collector during an active fight, and a scheduled job
 * that leaves sockets open between events is a job that eventually wedges.
 *
 * Exit code is 0 whenever a document was produced, including when individual
 * providers failed: "Kalshi is down" is information the dashboard should
 * display, not a reason for the scheduler to alert. Only an unusable ESPN
 * schedule (no cards at all) exits non-zero.
 */

import { pathToFileURL } from "node:url";

import { loadConfig, type CollectorConfig } from "./config.ts";
import { JsonlStorage } from "./storage.ts";
import {
  syncUpcomingOdds,
  type UpcomingCard,
  type UpcomingMappingOverride,
} from "./upcomingOdds.ts";
import {
  persistUpcomingMappings,
  readUpcomingOddsDocument,
  upcomingOddsPath,
  writeUpcomingOddsDocument,
} from "./upcomingOddsStore.ts";
import {
  createEspnScheduleSource,
  parseEspnFightcenterCard,
  type EspnScheduledCard,
} from "../src/sources/espnSchedule.ts";
import espnFightcenterFixture from "../src/fixtures/espnFightcenter.json" with {
  type: "json",
};
import {
  createFixtureUpcomingProviders,
  FIXTURE_UPCOMING_EVENT_ID,
} from "../src/sources/upcoming/fixtureUpcoming.ts";
import { createKalshiUpcomingProvider } from "../src/sources/upcoming/kalshiUpcoming.ts";
import { createPolymarketUpcomingProvider } from "../src/sources/upcoming/polymarketUpcoming.ts";
import { createOddsApiIoUpcomingProvider } from "../src/sources/upcoming/oddsApiIoUpcoming.ts";
import { createTheOddsApiUpcomingProvider } from "../src/sources/upcoming/theOddsApiUpcoming.ts";
import type { UpcomingOddsProvider } from "../src/sources/upcoming/types.ts";
import { UPCOMING_PROVIDER_LABEL } from "../src/sources/upcoming/types.ts";

/** How many upcoming ESPN cards to sync. The next two cover a normal month. */
export const DEFAULT_UPCOMING_CARD_LIMIT = 2;

/** Flattens an ESPN card into the matcher's input, dropping placeholder bouts. */
export function espnCardToUpcomingCard(
  card: EspnScheduledCard,
): UpcomingCard {
  const bouts = card.sections
    .flatMap((section) => section.fights)
    // ESPN publishes announced-but-unbooked slots as "TBA". They have no
    // fighters to match on and would pollute every candidate list.
    .filter(
      (fight) =>
        !/\bTBA\b/iu.test(fight.red.name) &&
        !/\bTBA\b/iu.test(fight.blue.name) &&
        fight.status === "upcoming",
    )
    .map((fight) => ({
      boutId: fight.competitionId,
      redFighter: fight.red.name,
      blueFighter: fight.blue.name,
      ...(fight.weightClassLabel === undefined
        ? {}
        : { weightClassLabel: fight.weightClassLabel }),
      ...(fight.startsAt === undefined ? {} : { startsAt: fight.startsAt }),
      titleFight: fight.titleFight,
    }));

  return {
    espnEventId: card.eventId,
    name: card.name,
    ...(card.startsAt === undefined ? {} : { startsAt: card.startsAt }),
    bouts,
  };
}

async function loadFixtureCards(): Promise<UpcomingCard[]> {
  const payloads = espnFightcenterFixture as Record<string, unknown>;
  const cards: UpcomingCard[] = [];
  for (const [eventId, payload] of Object.entries(payloads)) {
    const card = parseEspnFightcenterCard(payload, eventId);
    if (card === null) continue;
    const upcoming = espnCardToUpcomingCard(card);
    if (upcoming.bouts.length > 0) cards.push(upcoming);
  }
  // Keep the fixture deterministic: the card the provider fixtures were built
  // against comes first.
  return cards.sort((left, right) =>
    left.espnEventId === FIXTURE_UPCOMING_EVENT_ID
      ? -1
      : right.espnEventId === FIXTURE_UPCOMING_EVENT_ID
        ? 1
        : left.espnEventId.localeCompare(right.espnEventId),
  );
}

async function loadLiveCards(limit: number): Promise<UpcomingCard[]> {
  const source = createEspnScheduleSource();
  const events = await source.listUpcomingEvents();
  const cards: UpcomingCard[] = [];

  for (const event of events.slice(0, limit)) {
    const card = await source.getCard(event.eventId);
    if (card === null) continue;
    const upcoming = espnCardToUpcomingCard(card);
    if (upcoming.bouts.length > 0) cards.push(upcoming);
  }
  return cards;
}

export function createLiveUpcomingProviders(
  config: CollectorConfig,
): UpcomingOddsProvider[] {
  const providers: UpcomingOddsProvider[] = [
    createKalshiUpcomingProvider(),
    createPolymarketUpcomingProvider(),
  ];

  const oddsApiIoKey = config.credentials.ODDS_API_IO_KEY;
  if (oddsApiIoKey !== undefined) {
    providers.push(
      createOddsApiIoUpcomingProvider({
        apiKey: oddsApiIoKey,
        bookmakers: config.oddsApiIoBookmakers,
      }),
    );
  }

  const theOddsApiKey = config.credentials.THE_ODDS_API_KEY;
  if (theOddsApiKey !== undefined) {
    providers.push(
      createTheOddsApiUpcomingProvider({ apiKey: theOddsApiKey }),
    );
  }

  return providers;
}

/**
 * `UPCOMING_MAPPING_OVERRIDES` pins provider markets the matcher will not
 * commit to on names alone, as
 * `[{"provider":"kalshi","externalId":"KXUFCFIGHT-…","boutId":"401869336"}]`.
 */
export function parseOverrides(
  raw: string | undefined,
): UpcomingMappingOverride[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new TypeError("UPCOMING_MAPPING_OVERRIDES must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("UPCOMING_MAPPING_OVERRIDES must be a JSON array");
  }
  return parsed.map((value, index) => {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as Record<string, unknown>).provider !== "string" ||
      typeof (value as Record<string, unknown>).externalId !== "string" ||
      typeof (value as Record<string, unknown>).boutId !== "string"
    ) {
      throw new TypeError(
        `UPCOMING_MAPPING_OVERRIDES[${index}] needs provider, externalId and boutId`,
      );
    }
    return value as unknown as UpcomingMappingOverride;
  });
}

export interface RunSyncResult {
  cards: number;
  bouts: number;
  loadedEntries: number;
  path: string;
}

export async function runUpcomingSync(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunSyncResult> {
  const config = loadConfig(env);
  const live = config.dataMode === "live";
  const cards = live
    ? await loadLiveCards(
        Number(env.UPCOMING_CARD_LIMIT) || DEFAULT_UPCOMING_CARD_LIMIT,
      )
    : await loadFixtureCards();

  if (cards.length === 0) {
    throw new Error(
      "No upcoming ESPN UFC cards with booked bouts were available",
    );
  }

  const providers = live
    ? createLiveUpcomingProviders(config)
    : createFixtureUpcomingProviders();

  const previous = await readUpcomingOddsDocument(config.persistencePath);
  const document = await syncUpcomingOdds({
    cards,
    providers,
    previous,
    overrides: parseOverrides(env.UPCOMING_MAPPING_OVERRIDES),
    synthetic: !live,
    onProviderResult: (provider, run) => {
      const label = UPCOMING_PROVIDER_LABEL[provider];
      console.log(
        run.status === "ok"
          ? `  ${label}: ${run.marketCount} listed, ${run.matchedCount} matched`
          : `  ${label}: failed — ${run.message ?? "unknown error"}`,
      );
    },
  });

  await writeUpcomingOddsDocument(config.persistencePath, document);
  const storage = new JsonlStorage(config.persistencePath);
  const mappings = await persistUpcomingMappings(storage, document);

  const bouts = document.events.reduce(
    (total, event) => total + event.bouts.length,
    0,
  );
  const loadedEntries = document.events.reduce(
    (total, event) =>
      total +
      event.bouts.reduce(
        (boutTotal, bout) =>
          boutTotal +
          Object.values(bout.providers).filter(
            (entry) => entry?.status === "loaded",
          ).length,
        0,
      ),
    0,
  );

  console.log(
    `Persisted ${mappings} mapping record(s); ${loadedEntries} provider price(s) across ${bouts} bout(s).`,
  );
  if (document.unmatchedMarkets.length > 0) {
    console.log(
      `${document.unmatchedMarkets.length} market(s) went unmatched — see "unmatchedMarkets" in the document.`,
    );
  }

  return {
    cards: document.events.length,
    bouts,
    loadedEntries,
    path: upcomingOddsPath(config.persistencePath),
  };
}

async function main(): Promise<void> {
  const mode = process.env.DATA_MODE === "live" ? "live" : "fixture";
  console.log(`Syncing upcoming odds (${mode} mode)…`);
  const result = await runUpcomingSync();
  console.log(
    `Wrote ${result.path} — ${result.cards} card(s), ${result.bouts} bout(s).`,
  );
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main()
    .then(() => {
      // Nothing here holds the loop open, but be explicit: a scheduled job
      // that fails to exit is indistinguishable from one that hung.
      process.exitCode = 0;
    })
    .catch((error: unknown) => {
      console.error(
        error instanceof Error
          ? error.message
          : "Upcoming odds sync failed",
      );
      process.exitCode = 1;
    });
}
