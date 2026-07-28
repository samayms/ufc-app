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
  OddsSnapshot,
  ScorecardAccount,
  SourceId,
} from "../src/schema.ts";
import {
  createCitoSource,
  createFixtureCitoRoundStatsFetcher,
  createLiveCitoRoundStatsFetcher,
  type CitoRoundStatsFetcher,
} from "../src/sources/cito.ts";
import type { SourceConfig } from "../src/sources/contract.ts";
import { createEspnSource } from "../src/sources/espn.ts";
import { createKalshiSource } from "../src/sources/kalshi.ts";
import {
  createOddsApiSource,
  type TheOddsApiSource,
} from "../src/sources/oddsapi.ts";
import {
  createOddsApiIoSource,
  type OddsApiIoSource,
} from "../src/sources/oddsApiIo.ts";
import { createPolymarketSource } from "../src/sources/polymarket.ts";
import { createSherdogSource } from "../src/sources/sherdog.ts";
import {
  createXSource,
  type XApiFetcher,
  type XScoreSource,
} from "../src/sources/x.ts";
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
import { FightLifecycleMachine } from "./lifecycle.ts";
import {
  createFixtureLifecycleProvider,
  createLiveCitoLifecycleProvider,
  createLiveEspnLifecycleProvider,
  LifecycleDriver,
  type LifecycleDriverClock,
  type LifecycleDriverTimer,
  type LifecycleObservationProvider,
} from "./lifecycleDriver.ts";
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
import type {
  RoundJobClock,
  RoundJobTimer,
} from "./roundJobs.ts";
import {
  RoundStatsPipeline,
  type UnifiedRoundRecord,
} from "./roundStats.ts";
import {
  createFixtureSherdogFetcher,
  SherdogRoundJobs,
  type SherdogFetcher,
} from "./sherdogJobs.ts";
import {
  JsonlStorage,
  type Storage,
} from "./storage.ts";
import {
  MarketTickStore,
  type LocalOrderBookState,
  type MarketSnapshot,
  type TickStoreClock,
} from "./tickStore.ts";
import { TheOddsApiRoundJob } from "./theOddsApiJob.ts";
import { XRoundJobs } from "./xJobs.ts";

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

export interface CollectorMarketOptions {
  clock?: TickStoreClock;
  staleAfterMs?: number;
  transports?: readonly MarketTransport[];
}

export interface CollectorSportsbookOptions {
  clock?: RoundJobClock;
  timer?: OddsApiIoPollTimer & RoundJobTimer;
  random?: () => number;
  oddsApiIoSource?: OddsApiIoSource;
  theOddsApiSource?: TheOddsApiSource;
  oddsApiIoQuotaPolicy?: QuotaPolicy;
}

export interface CollectorSherdogOptions {
  fetcher?: SherdogFetcher;
  random?: () => number;
  requestTimeoutMs?: number;
}

export interface CollectorXOptions {
  source?: XScoreSource;
  apiFetcher?: XApiFetcher;
}

