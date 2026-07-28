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
import { createCitoSource } from "../src/sources/cito.ts";
import type { SourceConfig } from "../src/sources/contract.ts";
import { createEspnSource } from "../src/sources/espn.ts";
import { createKalshiSource } from "../src/sources/kalshi.ts";
import { createOddsApiSource } from "../src/sources/oddsapi.ts";
import { createPolymarketSource } from "../src/sources/polymarket.ts";
import { createSherdogSource } from "../src/sources/sherdog.ts";
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
  sanitizeClientPayload,
  SsePush,
  type SsePushOptions,
} from "./push.ts";
import {
  JsonlStorage,
  type Storage,
} from "./storage.ts";

export const COLLECTOR_STATE_STREAM = "collector-state";
export const COLLECTOR_HEALTH_STREAM = "source-health";

export type SourceHealthStatus =
  | "healthy"
  | "stale"
  | "degraded"
  | "unavailable";

export interface SourceHealth {
  source: string;
  status: SourceHealthStatus;
  fresh: boolean;
  checkedAt: string;
  sourceUpdatedAt?: string;
  message?: string;
}

export interface CollectorBootstrap {
  state: DashboardState | null;
  health: Readonly<Record<string, SourceHealth>>;
}

export type NormalizedStateLoader = (
  config: CollectorConfig,
) => Promise<DashboardState>;

export interface CreateCollectorOptions {
  env?: CollectorEnvironment;
  storage?: Storage;
  stateLoader?: NormalizedStateLoader;
  host?: string;
  sse?: Pick<
    SsePushOptions,
    "bufferSize" | "heartbeatMs" | "now"
  >;
}

export interface Collector {
  readonly config: CollectorConfig;
  readonly eventBus: CollectorEventBus;
  readonly push: SsePush;
  readonly server: Server;
  start(): Promise<number>;
  close(): Promise<void>;
  getBootstrap(): CollectorBootstrap;
  publishHealth(health: SourceHealth): Promise<boolean>;
}

interface PersistedCollectorState {
  version: 1;
  state: DashboardState;
}

interface PersistedSourceHealth {
  version: 1;
  health: SourceHealth;
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

function isSourceHealth(value: unknown): value is SourceHealth {
  return (
    isRecord(value) &&
    typeof value.source === "string" &&
    (value.status === "healthy" ||
      value.status === "stale" ||
      value.status === "degraded" ||
      value.status === "unavailable") &&
    typeof value.fresh === "boolean" &&
    typeof value.checkedAt === "string" &&
    (value.sourceUpdatedAt === undefined ||
      typeof value.sourceUpdatedAt === "string") &&
    (value.message === undefined || typeof value.message === "string")
  );
}

function isPersistedSourceHealth(
  value: unknown,
): value is PersistedSourceHealth {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isSourceHealth(value.health)
  );
}

function copyHealth(health: SourceHealth): SourceHealth {
  return {
    source: health.source,
    status: health.status,
    fresh: health.fresh,
    checkedAt: health.checkedAt,
    ...(health.sourceUpdatedAt === undefined
      ? {}
      : { sourceUpdatedAt: health.sourceUpdatedAt }),
    ...(health.message === undefined
      ? {}
      : { message: health.message }),
  };
}

function healthChanged(
  previous: SourceHealth | undefined,
  next: SourceHealth,
): boolean {
  return (
    previous === undefined ||
    previous.status !== next.status ||
    previous.fresh !== next.fresh ||
    previous.sourceUpdatedAt !== next.sourceUpdatedAt ||
    previous.message !== next.message
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
      scorecards: [],
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
    return loadFixtureState();
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

function validateHealth(health: SourceHealth): void {
  if (
    health.source.trim().length === 0 ||
    !Number.isFinite(Date.parse(health.checkedAt)) ||
    (health.sourceUpdatedAt !== undefined &&
      !Number.isFinite(Date.parse(health.sourceUpdatedAt)))
  ) {
    throw new TypeError("health requires a source and valid timestamps");
  }
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

  const healthRecords =
    await storage.read<unknown>(COLLECTOR_HEALTH_STREAM);
  const health = new Map<string, SourceHealth>();
  for (const record of healthRecords) {
    if (isPersistedSourceHealth(record)) {
      health.set(record.health.source, copyHealth(record.health));
    }
  }

  const getBootstrap = (): CollectorBootstrap => ({
    state,
    health: Object.fromEntries(
      [...health.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([source, value]) => [source, copyHealth(value)]),
    ),
  });
  const push = new SsePush({
    storage,
    getBootstrap,
    secrets: credentialValues(config),
    ...options.sse,
  });
  await push.restore();

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

  const publishHealth = async (
    nextHealth: SourceHealth,
  ): Promise<boolean> => {
    validateHealth(nextHealth);
    const next = copyHealth(nextHealth);
    const previous = health.get(next.source);
    if (!healthChanged(previous, next)) {
      health.set(next.source, next);
      return false;
    }

    health.set(next.source, next);
    await storage.append(COLLECTOR_HEALTH_STREAM, {
      version: 1,
      health: next,
    } satisfies PersistedSourceHealth);
    await push.publish("health", next);
    return true;
  };

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
        "Access-Control-Allow-Headers": "Last-Event-ID",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
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
      sendJson(response, 200, { health: getBootstrap().health }, secrets);
      return;
    }

    sendJson(response, 404, { error: "Not found" }, secrets);
  };

  server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(
          response,
          500,
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
    push,
    server,
    async start() {
      startPromise ??= listen(server, config.port, host);
      return startPromise;
    },
    async close() {
      for (const unsubscribe of unsubscribers) unsubscribe();
      await push.close();
      await closeServer(server);
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
