import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";
import type {
  BoutView,
  DashboardState,
  ExternalRef,
  OddsSnapshot,
  SourceId,
} from "../src/schema.ts";
import {
  createCitoSource,
  createFixtureCitoRoundStatsFetcher,
  type CitoRoundStatsFetcher,
} from "../src/sources/cito.ts";
import type { SourceConfig } from "../src/sources/contract.ts";
import { createEspnSource } from "../src/sources/espn.ts";
import { fetchEspnCoreCumulativeStats } from "../src/sources/espnCoreStats.ts";
import { createKalshiSource } from "../src/sources/kalshi.ts";
import {
  createOddsApiSource,
  createTheOddsApiLiveHook,
  type TheOddsApiLiveHook,
  type TheOddsApiSource,
} from "../src/sources/oddsapi.ts";
import {
  createOddsApiIoLiveHook,
  createOddsApiIoSource,
  type OddsApiIoLiveHook,
  type OddsApiIoSource,
} from "../src/sources/oddsApiIo.ts";
import { createPolymarketSource } from "../src/sources/polymarket.ts";
import { createSherdogSource } from "../src/sources/sherdog.ts";
import {
  createDisabledSummarizer,
  createLiveGeminiSummarizer,
  type RoundSummarizer,
} from "./geminiSummarizer.ts";
import { marketMovesForBout } from "../src/lib/oddsMath.ts";
import { loadFixtureEvent } from "../src/store/fixtureEvent.ts";
import {
  credentialValues,
  loadConfig,
  type CollectorConfig,
  type CollectorEnvironment,
} from "./config.ts";
import {
  CollectorEventBus,
  type CollectorEvent,
} from "./eventBus.ts";
import {
  SourceHealthRegistry,
  SOURCE_HEALTH_STORAGE_STREAM,
  type HealthAlert,
  type MetricsSnapshot,
  type SourceHealth,
} from "./health.ts";
import {
  FightLifecycleMachine,
  type FightLifecycleObservation,
} from "./lifecycle.ts";
import {
  createFixtureLifecycleProvider,
  createLiveEspnLifecycleProvider,
  LifecycleDriver,
  type LifecycleDriverClock,
  type LifecycleDriverTimer,
  type LifecycleObservationProvider,
} from "./lifecycleDriver.ts";
import {
  PreEventPoller,
  type PreEventPollerOptions,
} from "./preEventPoller.ts";
import {
  createBoutMappingRegistry,
  type BoutMapping,
  type BoutMappingRegistry,
  type ManualBoutMappingOverride,
} from "./mapping.ts";
import {
  type MarketTransport,
  type ReplayMarketTransport,
  resolveMarketSubscriptions,
} from "./marketTransport.ts";
import {
  OddsApiIoPoller,
  type OddsApiIoPollTimer,
} from "./oddsApiIoPoller.ts";
import {
  createKalshiLiveTransport,
  KalshiFixtureTransport,
} from "./kalshiTransport.ts";
import {
  createPolymarketLiveTransport,
  PolymarketFixtureTransport,
} from "./polymarketTransport.ts";
import {
  sanitizeClientPayload,
  SsePush,
  type SsePushOptions,
} from "./push.ts";
import { ReviewRegistry } from "./review.ts";
import type { QuotaPolicy } from "./quota.ts";
import {
  TerminalRoundJobError,
  type RoundJobClock,
  type RoundJobTimer,
} from "./roundJobs.ts";
import {
  RoundStatsPipeline,
  type UnifiedRoundRecord,
} from "./roundStats.ts";
import {
  createFixtureSherdogFetcher,
  createLiveSherdogFetcher,
  SherdogRoundJobs,
  type SherdogFetcher,
} from "./sherdogJobs.ts";
import {
  SherdogEventDiscovery,
  type SherdogEventDiscoveryController,
} from "./sherdogEventDiscovery.ts";
import {
  createDisabledFightOutlookSummarizer,
  createLiveFightOutlookSummarizer,
  type FightOutlookSummarizer,
} from "./sherdogOutlookSummarizer.ts";
import {
  JsonlStorage,
  type Storage,
} from "./storage.ts";
import { readUpcomingOddsDocument } from "./upcomingOddsStore.ts";
import { importCurrentEventUpcomingMappings } from "./upcomingMappingBridge.ts";
import { loadLiveEventState } from "./liveEventState.ts";
import { TheOddsApiActivePoller } from "./theOddsApiActivePoller.ts";
import {
  MarketTickStore,
  type LocalOrderBookState,
  type MarketSnapshot,
  type TickStoreClock,
} from "./tickStore.ts";
import { TheOddsApiRoundJob } from "./theOddsApiJob.ts";
import { isEventCalendarDay } from "./espnPollingSchedule.ts";

export const COLLECTOR_STATE_STREAM = "collector-state";
export const COLLECTOR_HEALTH_STREAM = SOURCE_HEALTH_STORAGE_STREAM;
export type {
  SourceHealth,
  SourceHealthStatus,
} from "./health.ts";

export interface CollectorBootstrap {
  state: DashboardState | null;
  boutMappings: BoutMapping[];
  health: Readonly<Record<string, SourceHealth>>;
  /** Latest source clock/state observation per bout, used to seed local clocks. */
  lifecycleObservations: readonly FightLifecycleObservation[];
  unifiedRounds: readonly UnifiedRoundRecord[];
  marketSnapshots: readonly MarketSnapshot[];
  latestMarkets: readonly LocalOrderBookState[];
  metrics: MetricsSnapshot;
  alerts: readonly HealthAlert[];
}

export interface CollectorRoundStatsOptions {
  fetcher?: CitoRoundStatsFetcher;
  clock?: RoundJobClock;
  timer?: RoundJobTimer;
  initialDelayMs?: number;
  retryDelayMs?: number;
  quotaPolicy?: QuotaPolicy;
}

/** @deprecated Cito is intentionally ignored by the ESPN-only live collector. */
export interface CollectorCitoOptions {
  discoveryTransport?: unknown;
}

