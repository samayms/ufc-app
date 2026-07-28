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
  ticks: MarketTick[];
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
  getTickHistory(
    boutId: string,
    source?: MarketSource,
  ): Promise<MarketTick[]>;
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

/**
 * ---------------------------------------------------------------------------
 * Live response shapes, captured 2026-07-28 from api.odds-api.io/v3 (HTTP 200
 * on both /events and /odds). These differ from the synthetic fixture above in
 * every dimension, so the live path needs its own normalization:
 *
 *   /events  -> a flat array. Each element IS a single bout (there is no
 *               nested `bouts` array); the UFC *card* appears as `league`.
 *               `id` is a number, not a string. Fighter names arrive
 *               surname-first ("de la Rosa, Montana").
 *   /odds    -> `bookmakers` is an object keyed by bookmaker display name,
 *               each mapping to markets `{ name: "ML", updatedAt, odds: [...] }`
 *               where odds entries are `{ home, away }` **decimal strings**
 *               ("3.30"), positional rather than named per fighter.
 *
 * Prices are converted to american-moneyline because that is the only
 * sportsbook shape `NativePrice` models; implied probability is taken
 * straight from the decimal (1/d), which avoids a lossy round trip.
 * ---------------------------------------------------------------------------
 */

/** Order-insensitive, diacritic-insensitive name key ("de la Rosa, Montana"). */
function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((part) => part.length > 0)
    .sort()
    .join(" ");
}

/** Decimal odds -> american moneyline. Returns null for non-positive payouts. */
export function decimalToAmerican(decimal: number): number | null {
  if (!Number.isFinite(decimal) || decimal <= 1) return null;
  const american =
    decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
  return Math.round(american);
}