export interface CollectorLifecycleDriverOptions {
  /** Overrides config.lifecycleDriverEnabled (defaults to live mode only; see README). */
  enabled?: boolean;
  espnProvider?: LifecycleObservationProvider;
  citoProvider?: LifecycleObservationProvider;
  clock?: LifecycleDriverClock;
  timer?: LifecycleDriverTimer;
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
    "bufferSize" | "heartbeatMs" | "now"
  >;
  roundStats?: CollectorRoundStatsOptions;
  market?: CollectorMarketOptions;
  sportsbook?: CollectorSportsbookOptions;
  sherdog?: CollectorSherdogOptions;
  x?: CollectorXOptions;
  lifecycle?: CollectorLifecycleDriverOptions;
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
  readonly sherdogJobs: SherdogRoundJobs;
  readonly xJobs: XRoundJobs;
  readonly lifecycle: FightLifecycleMachine;
  readonly lifecycleDriver: LifecycleDriver;
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

const SCORECARD_ACCOUNTS: readonly ScorecardAccount[] = [
  {
    handle: "arielhelwani",
    displayName: "Ariel Helwani",
    active: true,
  },
  { handle: "DinThomas", displayName: "Din Thomas", active: true },
  { handle: "KevinI", displayName: "Kevin Iole", active: true },
  { handle: "lthomasnews", displayName: "Luke Thomas", active: true },
  { handle: "MMAJunkie", displayName: "MMA Junkie", active: true },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDashboardState(value: unknown): value is DashboardState {
  return (
    isRecord(value) &&
    isRecord(value.event) &&
    typeof value.event.id === "string" &&
    Array.isArray(value.event.bouts) &&
    isRecord(value.boutViews) &&
    Array.isArray(value.scorecardAccounts)
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

export async function loadFixtureState(
  collectorConfig?: Pick<
    CollectorConfig,
    "xMode" | "xEmbeds" | "xManualScores"
  >,
): Promise<DashboardState> {
  const sourceConfig: SourceConfig = { mode: "fixture" };
  const event = loadFixtureEvent();
  const polymarket = createPolymarketSource(sourceConfig);
  const oddsApi = createOddsApiSource(sourceConfig);
  const sherdog = createSherdogSource(sourceConfig);
  const kalshi = createKalshiSource(sourceConfig);
  const espn = createEspnSource(sourceConfig);
  const cito = createCitoSource(sourceConfig);
  const x = createXSource({
    mode:
      (collectorConfig?.xMode ?? "embed") === "embed"
        ? "embed"
        : "disabled",
    embeds: collectorConfig?.xEmbeds ?? [],
    manualScores: collectorConfig?.xManualScores ?? [],
    fixtureMode: true,
  });
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
    const latestOdds: BoutView["latestOdds"] = {};
    const oddsHistory: BoutView["oddsHistory"] = {};

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

    const rounds: BoutView["rounds"] = {};
    if (sherdogRounds.length > 0) rounds.sherdog = sherdogRounds;
    if (espnRounds.length > 0) rounds.espn = espnRounds;
    if (citoRounds.length > 0) rounds.cito = citoRounds;

    boutViews[bout.id] = {
      bout,
      rounds,
      latestOdds,
      oddsHistory,
      scorecards: x.configuredEmbeds(bout.id),
    };
  }

  return {
    event,
    boutViews,
    scorecardAccounts: SCORECARD_ACCOUNTS.map((account) => ({
      ...account,
    })),
  };
}

async function defaultStateLoader(
  config: CollectorConfig,
): Promise<DashboardState> {
  if (config.dataMode === "fixture") {
    return loadFixtureState(config);
  }

  throw new Error(
    "Live mode credentials are configured, but live transports are not installed",
  );
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
  const initializedRoundStats = await RoundStatsPipeline.create({
    eventBus,
    storage,
    fetcher:
      roundStatsOptions?.fetcher ??
      (config.dataMode === "fixture"
        ? createFixtureCitoRoundStatsFetcher()
        : createLiveCitoRoundStatsFetcher()),
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
  boutMappings = initializedBoutMappings;
  const sourceConfig: SourceConfig = {
    mode: config.dataMode,
    credentials: { ...config.credentials },
  };

  const lifecycleGetBouts = () => loaded.event.bouts;
  const requiredEventExternalId = (source: "espn" | "cito"): string => {
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
  const lifecycleCitoProvider =
    options.lifecycle?.citoProvider ??
    (config.dataMode === "live" && config.citoApiBaseUrl !== undefined
      ? createLiveCitoLifecycleProvider(
          sourceConfig,
          requiredEventExternalId("cito"),
          lifecycleGetBouts,
          { baseUrl: config.citoApiBaseUrl, clock: options.lifecycle?.clock },
        )
      : undefined);
  const lifecycleDriver = new LifecycleDriver({
    machine: lifecycle,
    espnProvider: lifecycleEspnProvider,
    ...(lifecycleCitoProvider === undefined
      ? {}
      : { citoProvider: lifecycleCitoProvider }),
    espnPollingMs: config.pollingMs.espn,
    citoPollingMs: config.pollingMs.cito,
    espnFailureThreshold: config.lifecycleEspnFailureThreshold,
    ...(options.lifecycle?.clock === undefined
      ? {}
      : { clock: options.lifecycle.clock }),
    ...(options.lifecycle?.timer === undefined
      ? {}
      : { timer: options.lifecycle.timer }),
    metrics: healthRegistry,
  });

  const initializedOddsApiIoSource =
    options.sportsbook?.oddsApiIoSource ??
    createOddsApiIoSource(sourceConfig);
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
  const initializedSherdogJobs = await SherdogRoundJobs.create({
    eventBus,
    scheduler: initializedRoundStats.scheduler,
    storage,
    roundStats: initializedRoundStats,
    fetcher:
      options.sherdog?.fetcher ??
      (config.dataMode === "fixture"
        ? createFixtureSherdogFetcher()
        : {
            async fetchBout() {
              return {
                status: 503,
                html: "",
                sourceUrl: "https://www.sherdog.com/",
              };
            },
          }),
    getBout: findBout,
    dataMode: config.dataMode,
    permissionScope: config.sherdog.permissionScope,
    requestIntervalMs: config.sherdog.requestIntervalMs,
    publishHealth,
    metrics: healthRegistry,
    review,
    ...(roundJobClock === undefined ? {} : { clock: roundJobClock }),
    ...(options.sherdog?.random === undefined
      ? {}
      : { random: options.sherdog.random }),
    ...(options.sherdog?.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.sherdog.requestTimeoutMs }),
  });
  const initializedXSource =
    options.x?.source ??
    createXSource({
      mode: config.xMode,
      bearerToken: config.credentials.X_BEARER_TOKEN,
      embeds: config.xEmbeds,
      manualScores: config.xManualScores,
      fixtureMode: config.dataMode === "fixture",
      ...(options.x?.apiFetcher === undefined
        ? {}
        : { apiFetcher: options.x.apiFetcher }),
      ...(roundJobClock === undefined
        ? {}
        : {
            now: () =>
              new Date(roundJobClock.now()).toISOString(),
          }),
    });
  const initializedXJobs = await XRoundJobs.create({
    eventBus,
    scheduler: initializedRoundStats.scheduler,
    storage,
    source: initializedXSource,
    roundStats: initializedRoundStats,
    getBout: findBout,
    spendingCapUsd: config.xSpendCapUsd,
    requestCostUsd: config.xRequestCostUsd,
    metrics: healthRegistry,
    ...(roundJobClock === undefined ? {} : { clock: roundJobClock }),
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
  const initializedTheOddsApiJob = new TheOddsApiRoundJob({
    eventBus,
    scheduler: initializedRoundStats.scheduler,
    source:
      options.sportsbook?.theOddsApiSource ??
      createOddsApiSource(sourceConfig),
    tickStore: initializedTickStore,
    getBout: findBout,
    publishTick: async (tick) => {
      await push.publish("update", {
        kind: "market-tick",
        tick,
      });
    },
    metrics: healthRegistry,
    ...(sportsbookClock === undefined ? {} : { clock: sportsbookClock }),
    ...(options.sportsbook?.random === undefined
      ? {}
      : { random: options.sportsbook.random }),
  });

  // Streams remain connected across round breaks. The simple card policy
  // closes them once every bout represented by a market subscription has
  // emitted FIGHT_ENDED.
  const relevantMarketBouts = new Set(
    marketTransports.flatMap((transport) =>
      transport.subscriptions.map(({ boutId }) => boutId),
    ),
  );
  const endedMarketBouts = new Set<string>();
  unsubscribers.push(
    eventBus.subscribe("FIGHT_ENDED", (event) => {
      if (!relevantMarketBouts.has(event.boutId)) return;
      endedMarketBouts.add(event.boutId);
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
    sherdogJobs: initializedSherdogJobs,
    xJobs: initializedXJobs,
    lifecycle,
    lifecycleDriver,
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
      if (config.dataMode === "live") {
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
          }
        }
        await initializedOddsApiIoPoller.idle();
      }
      return port;
    },
    async close() {
      for (const unsubscribe of unsubscribers) unsubscribe();
      await lifecycleDriver.close();
      await initializedOddsApiIoPoller.close();
      await initializedTheOddsApiJob.close();
      await initializedSherdogJobs.close();
      await initializedXJobs.close();
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