/** Keeps vendor ids at the source boundary; round jobs continue to use canonical ids. */
export function createCitoRoundStatsRefTranslator(
  fetcher: CitoRoundStatsFetcher,
  getExternalRefs: (internalBoutId: string) => readonly ExternalRef[],
  onMissingRef: (internalBoutId: string) => void,
): CitoRoundStatsFetcher {
  const reportedMissing = new Set<string>();
  const resolve = (internalBoutId: string): string | undefined => {
    const ref = getExternalRefs(internalBoutId).find(
      (candidate) => candidate.source === "cito",
    );
    if (ref !== undefined) return ref.id;
    if (!reportedMissing.has(internalBoutId)) {
      reportedMissing.add(internalBoutId);
      onMissingRef(internalBoutId);
    }
    return undefined;
  };

  return {
    async fetchRound(internalBoutId, round) {
      const citoBoutId = resolve(internalBoutId);
      return citoBoutId === undefined
        ? null
        : fetcher.fetchRound(citoBoutId, round);
    },
    async fetchAllRounds(internalBoutId) {
      const citoBoutId = resolve(internalBoutId);
      return citoBoutId === undefined
        ? []
        : fetcher.fetchAllRounds(citoBoutId);
    },
  };
}

export interface CollectorMarketOptions {
  clock?: TickStoreClock;
  staleAfterMs?: number;
  transports?: readonly MarketTransport[];
}

export interface CollectorSportsbookOptions {
  clock?: RoundJobClock;
  timer?: OddsApiIoPollTimer & RoundJobTimer;
  random?: () => number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  oddsApiIoLiveHook?: OddsApiIoLiveHook;
  theOddsApiLiveHook?: TheOddsApiLiveHook;
  oddsApiIoSource?: OddsApiIoSource;
  theOddsApiSource?: TheOddsApiSource;
  oddsApiIoQuotaPolicy?: QuotaPolicy;
}

export interface CollectorSherdogOptions {
  fetcher?: SherdogFetcher;
  summarizer?: RoundSummarizer;
  fightOutlookSummarizer?: FightOutlookSummarizer;
  eventDiscovery?: SherdogEventDiscoveryController;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export interface CollectorLifecycleDriverOptions {
  /** Overrides config.lifecycleDriverEnabled (defaults to live mode only; see README). */
  enabled?: boolean;
  espnProvider?: LifecycleObservationProvider;
  citoProvider?: LifecycleObservationProvider;
  clock?: LifecycleDriverClock;
  timer?: LifecycleDriverTimer;
}

export interface CollectorPreEventPollOptions {
  /** Overrides config.preEventPollEnabled (defaults to live mode only). */
  enabled?: boolean;
  runSync?: PreEventPollerOptions["runSync"];
  readDocument?: PreEventPollerOptions["readDocument"];
  clock?: PreEventPollerOptions["clock"];
  timer?: PreEventPollerOptions["timer"];
}

export type NormalizedStateLoader = (
  config: CollectorConfig,
) => Promise<DashboardState>;

export interface CreateCollectorOptions {
  env?: CollectorEnvironment;
  storage?: Storage;
  stateLoader?: NormalizedStateLoader;
  manualBoutMappingOverrides?: readonly ManualBoutMappingOverride[];
  host?: string;
  sse?: Pick<
    SsePushOptions,
    "bufferSize" | "heartbeatMs" | "now" | "flushIntervalMs"
  >;
  roundStats?: CollectorRoundStatsOptions;
  /** Retained only so older fixture callers remain source-compatible. */
  cito?: CollectorCitoOptions;
  market?: CollectorMarketOptions;
  sportsbook?: CollectorSportsbookOptions;
  sherdog?: CollectorSherdogOptions;
  lifecycle?: CollectorLifecycleDriverOptions;
  preEventPoll?: CollectorPreEventPollOptions;
  health?: {
    now?: () => string;
    persistIntervalMs?: number;
    staleAfterMs?: Readonly<Record<string, number>>;
    quotaThresholds?: Readonly<Record<string, number>>;
  };
}

export interface Collector {
  readonly config: CollectorConfig;
  readonly eventBus: CollectorEventBus;
  readonly boutMappings: BoutMappingRegistry;
  readonly push: SsePush;
  readonly roundStats: RoundStatsPipeline;
  readonly tickStore: MarketTickStore;
  readonly marketTransports: readonly MarketTransport[];
  readonly oddsApiIoPoller: OddsApiIoPoller;
  readonly theOddsApiJob: TheOddsApiRoundJob;
  readonly theOddsApiActivePoller: TheOddsApiActivePoller;
  readonly sherdogJobs: SherdogRoundJobs;
  readonly sherdogDiscovery?: SherdogEventDiscoveryController;
  readonly lifecycle: FightLifecycleMachine;
  readonly lifecycleDriver: LifecycleDriver;
  readonly preEventPoller: PreEventPoller;
  readonly health: SourceHealthRegistry;
  readonly review: ReviewRegistry;
  readonly server: Server;
  start(): Promise<number>;
  close(): Promise<void>;
  replayMarkets(): Promise<void>;
  getBootstrap(): CollectorBootstrap;
  publishHealth(health: SourceHealth): Promise<boolean>;
}

interface PersistedCollectorState {
  version: 1;
  state: DashboardState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDashboardState(value: unknown): value is DashboardState {
  return (
    isRecord(value) &&
    isRecord(value.event) &&
    typeof value.event.id === "string" &&
    Array.isArray(value.event.bouts) &&
    isRecord(value.boutViews)
  );
}

function isPersistedCollectorState(
  value: unknown,
): value is PersistedCollectorState {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isDashboardState(value.state)
  );
}

function latestSourceTimestamp(
  state: DashboardState,
  source: SourceId,
): string | undefined {
  const timestamps: string[] = [];
  const record = (candidate: string | undefined): void => {
    if (candidate) timestamps.push(candidate);
  };

  if (state.event.provenance.source === source) {
    record(state.event.provenance.fetchedAt);
  }

  for (const view of Object.values(state.boutViews)) {
    if (view.bout.provenance.source === source) {
      record(view.bout.provenance.fetchedAt);
    }
    for (const round of view.rounds[source] ?? []) {
      record(round.provenance.fetchedAt);
    }
    for (const snapshots of Object.values(view.oddsHistory)) {
      for (const snapshot of snapshots ?? []) {
        if (snapshot.provenance.source === source) {
          record(
            snapshot.marketUpdatedAt ?? snapshot.provenance.fetchedAt,
          );
        }
      }
    }
  }

  return timestamps.sort().at(-1);
}

function fixtureHealth(state: DashboardState): SourceHealth[] {
  const sources: SourceId[] = [
    "fixture",
    "espn",
    "cito",
    "sherdog",
    "kalshi",
    "polymarket",
    "odds-api-io",
    "odds-api",
  ];

  return sources.map((source) => {
    const sourceUpdatedAt =
      latestSourceTimestamp(state, source) ??
      state.event.provenance.fetchedAt;

    return {
      source,
      status: "healthy",
      fresh: true,
      checkedAt: sourceUpdatedAt,
      sourceUpdatedAt,
    };
  });
}

export async function loadFixtureState(): Promise<DashboardState> {
  const sourceConfig: SourceConfig = { mode: "fixture" };
  const event = loadFixtureEvent();
  const polymarket = createPolymarketSource(sourceConfig);
  const oddsApi = createOddsApiSource(sourceConfig);
  const sherdog = createSherdogSource(sourceConfig);
  const kalshi = createKalshiSource(sourceConfig);
  const espn = createEspnSource(sourceConfig);
  const cito = createCitoSource(sourceConfig);
  const boutViews: Record<string, BoutView> = {};

  for (const bout of event.bouts) {
    const polymarketSnapshot =
      await polymarket.getOddsSnapshot(bout);
    const sportsbookSnapshot =
      await oddsApi.getOddsSnapshot(bout);
    const kalshiSnapshot = await kalshi.getOddsSnapshot(bout);
    const sherdogRounds = await sherdog.getRoundUpdates(bout);
    const espnRounds = await espn.getRoundUpdates(bout);
    const citoRounds = await cito.getRoundUpdates(bout);
    const kalshiTicks = await kalshi.getTickHistory(bout.id);
    const polymarketTicks = await polymarket.getTickHistory(bout.id);
    const sportsbookTicks = await oddsApi.getTickHistory(bout.id);
    const latestOdds: BoutView["latestOdds"] = {};
    const oddsHistory: BoutView["oddsHistory"] = {};
    // Populated from the tick store's pre-fight boundary snapshots.
    const preFightOdds: BoutView["preFightOdds"] = {};

    const recordOdds = (
      market: OddsSnapshot["market"],
      snapshot: OddsSnapshot | null,
    ): void => {
      if (snapshot === null) return;
      latestOdds[market] = snapshot;
      oddsHistory[market] = [snapshot];
    };

    recordOdds("kalshi", kalshiSnapshot);
    recordOdds("polymarket", polymarketSnapshot);
    recordOdds("sportsbook", sportsbookSnapshot);

    const marketMoves: BoutView["marketMoves"] = {};
    const recordMoves = (
      market: OddsSnapshot["market"],
      ticks: Awaited<ReturnType<typeof kalshi.getTickHistory>>,
    ): void => {
      const moves = marketMovesForBout(bout, ticks);
      if (Object.keys(moves).length > 0) marketMoves[market] = moves;
    };
    recordMoves("kalshi", kalshiTicks);
    recordMoves("polymarket", polymarketTicks);
    recordMoves("sportsbook", sportsbookTicks);

    const rounds: BoutView["rounds"] = {};
    if (sherdogRounds.length > 0) rounds.sherdog = sherdogRounds;
    if (espnRounds.length > 0) rounds.espn = espnRounds;
    if (citoRounds.length > 0) rounds.cito = citoRounds;

    boutViews[bout.id] = {
      bout,
      rounds,
      latestOdds,
      oddsHistory,
      preFightOdds,
      marketMoves,
    };
  }

  return { event, boutViews };
}

async function defaultStateLoader(
  config: CollectorConfig,
): Promise<DashboardState> {
  if (config.dataMode === "fixture") {
    return loadFixtureState();
  }

  // Live mode builds the card from ESPN's public schedule. Every bout starts
  // with an empty BoutView; the lifecycle driver, tick store and round
  // pipelines fill those in from real observations during the event.
  return loadLiveEventState({});
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  secrets: readonly string[],
): void {
  const body = JSON.stringify(sanitizeClientPayload(payload, secrets));
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Length": String(new TextEncoder().encode(body).byteLength),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(body);
}

class HttpRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpRequestError";
    this.status = status;
  }
}

