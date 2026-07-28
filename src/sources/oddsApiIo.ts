import rawFixture from "../fixtures/oddsApiIo.json" with { type: "json" };
import {
  americanToImpliedProb,
  devigPair,
} from "../lib/oddsMath.ts";
import type {
  Bout,
  Corner,
  ExternalRef,
  OddsQuote,
  OddsSnapshot,
} from "../schema.ts";
import type {
  MarketSource,
  MarketTick,
  SourceConfig,
} from "./contract.ts";

interface FixtureOutcome {
  name: string;
  price: number;
}

interface FixtureBookmaker {
  key: string;
  outcomes: FixtureOutcome[];
}

interface FixtureSnapshot {
  boutId: string;
  updatedAt: string;
  bookmakers: FixtureBookmaker[];
}

interface FixtureDiscoveredBout {
  id: string;
  redFighter: string;
  blueFighter: string;
}

interface FixtureDiscoveredEvent {
  id: string;
  name: string;
  startsAt: string;
  bouts: FixtureDiscoveredBout[];
}

interface OddsApiIoFixture {
  eventDiscovery: FixtureDiscoveredEvent[];
  oddsSnapshots: FixtureSnapshot[];
}

export interface OddsApiIoDiscoveredBout {
  externalRef: ExternalRef;
  redFighter: string;
  blueFighter: string;
}

export interface OddsApiIoDiscoveredEvent {
  externalRef: ExternalRef;
  name: string;
  startsAt: string;
  bouts: OddsApiIoDiscoveredBout[];
}

export interface OddsApiIoBoutQuery {
  bout: Bout;
  externalBoutId: string;
  bookmakers: readonly string[];
}

export type OddsApiIoErrorKind =
  | "auth"
  | "quota"
  | "transient"
  | "unavailable";

export class OddsApiIoRequestError extends Error {
  override readonly name = "OddsApiIoRequestError";

  readonly kind: OddsApiIoErrorKind;

  constructor(
    kind: OddsApiIoErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.kind = kind;
  }
}

export interface OddsApiIoLiveHook {
  discoverEvents(apiKey: string): Promise<OddsApiIoDiscoveredEvent[]>;
  getBoutOdds(
    apiKey: string,
    query: OddsApiIoBoutQuery,
  ): Promise<OddsSnapshot | null>;
}

export interface OddsApiIoSource {
  discoverEvents(): Promise<OddsApiIoDiscoveredEvent[]>;
  getBoutOdds(query: OddsApiIoBoutQuery): Promise<OddsSnapshot | null>;
}

const fixture = rawFixture as OddsApiIoFixture;

function externalRef(id: string): ExternalRef {
  return { source: "odds-api-io", id };
}

function copyDiscovery(
  event: FixtureDiscoveredEvent,
): OddsApiIoDiscoveredEvent {
  return {
    externalRef: externalRef(event.id),
    name: event.name,
    startsAt: event.startsAt,
    bouts: event.bouts.map((bout) => ({
      externalRef: externalRef(bout.id),
      redFighter: bout.redFighter,
      blueFighter: bout.blueFighter,
    })),
  };
}

function cornerFor(bout: Bout, fighterName: string): Corner | undefined {
  if (fighterName === bout.fighters.red.name) return "red";
  if (fighterName === bout.fighters.blue.name) return "blue";
  return undefined;
}

function fixtureSnapshot(
  query: OddsApiIoBoutQuery,
  cursor: Map<string, number>,
): OddsSnapshot | null {
  const candidates = fixture.oddsSnapshots.filter(
    (snapshot) => snapshot.boutId === query.externalBoutId,
  );
  if (candidates.length === 0) return null;

  const index = Math.min(
    cursor.get(query.externalBoutId) ?? 0,
    candidates.length - 1,
  );
  const snapshot = candidates[index];
  if (snapshot === undefined) return null;
  cursor.set(query.externalBoutId, index + 1);

  const selected = new Set(
    query.bookmakers.map((bookmaker) => bookmaker.toLowerCase()),
  );
  const quotes: OddsQuote[] = [];
  for (const bookmaker of snapshot.bookmakers) {
    if (!selected.has(bookmaker.key.toLowerCase())) continue;
    for (const outcome of bookmaker.outcomes) {
      const corner = cornerFor(query.bout, outcome.name);
      if (corner === undefined || outcome.price === 0) continue;
      quotes.push({
        corner,
        native: {
          kind: "american-moneyline",
          moneyline: outcome.price,
          book: bookmaker.key.toLowerCase(),
        },
        impliedProbability: americanToImpliedProb(outcome.price),
      });
    }
  }

  if (quotes.length === 0) return null;
  return {
    boutId: query.bout.id,
    market: "sportsbook",
    quotes,
    marketUpdatedAt: snapshot.updatedAt,
    provenance: {
      source: "odds-api-io",
      fetchedAt: snapshot.updatedAt,
      synthetic: true,
    },
  };
}