export interface OddsApiIoLiveBout {
  /** Numeric in the payload; carried as a string in the ExternalRef. */
  externalRef: ExternalRef;
  homeName: string;
  awayName: string;
  startsAt: string;
  leagueName: string;
  leagueSlug: string;
  status: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Normalizes one `/events` element; null when it lacks an id or fighters. */
export function parseOddsApiIoLiveBout(raw: unknown): OddsApiIoLiveBout | null {
  if (typeof raw !== "object" || raw === null) return null;
  const event = raw as Record<string, unknown>;

  const id =
    typeof event.id === "number"
      ? String(event.id)
      : readString(event.id);
  const home = readString(event.home);
  const away = readString(event.away);
  if (id === undefined || home === undefined || away === undefined) return null;

  const league = (event.league ?? {}) as Record<string, unknown>;
  return {
    externalRef: externalRef(id),
    homeName: home,
    awayName: away,
    startsAt: readString(event.date) ?? "",
    leagueName: readString(league.name) ?? "",
    leagueSlug: readString(league.slug) ?? "",
    status: readString(event.status) ?? "",
  };
}

/**
 * Groups a live `/events` array into the discovery shape the collector already
 * consumes: one discovered "event" per league (the UFC card), one bout per API
 * event.
 */
export function parseOddsApiIoEvents(
  payload: unknown,
): OddsApiIoDiscoveredEvent[] {
  if (!Array.isArray(payload)) {
    throw new TypeError("Odds-API.io /events response was not an array");
  }

  const cards = new Map<string, OddsApiIoDiscoveredEvent>();
  for (const raw of payload) {
    const bout = parseOddsApiIoLiveBout(raw);
    if (bout === null) continue;

    const key = bout.leagueSlug.length > 0 ? bout.leagueSlug : bout.leagueName;
    const existing = cards.get(key);
    const discovered: OddsApiIoDiscoveredBout = {
      externalRef: bout.externalRef,
      redFighter: bout.homeName,
      blueFighter: bout.awayName,
    };

    if (existing === undefined) {
      cards.set(key, {
        externalRef: externalRef(key),
        name: bout.leagueName,
        startsAt: bout.startsAt,
        bouts: [discovered],
      });
      continue;
    }

    existing.bouts.push(discovered);
    // The card starts when its earliest bout starts.
    if (
      bout.startsAt.length > 0 &&
      (existing.startsAt.length === 0 || bout.startsAt < existing.startsAt)
    ) {
      existing.startsAt = bout.startsAt;
    }
  }

  return [...cards.values()];
}

interface LiveOddsEntry {
  home?: unknown;
  away?: unknown;
}

/** Which corner the payload's positional `home`/`away` map to for this bout. */
function cornersForLiveOdds(
  bout: Bout,
  homeName: string,
  awayName: string,
): { home: Corner; away: Corner } | null {
  const red = nameKey(bout.fighters.red.name);
  const blue = nameKey(bout.fighters.blue.name);
  const home = nameKey(homeName);
  const away = nameKey(awayName);

  if (home === red && away === blue) return { home: "red", away: "blue" };
  if (home === blue && away === red) return { home: "blue", away: "red" };
  return null;
}

/**
 * Normalizes a live `/odds` payload into an OddsSnapshot. Returns null when the
 * payload does not describe this bout or carries no usable moneyline, so the
 * dashboard renders absence rather than a fabricated price.
 */
export function parseOddsApiIoEventOdds(
  payload: unknown,
  bout: Bout,
  bookmakers: readonly string[],
  fetchedAt: string,
): OddsSnapshot | null {
  if (typeof payload !== "object" || payload === null) {
    throw new TypeError("Odds-API.io /odds response was not a JSON object");
  }
  const event = payload as Record<string, unknown>;
  const home = readString(event.home);
  const away = readString(event.away);
  if (home === undefined || away === undefined) return null;

  const corners = cornersForLiveOdds(bout, home, away);
  if (corners === null) return null;

  const books = event.bookmakers;
  if (typeof books !== "object" || books === null) return null;

  const wanted = new Set(bookmakers.map((book) => book.toLowerCase()));
  const quotes: OddsQuote[] = [];
  let marketUpdatedAt: string | undefined;

  for (const [bookName, markets] of Object.entries(
    books as Record<string, unknown>,
  )) {
    if (wanted.size > 0 && !wanted.has(bookName.toLowerCase())) continue;
    if (!Array.isArray(markets)) continue;

    // "ML" is Odds-API.io's moneyline market name (the fixture called it h2h).
    const moneyline = markets.find(
      (market: unknown) =>
        typeof market === "object" &&
        market !== null &&
        readString((market as Record<string, unknown>).name)?.toUpperCase() ===
          "ML",
    ) as Record<string, unknown> | undefined;
    if (moneyline === undefined) continue;

    const entries = moneyline.odds;
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const entry = entries[0] as LiveOddsEntry;

    const updatedAt = readString(moneyline.updatedAt);
    if (updatedAt !== undefined && (marketUpdatedAt === undefined || updatedAt > marketUpdatedAt)) {
      marketUpdatedAt = updatedAt;
    }

    for (const side of ["home", "away"] as const) {
      const decimal = Number(entry[side]);
      const american = decimalToAmerican(decimal);
      if (american === null) continue;
      quotes.push({
        corner: corners[side],
        native: {
          kind: "american-moneyline",
          moneyline: american,
          book: bookName.toLowerCase(),
        },
        // Straight from the decimal; converting via american would round twice.
        impliedProbability: 1 / decimal,
      });
    }
  }

  if (quotes.length === 0) return null;
  return {
    boutId: bout.id,
    market: "sportsbook",
    quotes,
    ...(marketUpdatedAt === undefined ? {} : { marketUpdatedAt }),
    provenance: {
      source: "odds-api-io",
      fetchedAt,
      synthetic: false,
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
        async getTickHistory() {
          return failClosed();
        },
      };
    }
    return {
      discoverEvents: () => liveHook.discoverEvents(apiKey),
      getBoutOdds: (query) => liveHook.getBoutOdds(apiKey, query),
      // No live tick-history hook exists yet; fail closed rather than
      // silently returning an empty (and misleadingly "no movement") history.
      async getTickHistory() {
        throw new OddsApiIoRequestError(
          "unavailable",
          "Odds-API.io live tick history is not implemented yet",
        );
      },
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
    async getTickHistory(
      boutId: string,
      source?: MarketSource,
    ): Promise<MarketTick[]> {
      if (source !== undefined && source !== "odds-api-io") return [];
      return fixture.ticks.filter((tick) => tick.boutId === boutId);
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