function readJsonBody(
  request: IncomingMessage,
  maximumBytes = 16_384,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.byteLength;
      if (size > maximumBytes) {
        rejected = true;
        reject(new HttpRequestError(413, "JSON body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      if (size === 0) {
        reject(new HttpRequestError(400, "JSON body is required"));
        return;
      }
      try {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
      } catch {
        reject(new HttpRequestError(400, "Body must be valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

const MAPPING_OVERRIDE_SOURCES = new Set<SourceId>([
  "espn",
  "sherdog",
  "cito",
  "kalshi",
  "polymarket",
  "odds-api-io",
  "odds-api",
  "x-embed",
  "fixture",
]);

function parseMappingOverride(value: unknown): ManualBoutMappingOverride {
  if (!isRecord(value)) {
    throw new HttpRequestError(400, "Mapping override must be an object");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "externalRef" ||
    keys[1] !== "internalBoutId" ||
    typeof value.internalBoutId !== "string" ||
    value.internalBoutId.trim().length === 0 ||
    !isRecord(value.externalRef)
  ) {
    throw new HttpRequestError(
      400,
      "Mapping override requires only internalBoutId and externalRef",
    );
  }
  const refKeys = Object.keys(value.externalRef).sort();
  const source = value.externalRef.source;
  const id = value.externalRef.id;
  if (
    refKeys.length !== 2 ||
    refKeys[0] !== "id" ||
    refKeys[1] !== "source" ||
    typeof source !== "string" ||
    !MAPPING_OVERRIDE_SOURCES.has(source as SourceId) ||
    typeof id !== "string" ||
    id.trim().length === 0
  ) {
    throw new HttpRequestError(
      400,
      "externalRef requires only a supported source and non-empty id",
    );
  }
  return {
    internalBoutId: value.internalBoutId,
    externalRef: { source: source as SourceId, id },
  };
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Collector did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function createCollector(
  options: CreateCollectorOptions = {},
): Promise<Collector> {
  const config = loadConfig(options.env);
  const storage =
    options.storage ?? new JsonlStorage(config.persistencePath);
  const stateRecords =
    await storage.read<unknown>(COLLECTOR_STATE_STREAM);
  const restoredState = stateRecords
    .filter(isPersistedCollectorState)
    .at(-1)?.state;
  let state: DashboardState | null = restoredState ?? null;
  let boutMappings: BoutMappingRegistry | undefined;
  let roundStats: RoundStatsPipeline | undefined;
  let tickStore: MarketTickStore | undefined;
  let marketTransports: MarketTransport[] = [];
  const latestLifecycleObservations = new Map<
    string,
    FightLifecycleObservation
  >();

  const defaultStaleAfterMs: Readonly<Record<string, number>> = {
    espn: config.staleAfterMs.lifecycle,
    cito: config.staleAfterMs.stats,
    kalshi: config.staleAfterMs.markets,
    polymarket: config.staleAfterMs.markets,
    "odds-api-io": config.staleAfterMs.markets,
    "the-odds-api": config.staleAfterMs.markets,
    sherdog: config.staleAfterMs.commentary,
    x: config.staleAfterMs.commentary,
  };
  const healthRegistry = await SourceHealthRegistry.create({
    storage,
    staleAfterMs:
      options.health?.staleAfterMs ?? defaultStaleAfterMs,
    quotaThresholds:
      options.health?.quotaThresholds ?? { "odds-api-io": 30 },
    ...(options.health?.now === undefined
      ? {}
      : { now: options.health.now }),
    ...(options.health?.persistIntervalMs === undefined
      ? {}
      : { persistIntervalMs: options.health.persistIntervalMs }),
  });
  const review = new ReviewRegistry({
    storage,
    metrics: healthRegistry,
    ...(options.health?.now === undefined
      ? {}
      : { now: options.health.now }),
  });

  const getBootstrap = (): CollectorBootstrap => ({
    state,
    boutMappings: boutMappings?.getAll() ?? [],
    health: healthRegistry.getHealth(),
    lifecycleObservations: [...latestLifecycleObservations.values()],
    unifiedRounds: roundStats?.getUnifiedRounds() ?? [],
    marketSnapshots: tickStore?.getSnapshots() ?? [],
    latestMarkets: tickStore?.getLatest() ?? [],
    metrics: healthRegistry.getMetrics(),
    alerts: healthRegistry.getAlerts(),
  });
  const push = new SsePush({
    storage,
    getBootstrap,
    secrets: credentialValues(config),
    ...options.sse,
  });
  await push.restore();
  healthRegistry.setPublisher((event) => push.publish("health", event));

  const publishHealth = async (
    nextHealth: SourceHealth,
  ): Promise<boolean> => healthRegistry.publishHealth(nextHealth);

  const eventBus = new CollectorEventBus();
  const unsubscribers = (
    [
      "FIGHT_STARTED",
      "PROVISIONAL_ROUND_ENDED",
      "ROUND_ENDED",
      "FIGHT_ENDED",
    ] as const
  ).map((type) =>
    eventBus.subscribe(type, (event) => {
      void push
        .publish("update", {
          kind: "lifecycle",
          event: event as CollectorEvent,
        })
        .catch(() => undefined);
    }),
  );
  const initializedTickStore = await MarketTickStore.create({
    eventBus,
    storage,
    metrics: healthRegistry,
    publish: async (snapshot) => {
      await push.publish("update", {
        kind: "market-snapshot",
        snapshot,
      });
    },
    onSnapshot: async (snapshot) => {
      await roundStats?.setMarketSnapshot(snapshot);
    },
    onSnapshotsRemoved: async (boutId, round, boundaryType) => {
      await roundStats?.removeMarketSnapshots(
        boutId,
        round,
        boundaryType,
      );
    },
    ...(options.market?.clock === undefined
      ? {}
      : { clock: options.market.clock }),
    ...(options.market?.staleAfterMs === undefined
      ? {}
      : { staleAfterMs: options.market.staleAfterMs }),
  });
  tickStore = initializedTickStore;
  const roundStatsOptions = options.roundStats;
  const roundJobClock =
    roundStatsOptions?.clock ?? options.sportsbook?.clock;
  const roundJobTimer =
    roundStatsOptions?.timer ?? options.sportsbook?.timer;
  // Cito remains a fixture-only compatibility source.  Live collection is
  // ESPN-only: do not discover cards, construct a client, or issue a Cito
  // request from the real app.
  const initializedCitoRoundStatsFetcher =
    roundStatsOptions?.fetcher ?? createFixtureCitoRoundStatsFetcher();
  const initializedRoundStats = await RoundStatsPipeline.create({
    eventBus,
    storage,
    fetcher: initializedCitoRoundStatsFetcher,
    publish: async (record) => {
      await push.publish("update", {
        kind: "round",
        record,
      });
    },
    metrics: healthRegistry,
    ...(roundJobClock === undefined
      ? {}
      : { clock: roundJobClock }),
    ...(roundJobTimer === undefined
      ? {}
      : { timer: roundJobTimer }),
    ...(roundStatsOptions?.initialDelayMs === undefined
      ? {}
      : { initialDelayMs: roundStatsOptions.initialDelayMs }),
    ...(roundStatsOptions?.retryDelayMs === undefined
      ? {}
      : { retryDelayMs: roundStatsOptions.retryDelayMs }),
    ...(roundStatsOptions?.quotaPolicy === undefined
      ? {}
      : { quotaPolicy: roundStatsOptions.quotaPolicy }),
    enableCitoJobs: config.dataMode === "fixture",
  });
  roundStats = initializedRoundStats;
  for (const snapshot of initializedTickStore.getSnapshots()) {
    await initializedRoundStats.setMarketSnapshot(snapshot);
  }
  const lifecycle = await FightLifecycleMachine.create({
    eventBus,
    storage,
    metrics: healthRegistry,
    onProvisionalSuperseded: (supersession) => {
      void initializedTickStore
        .handleProvisionalSupersession(supersession)
        .catch(() => undefined);
    },
  });

  const loaded = await (options.stateLoader ?? defaultStateLoader)(config);
  if (
    state === null ||
    JSON.stringify(state) !== JSON.stringify(loaded)
  ) {
    state = loaded;
    await storage.append(COLLECTOR_STATE_STREAM, {
      version: 1,
      state,
    } satisfies PersistedCollectorState);
  } else {
    state = loaded;
  }
  const initializedBoutMappings = await createBoutMappingRegistry({
    event: loaded.event,
    storage,
    metrics: healthRegistry,
    manualOverrides: options.manualBoutMappingOverrides,
  });
  if (config.dataMode === "live") {
    await importCurrentEventUpcomingMappings({
      event: loaded.event,
      registry: initializedBoutMappings,
      storage,
    });
  }
  boutMappings = initializedBoutMappings;
  const sourceConfig: SourceConfig = {
    mode: config.dataMode,
    credentials: { ...config.credentials },
  };

  const lifecycleGetBouts = () => loaded.event.bouts;
  const finalizedEspnStatsBouts = new Set<string>();
  const requiredEventExternalId = (source: "espn"): string => {
    const id = loaded.event.externalRefs.find(
      (ref) => ref.source === source,
    )?.id;
    if (id === undefined) {
      throw new Error(
        `Live lifecycle driver requires a "${source}" external ref on the event`,
      );
    }
    return id;
  };
  const lifecycleEspnProvider =
    options.lifecycle?.espnProvider ??
    (config.dataMode === "fixture"
      ? createFixtureLifecycleProvider(
          lifecycleGetBouts,
          options.lifecycle?.clock,
        )
      : createLiveEspnLifecycleProvider(
          sourceConfig,
          requiredEventExternalId("espn"),
          lifecycleGetBouts,
          { clock: options.lifecycle?.clock },
        ));
  const lifecycleDriver = new LifecycleDriver({
    machine: lifecycle,
    espnProvider: lifecycleEspnProvider,
    espnPollingMs: config.pollingMs.espn,
    ...(config.dataMode === "live"
      ? { eventStartsAt: loaded.event.startsAt }
      : {}),
    ...(options.lifecycle?.clock === undefined
      ? {}
      : { clock: options.lifecycle.clock }),
    ...(options.lifecycle?.timer === undefined
      ? {}
      : { timer: options.lifecycle.timer }),
    onObservations: async (observations) => {
      for (const observation of observations) {
        latestLifecycleObservations.set(
          observation.boutId,
          observation,
        );
        const bout = loaded.event.bouts.find((candidate) => candidate.id === observation.boutId);
        const eventId = loaded.event.externalRefs.find((ref) => ref.source === "espn")?.id;
        const competitionId = bout?.externalRefs.find((ref) => ref.source === "espn")?.id;
        const redAthleteId = bout?.fighters.red.externalRefs.find((ref) => ref.source === "espn")?.id;
        const blueAthleteId = bout?.fighters.blue.externalRefs.find((ref) => ref.source === "espn")?.id;
        // Core has the current cumulative total; scoreboard inline statistics
        // are only a fallback because they are commonly absent in live MMA.
        const shouldFetchCore =
          config.dataMode === "live" &&
          (observation.state === "in" ||
            (observation.completed &&
              !finalizedEspnStatsBouts.has(observation.boutId))) &&
          observation.period >= 1 &&
          eventId !== undefined &&
          competitionId !== undefined &&
          redAthleteId !== undefined &&
          blueAthleteId !== undefined;
        const coreStats = shouldFetchCore
          ? await Promise.all([
              fetchEspnCoreCumulativeStats({
                eventId,
                competitionId,
                athleteId: redAthleteId,
              }),
              fetchEspnCoreCumulativeStats({
                eventId,
                competitionId,
                athleteId: blueAthleteId,
              }),
            ])
              .then(([fighterA, fighterB]) => ({ fighterA, fighterB }))
              .catch(() => observation.cumulativeStats)
          : observation.cumulativeStats;
        if (coreStats !== undefined && observation.period >= 1) {
          const stats = initializedRoundStats.observeEspnCumulative(
            {
              boutId: observation.boutId,
              round: observation.period,
              fighterA: coreStats.fighterA,
              fighterB: coreStats.fighterB,
              observedAt: observation.receivedAt,
            },
            observation.completed,
          );
          if (observation.completed) {
            finalizedEspnStatsBouts.add(observation.boutId);
          }
          await push.publish("update", { kind: "espn-round-live", stats });
        }
      }
      await push.publish("update", {
        kind: "lifecycle-observations",
        observations,
      });
    },
    metrics: healthRegistry,
  });

  let promoteUpcomingMappings = async (): Promise<void> => undefined;
  const preEventPoller = new PreEventPoller({
    storage,
    eventBus,
    getLifecycleStates: () => lifecycle.getStates(),
    enabled:
      options.preEventPoll?.enabled ?? config.preEventPollEnabled,
    runSync: options.preEventPoll?.runSync,
    onSuccess: () => promoteUpcomingMappings(),
    readDocument:
      options.preEventPoll?.readDocument ??
      (() => readUpcomingOddsDocument(config.persistencePath)),
    nonEventDayIntervalMs: config.preEventPollIntervalMs.nonEventDay,
    eventDayIntervalMs: config.preEventPollIntervalMs.eventDay,
    retryMs: config.preEventPollRetryMs,
    metrics: healthRegistry,
    ...(options.preEventPoll?.clock === undefined
      ? {}
      : { clock: options.preEventPoll.clock }),
    ...(options.preEventPoll?.timer === undefined
      ? {}
      : { timer: options.preEventPoll.timer }),
  });

  const oddsApiIoLiveHook =
    options.sportsbook?.oddsApiIoLiveHook ??
    (config.dataMode === "live" &&
    config.credentials.ODDS_API_IO_KEY !== undefined
      ? createOddsApiIoLiveHook({
          bookmakers: config.oddsApiIoBookmakers,
          ...(options.sportsbook?.fetchImpl === undefined
            ? {}
            : { fetchImpl: options.sportsbook.fetchImpl }),
          ...(options.sportsbook?.timeoutMs === undefined
            ? {}
            : { timeoutMs: options.sportsbook.timeoutMs }),
        })
      : undefined);
  const initializedOddsApiIoSource =
    options.sportsbook?.oddsApiIoSource ??
    createOddsApiIoSource(sourceConfig, oddsApiIoLiveHook);
  if (config.dataMode === "fixture") {
    for (const discoveredEvent of
      await initializedOddsApiIoSource.discoverEvents()) {
      for (const discoveredBout of discoveredEvent.bouts) {
        await initializedBoutMappings.matchDiscoveredBout({
          externalRef: discoveredBout.externalRef,
          redFighter: discoveredBout.redFighter,
          blueFighter: discoveredBout.blueFighter,
        });
      }
    }
  }

  const kalshiSubscriptions = resolveMarketSubscriptions(
    initializedBoutMappings.getAll(),
    "kalshi",
  );
  const polymarketSubscriptions = resolveMarketSubscriptions(
    initializedBoutMappings.getAll(),
    "polymarket",
  );
  marketTransports = options.market?.transports
    ? [...options.market.transports]
    : config.dataMode === "fixture"
      ? [
          new KalshiFixtureTransport({
            tickStore: initializedTickStore,
            subscriptions: kalshiSubscriptions,
          }),
          new PolymarketFixtureTransport({
            tickStore: initializedTickStore,
            subscriptions: polymarketSubscriptions,
          }),
        ]
      : [
          createKalshiLiveTransport(config, {
            tickStore: initializedTickStore,
            subscriptions: kalshiSubscriptions,
            metrics: healthRegistry,
            review,
          }),
          createPolymarketLiveTransport(config, {
            tickStore: initializedTickStore,
            subscriptions: polymarketSubscriptions,
            metrics: healthRegistry,
            review,
          }),
        ];

  const sportsbookClock =
    options.sportsbook?.clock ??
    options.roundStats?.clock ??
    options.market?.clock;
  const sportsbookTimer =
    options.sportsbook?.timer ?? options.roundStats?.timer;
  const findBout = (boutId: string) =>
    loaded.event.bouts.find((bout) => bout.id === boutId);
  const geminiKey = config.credentials.GEMINI_API_KEY;
  const fightOutlookSummarizer =
    options.sherdog?.fightOutlookSummarizer ??
    (config.roundSummary.enabled && geminiKey !== undefined
      ? createLiveFightOutlookSummarizer({
          apiKey: geminiKey,
          model: config.roundSummary.model,
          timeoutMs: 30_000,
        })
      : createDisabledFightOutlookSummarizer());
  const applyDiscoveredOutlooks = (
    outlooks: Readonly<Record<string, string>>,
  ): void => {
    for (const bout of loaded.event.bouts) {
      const outlook = outlooks[bout.id];
      if (outlook === undefined) continue;
      bout.outlook = outlook;
      const view = loaded.boutViews[bout.id];
      if (view !== undefined) view.bout.outlook = outlook;
    }
  };
  const initializedSherdogDiscovery =
    options.sherdog?.eventDiscovery ??
    (config.dataMode === "live" && options.sherdog?.fetcher === undefined
      ? await SherdogEventDiscovery.create({
          event: loaded.event,
          storage,
          permissionScope: config.sherdog.permissionScope,
          baseUrl: options.sherdog?.baseUrl ?? config.sherdog.baseUrl,
          summarizer: fightOutlookSummarizer,
          ...(config.sherdog.liveBlogUrl === undefined
            ? {}
            : { initialLiveBlogUrl: config.sherdog.liveBlogUrl }),
          onChanged: async (discovered) => {
            applyDiscoveredOutlooks(discovered.outlooks);
            state = loaded;
            await storage.append(COLLECTOR_STATE_STREAM, {
              version: 1,
              state: loaded,
            } satisfies PersistedCollectorState);
            await push.publish("bootstrap", getBootstrap());
          },
          onError: (stage, error) => {
            console.warn(
              `Sherdog ${stage} discovery failed:`,
              error instanceof Error ? error.message : error,
            );
          },
        })
      : undefined);
  applyDiscoveredOutlooks(initializedSherdogDiscovery?.getOutlooks() ?? {});
  let defaultSherdogFetcher: SherdogFetcher;
  if (config.dataMode === "fixture") {
    defaultSherdogFetcher = createFixtureSherdogFetcher();
  } else {
    try {
      defaultSherdogFetcher = createLiveSherdogFetcher({
        permissionScope: config.sherdog.permissionScope,
        // One play-by-play page carries the whole card, so the event-level URL
        // serves every bout; a bout's own ref still wins where one exists.
        resolveBoutUrl: (boutId) =>
          initializedBoutMappings
            .getExternalRefs(boutId)
            .find((ref) => ref.source === "sherdog")?.id ??
          initializedSherdogDiscovery?.getLiveBlogUrl() ??
          config.sherdog.liveBlogUrl,
        baseUrl: options.sherdog?.baseUrl ?? config.sherdog.baseUrl,
        ...(options.sherdog?.fetchImpl === undefined
          ? {}
          : { fetchImpl: options.sherdog.fetchImpl }),
        ...(options.sherdog?.requestTimeoutMs === undefined
          ? {}
          : { timeoutMs: options.sherdog.requestTimeoutMs }),
      });
    } catch (error) {
      if (!(error instanceof TerminalRoundJobError)) throw error;
      defaultSherdogFetcher = {
        async fetchBout() {
          return {
            status: 503,
            html: "",
            sourceUrl: config.sherdog.baseUrl,
          };
        },
      };
    }
  }
  // Gated on the switch and the key, not on live mode: the fixture simulator
  // runs real captured commentary, so summarizing it there is how the box gets
  // reviewed before a card. Without a key, rounds keep their raw commentary.
  const summarizer =
    options.sherdog?.summarizer ??
    (config.roundSummary.enabled && geminiKey !== undefined
      ? createLiveGeminiSummarizer({
          apiKey: geminiKey,
          model: config.roundSummary.model,
        })
      : createDisabledSummarizer());
  const initializedSherdogJobs = await SherdogRoundJobs.create({
    summarizer,
    eventBus,
    scheduler: initializedRoundStats.scheduler,
    storage,
    roundStats: initializedRoundStats,
    fetcher:
      options.sherdog?.fetcher ??
      defaultSherdogFetcher,
    getBout: findBout,
    dataMode: config.dataMode,
    permissionScope: config.sherdog.permissionScope,
    requestIntervalMs: config.sherdog.requestIntervalMs,
    publishHealth,
    metrics: healthRegistry,
    review,
    ...(roundJobClock === undefined ? {} : { clock: roundJobClock }),
    ...(options.sherdog?.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.sherdog.requestTimeoutMs }),
  });
  const initializedOddsApiIoPoller = await OddsApiIoPoller.create({
    eventBus,
    storage,
    source: initializedOddsApiIoSource,
    tickStore: initializedTickStore,
    resolveBout: (boutId) => {
      const bout = findBout(boutId);
      const externalBoutId = initializedBoutMappings
        .getExternalRefs(boutId)
        .find((ref) => ref.source === "odds-api-io")?.id;
      return bout === undefined || externalBoutId === undefined
        ? undefined
        : { bout, externalBoutId };
    },
    bookmakers: config.oddsApiIoBookmakers,
    activePollMs: config.activePollMs.oddsApiIo,
    publishTick: async (tick) => {
      await push.publish("update", {
        kind: "market-tick",
        tick,
      });
    },
    metrics: healthRegistry,
    ...(sportsbookClock === undefined ? {} : { clock: sportsbookClock }),
    ...(sportsbookTimer === undefined ? {} : { timer: sportsbookTimer }),
    ...(options.sportsbook?.oddsApiIoQuotaPolicy === undefined
      ? {}
      : {
          quotaPolicy: options.sportsbook.oddsApiIoQuotaPolicy,
        }),
  });
  // One client shared by the round job and the active poller, so both count
  // against the same account and neither can double-instantiate it.
  const theOddsApiLiveHook =
    options.sportsbook?.theOddsApiLiveHook ??
    (config.dataMode === "live" &&
    config.credentials.THE_ODDS_API_KEY !== undefined
      ? createTheOddsApiLiveHook({
          ...(options.sportsbook?.fetchImpl === undefined
            ? {}
            : { fetchImpl: options.sportsbook.fetchImpl }),
          ...(options.sportsbook?.timeoutMs === undefined
            ? {}
            : { timeoutMs: options.sportsbook.timeoutMs }),
        })
      : undefined);
  const theOddsApiSource =
    options.sportsbook?.theOddsApiSource ??
    createOddsApiSource(sourceConfig, theOddsApiLiveHook);
  // The Odds API only ever runs as part of the twice-daily upcoming sync —
  // zero live/event-day collection. Historical snapshots already written
  // stay in place; this only gates new collection going forward.
  const theOddsApiEnabled: boolean | (() => boolean) =
    config.dataMode === "live"
      ? () =>
          !isEventCalendarDay(
            new Date(sportsbookClock?.now() ?? Date.now()),
            new Date(loaded.event.startsAt),
          )
      : true;
  const initializedTheOddsApiJob = new TheOddsApiRoundJob({
    eventBus,
    scheduler: initializedRoundStats.scheduler,
    source: theOddsApiSource,
    tickStore: initializedTickStore,
    getBout: findBout,
    publishTick: async (tick) => {
      await push.publish("update", {
        kind: "market-tick",
        tick,
      });
    },
    metrics: healthRegistry,
    enabled: theOddsApiEnabled,
    ...(sportsbookClock === undefined ? {} : { clock: sportsbookClock }),
    ...(options.sportsbook?.random === undefined
      ? {}
      : { random: options.sportsbook.random }),
  });

  const initializedTheOddsApiActivePoller =
    await TheOddsApiActivePoller.create({
      eventBus,
      storage,
      source: theOddsApiSource,
      tickStore: initializedTickStore,
      getBout: findBout,
      activePollMs: config.activePollMs.theOddsApi,
      publishTick: async (tick) => {
        await push.publish("update", { kind: "market-tick", tick });
      },
      metrics: healthRegistry,
      enabled: theOddsApiEnabled,
      ...(sportsbookClock === undefined ? {} : { clock: sportsbookClock }),
      ...(sportsbookTimer === undefined ? {} : { timer: sportsbookTimer }),
    });

  // Streams remain connected across round breaks. The simple card policy
  // closes them once every bout represented by a market subscription has
  // emitted FIGHT_ENDED.
  const allMarketSubscriptions = new Map(
    marketTransports.map((transport) => [
      transport,
      transport.subscriptions,
    ]),
  );
  const relevantMarketBouts = new Set(
    marketTransports.flatMap((transport) =>
      transport.subscriptions.map(({ boutId }) => boutId),
    ),
  );
  const endedMarketBouts = new Set<string>();

  /**
   * Narrows every stream to the bouts ESPN currently says are live.
   *
   * The transports are told what to subscribe to, not merely which ticks to
   * keep: a card has a dozen mapped bouts and only one is ever in progress, so
   * subscribing to all of them would carry eleven idle books and make the one
   * that matters harder to keep fresh. Before any fight starts, and after the
   * last one ends, the full mapped set is restored so the streams are already
   * pointed at the right markets when the next fight opens.
   *
   * SupervisedMarketTransport treats a new subscription set as stale until a
   * fresh snapshot arrives for it, so narrowing can never leave deltas being
   * applied to a book that was never rebuilt.
   */
  const applyActiveSubscriptions = (): void => {
    const activeBouts = new Set(
      lifecycle
        .getStates()
        .filter((state) => state.state === "in" && !state.completed)
        .map((state) => state.boutId),
    );

    for (const transport of marketTransports) {
      const all = allMarketSubscriptions.get(transport) ?? [];
      const active = all.filter((subscription) =>
        activeBouts.has(subscription.boutId),
      );
      transport.setSubscriptions(active.length > 0 ? active : all);
    }
  };

  const refreshDiscoveredSubscriptions = (): void => {
    relevantMarketBouts.clear();
    for (const transport of marketTransports) {
      const all = resolveMarketSubscriptions(
        initializedBoutMappings.getAll(),
        transport.source,
      );
      allMarketSubscriptions.set(transport, all);
      for (const subscription of all) {
        relevantMarketBouts.add(subscription.boutId);
      }
    }
    applyActiveSubscriptions();
  };
  promoteUpcomingMappings = async () => {
    await importCurrentEventUpcomingMappings({
      event: loaded.event,
      registry: initializedBoutMappings,
      storage,
    });
    refreshDiscoveredSubscriptions();
  };

  unsubscribers.push(
    eventBus.subscribe("FIGHT_STARTED", () => {
      applyActiveSubscriptions();
    }),
    eventBus.subscribe("FIGHT_ENDED", (event) => {
      applyActiveSubscriptions();
      endedMarketBouts.add(event.boutId);
      if (!relevantMarketBouts.has(event.boutId)) return;
      if (
        relevantMarketBouts.size > 0 &&
        [...relevantMarketBouts].every((boutId) =>
          endedMarketBouts.has(boutId),
        )
      ) {
        void Promise.all(
          marketTransports.map((transport) =>
            transport.disconnect(),
          ),
        ).catch(() => undefined);
      }
    }),
  );

  if (config.dataMode === "fixture") {
    for (const sourceHealth of fixtureHealth(loaded)) {
      await publishHealth(sourceHealth);
    }
  }

  const secrets = credentialValues(config);
  let server: Server;
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (await push.handle(request, response)) return;

    const url = new URL(request.url ?? "/", "http://collector.local");
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Origin": "*",
      });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      sendJson(response, 200, getBootstrap(), secrets);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(
        response,
        200,
        {
          health: getBootstrap().health,
          metrics: healthRegistry.getMetrics(),
          alerts: healthRegistry.getAlerts(),
        },
        secrets,
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/metrics") {
      sendJson(response, 200, healthRegistry.getMetrics(), secrets);
      return;
    }
    // Served straight off disk rather than held in memory: the sync is a
    // separate one-shot process, so the collector has no in-process copy to
    // serve and re-reading is how it picks up a fresh run without a restart.
    // A missing file is 200 with `document: null` — "the sync has not run yet"
    // is a state the dashboard renders, not an error.
    if (request.method === "GET" && url.pathname === "/api/upcoming-odds") {
      sendJson(
        response,
        200,
        {
          document: await readUpcomingOddsDocument(config.persistencePath),
        },
        secrets,
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/review") {
      sendJson(
        response,
        200,
        await review.getReviewRecords(),
        secrets,
      );
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/mapping-override"
    ) {
      const contentType = request.headers["content-type"];
      const normalizedContentType = Array.isArray(contentType)
        ? contentType[0]
        : contentType;
      if (
        normalizedContentType === undefined ||
        !normalizedContentType
          .toLocaleLowerCase("en-US")
          .startsWith("application/json")
      ) {
        throw new HttpRequestError(
          415,
          "Content-Type must be application/json",
        );
      }
      const override = parseMappingOverride(await readJsonBody(request));
      let mapping: BoutMapping;
      try {
        mapping = await initializedBoutMappings.setManualOverride(
          override,
        );
      } catch (error) {
        throw new HttpRequestError(
          400,
          error instanceof Error
            ? error.message
            : "Mapping override was rejected",
        );
      }
      await push.publish("update", {
        kind: "mapping-override",
        mapping,
      });
      sendJson(response, 200, { mapping }, secrets);
      return;
    }

    sendJson(response, 404, { error: "Not found" }, secrets);
  };

  server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        const status =
          error instanceof HttpRequestError ? error.status : 500;
        sendJson(
          response,
          status,
          {
            error:
              error instanceof Error
                ? error.message
                : "Collector request failed",
          },
          secrets,
        );
      } else {
        response.end();
      }
    });
  });

  let startPromise: Promise<number> | undefined;
  const host = options.host ?? "127.0.0.1";

  return {
    config,
    eventBus,
    boutMappings: initializedBoutMappings,
    push,
    roundStats: initializedRoundStats,
    tickStore: initializedTickStore,
    marketTransports,
    oddsApiIoPoller: initializedOddsApiIoPoller,
    theOddsApiJob: initializedTheOddsApiJob,
    theOddsApiActivePoller: initializedTheOddsApiActivePoller,
    sherdogJobs: initializedSherdogJobs,
    ...(initializedSherdogDiscovery === undefined
      ? {}
      : { sherdogDiscovery: initializedSherdogDiscovery }),
    lifecycle,
    lifecycleDriver,
    preEventPoller,
    health: healthRegistry,
    review,
    server,
    async start() {
      startPromise ??= listen(server, config.port, host);
      const port = await startPromise;
      const lifecycleDriverEnabled =
        options.lifecycle?.enabled ?? config.lifecycleDriverEnabled;
      if (lifecycleDriverEnabled) {
        await lifecycleDriver.start();
      }
      const preEventPollEnabled =
        options.preEventPoll?.enabled ?? config.preEventPollEnabled;
      if (preEventPollEnabled) {
        await preEventPoller.start();
      }
      if (config.dataMode === "live") {
        initializedSherdogDiscovery?.start();
        await Promise.all(
          marketTransports.map((transport) => transport.connect()),
        );
        for (const lifecycleState of lifecycle.getStates()) {
          if (
            lifecycleState.state === "in" &&
            !lifecycleState.completed
          ) {
            initializedOddsApiIoPoller.startActiveBout(
              lifecycleState.boutId,
            );
            initializedTheOddsApiActivePoller.startActiveBout(
              lifecycleState.boutId,
            );
          }
        }
        applyActiveSubscriptions();
        await initializedOddsApiIoPoller.idle();
        await initializedTheOddsApiActivePoller.idle();
      }
      return port;
    },
    async close() {
      for (const unsubscribe of unsubscribers) unsubscribe();
      await initializedSherdogDiscovery?.close();
      await preEventPoller.close();
      await lifecycleDriver.close();
      await initializedOddsApiIoPoller.close();
      await initializedTheOddsApiJob.close();
      await initializedTheOddsApiActivePoller.close();
      await initializedSherdogJobs.close();
      await Promise.all(
        marketTransports.map((transport) => transport.disconnect()),
      );
      await initializedTickStore.close();
      await initializedRoundStats.close();
      await healthRegistry.close();
      await push.close();
      await closeServer(server);
    },
    async replayMarkets() {
      const replayTransports = marketTransports.filter(
        (transport): transport is ReplayMarketTransport =>
          "replay" in transport &&
          typeof transport.replay === "function",
      );
      await Promise.all(
        replayTransports.map((transport) => transport.replay()),
      );
      if (config.dataMode === "fixture") {
        for (const bout of loaded.event.bouts) {
          if (
            bout.status === "in-round" ||
            bout.status === "between-rounds"
          ) {
            initializedOddsApiIoPoller.startActiveBout(bout.id);
          }
        }
        await initializedOddsApiIoPoller.idle();
      }
    },
    getBootstrap,
    publishHealth,
  };
}

async function main(): Promise<void> {
  const collector = await createCollector();
  const port = await collector.start();
  console.log(`UFC collector listening on http://127.0.0.1:${port}`);
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  import.meta.url === pathToFileURL(entry).href
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Collector failed to start",
    );
    process.exitCode = 1;
  });
}