function requiredApiKey(config: SourceConfig): string {
  const key = config.credentials?.ODDS_API_IO_KEY?.trim();
  if (!key) {
    throw new OddsApiIoRequestError(
      "auth",
      "Odds-API.io live mode requires ODDS_API_IO_KEY",
    );
  }
  return key;
}

export function createOddsApiIoSource(
  config: SourceConfig,
  liveHook?: OddsApiIoLiveHook,
): OddsApiIoSource {
  if (config.mode === "live") {
    const apiKey = requiredApiKey(config);
    if (liveHook === undefined) {
      const failClosed = (): never => {
        throw new OddsApiIoRequestError(
          "unavailable",
          "Odds-API.io live hook is not installed",
        );
      };
      return {
        async discoverEvents() {
          return failClosed();
        },
        async getBoutOdds() {
          return failClosed();
        },
      };
    }
    return {
      discoverEvents: () => liveHook.discoverEvents(apiKey),
      getBoutOdds: (query) => liveHook.getBoutOdds(apiKey, query),
    };
  }

  const cursor = new Map<string, number>();
  return {
    async discoverEvents(): Promise<OddsApiIoDiscoveredEvent[]> {
      return fixture.eventDiscovery.map(copyDiscovery);
    },
    async getBoutOdds(
      query: OddsApiIoBoutQuery,
    ): Promise<OddsSnapshot | null> {
      return fixtureSnapshot(query, cursor);
    },
  };
}

export function sportsbookSnapshotToMarketTicks(
  bout: Bout,
  snapshot: OddsSnapshot,
  source: Extract<MarketSource, "odds-api-io" | "the-odds-api">,
  receivedAt: string,
): MarketTick[] {
  const sourceUpdatedAt =
    snapshot.marketUpdatedAt ?? snapshot.provenance.fetchedAt;
  const ticks: MarketTick[] = snapshot.quotes.flatMap((quote) => {
    if (
      quote.native.kind !== "american-moneyline" ||
      quote.native.moneyline === 0 ||
      !Number.isFinite(quote.impliedProbability) ||
      quote.impliedProbability < 0 ||
      quote.impliedProbability > 1
    ) {
      return [];
    }
    return [{
      source,
      boutId: bout.id,
      bookmaker: quote.native.book.toLowerCase(),
      marketType: "h2h",
      outcome: bout.fighters[quote.corner].name,
      rawOdds: quote.native.moneyline,
      impliedProbability: quote.impliedProbability,
      ...(sourceUpdatedAt.length === 0 ? {} : { sourceUpdatedAt }),
      receivedAt,
      stale: false,
    } satisfies MarketTick];
  });

  const grouped = new Map<string, number[]>();
  ticks.forEach((tick, index) => {
    const key = `${tick.bookmaker ?? ""}\u0000${tick.marketType}`;
    const indexes = grouped.get(key) ?? [];
    indexes.push(index);
    grouped.set(key, indexes);
  });
  for (const indexes of grouped.values()) {
    if (indexes.length !== 2) continue;
    const firstIndex = indexes[0];
    const secondIndex = indexes[1];
    if (firstIndex === undefined || secondIndex === undefined) continue;
    const first = ticks[firstIndex];
    const second = ticks[secondIndex];
    if (
      first?.impliedProbability === undefined ||
      second?.impliedProbability === undefined
    ) {
      continue;
    }
    const noVig = devigPair(
      first.impliedProbability,
      second.impliedProbability,
    );
    first.noVigProbability = noVig.red;
    second.noVigProbability = noVig.blue;
  }
  return ticks;
}
