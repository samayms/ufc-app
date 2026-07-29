import { DEFAULT_DATA_DIRECTORY } from "./storage.ts";
import type {
  XConfiguredScore,
  XEmbedMetadata,
} from "../src/sources/x.ts";

export const CREDENTIAL_ENV_NAMES = [
  "CITO_API_KEY",
  "ODDS_API_IO_KEY",
  "THE_ODDS_API_KEY",
  "KALSHI_API_KEY_ID",
  "KALSHI_PRIVATE_KEY_PATH",
  "X_BEARER_TOKEN",
] as const;

export type CredentialEnvName = (typeof CREDENTIAL_ENV_NAMES)[number];
export type DataMode = "fixture" | "live";
export type XMode = "disabled" | "embed" | "manual" | "api";

export interface CollectorConfig {
  dataMode: DataMode;
  xMode: XMode;
  port: number;
  persistencePath: string;
  staleAfterMs: {
    lifecycle: number;
    stats: number;
    markets: number;
    commentary: number;
  };
  pollingMs: {
    espn: number;
    cito: number;
    oddsApiIo: number;
    theOddsApi: number;
    kalshi: number;
    polymarket: number;
  };
  /** Whether the lifecycle driver polls providers and drives FightLifecycleMachine. */
  lifecycleDriverEnabled: boolean;
  /** Consecutive ESPN failures before falling back to the Cito provider. */
  lifecycleEspnFailureThreshold: number;
  /** Base URL for Cito's (unverified) live-state endpoint; required to construct a live Cito lifecycle provider. */
  citoApiBaseUrl?: string;
  oddsApiIoBookmakers: readonly string[];
  xSpendCapUsd: number;
  xRequestCostUsd: number;
  xEmbeds: readonly XEmbedMetadata[];
  xManualScores: readonly XConfiguredScore[];
  sherdog: {
    permissionScope: string;
    requestIntervalMs: number;
  };
  credentials: Readonly<Partial<Record<CredentialEnvName, string>>>;
}

export type CollectorEnvironment = Readonly<
  Record<string, string | undefined>
>;

const LIVE_REQUIRED_CREDENTIALS: readonly CredentialEnvName[] = [
  "CITO_API_KEY",
  "ODDS_API_IO_KEY",
  "THE_ODDS_API_KEY",
  "KALSHI_API_KEY_ID",
  "KALSHI_PRIVATE_KEY_PATH",
];

function parseChoice<Value extends string>(
  env: CollectorEnvironment,
  name: string,
  choices: readonly Value[],
  fallback: Value,
): Value {
  const value = env[name]?.trim() || fallback;

  if (!choices.includes(value as Value)) {
    throw new TypeError(
      `${name} must be one of: ${choices.join(", ")}`,
    );
  }

  return value as Value;
}

function parseNonNegativeNumber(
  env: CollectorEnvironment,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative number`);
  }

  return value;
}

function parsePositiveInteger(
  env: CollectorEnvironment,
  name: string,
  fallback: number,
): number {
  const value = parseNonNegativeNumber(env, name, fallback);

  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }

  return value;
}

function parseOptionalBoolean(
  env: CollectorEnvironment,
  name: string,
): boolean | undefined {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return undefined;

  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;

  throw new TypeError(`${name} must be "true" or "false"`);
}

function parsePort(env: CollectorEnvironment): number {
  const raw = env.COLLECTOR_PORT?.trim();
  if (!raw) return 8600;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError(
      "COLLECTOR_PORT must be an integer between 0 and 65535",
    );
  }

  return port;
}

function parseBookmakers(env: CollectorEnvironment): readonly string[] {
  // Probed live 2026-07-28: this account's free tier allows exactly two
  // bookmakers, "Bet365, DraftKings". Requesting FanDuel 403s the *whole*
  // request rather than degrading, so the previous draftkings,fanduel default
  // would have failed every live call. Still overridable per the architecture
  // note that book selection must not be permanently hard-coded; the plan
  // selection is changed via Odds-API.io's own bookmaker-selection endpoint.
  //
  // Case is preserved deliberately. Re-probed live 2026-07-29: these are
  // case-sensitive *display* names, and sending "bet365" fails the whole
  // request with `"bet365 is not a valid bookmaker"` rather than degrading.
  // Consumers compare them case-insensitively; only the outbound request
  // needs the exact casing. Duplicates are still collapsed case-insensitively.
  const raw = env.ODDS_API_IO_BOOKMAKERS ?? "Bet365,DraftKings";
  const seen = new Set<string>();
  const bookmakers: string[] = [];
  for (const entry of raw.split(",")) {
    const bookmaker = entry.trim();
    if (bookmaker.length === 0) continue;
    const key = bookmaker.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    bookmakers.push(bookmaker);
  }

  if (bookmakers.length === 0) {
    throw new TypeError(
      "ODDS_API_IO_BOOKMAKERS must include at least one bookmaker",
    );
  }

  return bookmakers;
}

function readCredentials(
  env: CollectorEnvironment,
): Readonly<Partial<Record<CredentialEnvName, string>>> {
  const credentials: Partial<Record<CredentialEnvName, string>> = {};

  for (const name of CREDENTIAL_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value) credentials[name] = value;
  }

  return credentials;
}

function parseXConfiguredScores(
  env: CollectorEnvironment,
  name: string,
): readonly XConfiguredScore[] {
  const raw = env[name]?.trim();
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new TypeError(`${name} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(`${name} must be a JSON array`);
  }

  return parsed.map((value, index) => {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof value.boutId !== "string" ||
      typeof value.sourcePostId !== "string" ||
      typeof value.scorer !== "string" ||
      !Number.isSafeInteger(value.round) ||
      typeof value.score !== "object" ||
      value.score === null ||
      !Number.isSafeInteger(value.score.red) ||
      !Number.isSafeInteger(value.score.blue) ||
      (value.postUrl !== undefined && typeof value.postUrl !== "string")
    ) {
      throw new TypeError(`${name}[${index}] is not a configured X score`);
    }
    return {
      boutId: value.boutId,
      sourcePostId: value.sourcePostId,
      scorer: value.scorer,
      round: value.round as number,
      score: {
        red: value.score.red as number,
        blue: value.score.blue as number,
      },
      ...(value.postUrl === undefined
        ? {}
        : { postUrl: value.postUrl }),
    };
  });
}

function parseXEmbeds(
  env: CollectorEnvironment,
  name: string,
): readonly XEmbedMetadata[] {
  const raw = env[name]?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new TypeError(`${name} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(`${name} must be a JSON array`);
  }
  return parsed.map((value, index) => {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof value.boutId !== "string" ||
      typeof value.postId !== "string" ||
      typeof value.scorer !== "string" ||
      (value.round !== undefined && !Number.isSafeInteger(value.round)) ||
      (value.postUrl !== undefined && typeof value.postUrl !== "string")
    ) {
      throw new TypeError(`${name}[${index}] is not X embed metadata`);
    }
    return {
      boutId: value.boutId,
      postId: value.postId,
      scorer: value.scorer,
      ...(value.round === undefined
        ? {}
        : { round: value.round as number }),
      ...(value.postUrl === undefined ? {} : { postUrl: value.postUrl }),
    };
  });
}

function assertLiveCredentials(
  credentials: Readonly<Partial<Record<CredentialEnvName, string>>>,
  xMode: XMode,
): void {
  const required =
    xMode === "api"
      ? [...LIVE_REQUIRED_CREDENTIALS, "X_BEARER_TOKEN" as const]
      : LIVE_REQUIRED_CREDENTIALS;
  const missing = required.filter((name) => !credentials[name]);

  if (missing.length > 0) {
    throw new Error(
      `Live mode requires server credentials: ${missing.join(", ")}`,
    );
  }
}

export function credentialValues(
  config: Pick<CollectorConfig, "credentials">,
): readonly string[] {
  return CREDENTIAL_ENV_NAMES.flatMap((name) => {
    const value = config.credentials[name];
    return value === undefined ? [] : [value];
  });
}

export function loadConfig(
  env: CollectorEnvironment = process.env,
): CollectorConfig {
  const dataMode = parseChoice(
    env,
    "DATA_MODE",
    ["fixture", "live"] as const,
    "fixture",
  );
  const xMode = parseChoice(
    env,
    "X_MODE",
    ["disabled", "embed", "manual", "api"] as const,
    "embed",
  );
  const credentials = readCredentials(env);

  if (xMode === "api" && !credentials.X_BEARER_TOKEN) {
    throw new Error("X API mode requires server credentials: X_BEARER_TOKEN");
  }
  if (dataMode === "live") {
    assertLiveCredentials(credentials, xMode);
  }

  return {
    dataMode,
    xMode,
    port: parsePort(env),
    persistencePath:
      env.PERSISTENCE_PATH?.trim() || DEFAULT_DATA_DIRECTORY,
    staleAfterMs: {
      lifecycle: parsePositiveInteger(env, "STALE_LIFECYCLE_MS", 30_000),
      stats: parsePositiveInteger(env, "STALE_STATS_MS", 90_000),
      markets: parsePositiveInteger(env, "STALE_MARKETS_MS", 30_000),
      commentary: parsePositiveInteger(
        env,
        "STALE_COMMENTARY_MS",
        120_000,
      ),
    },
    pollingMs: {
      espn: parsePositiveInteger(env, "POLL_ESPN_MS", 5_000),
      cito: parsePositiveInteger(env, "POLL_CITO_MS", 15_000),
      oddsApiIo: parsePositiveInteger(
        env,
        "POLL_ODDS_API_IO_MS",
        30_000,
      ),
      theOddsApi: parsePositiveInteger(
        env,
        "POLL_THE_ODDS_API_MS",
        30_000,
      ),
      kalshi: parsePositiveInteger(env, "POLL_KALSHI_MS", 5_000),
      polymarket: parsePositiveInteger(
        env,
        "POLL_POLYMARKET_MS",
        5_000,
      ),
    },
    lifecycleDriverEnabled:
      parseOptionalBoolean(env, "LIFECYCLE_DRIVER_ENABLED") ??
      dataMode === "live",
    lifecycleEspnFailureThreshold: parsePositiveInteger(
      env,
      "LIFECYCLE_ESPN_FAILURE_THRESHOLD",
      3,
    ),
    ...(env.CITO_API_BASE_URL?.trim()
      ? { citoApiBaseUrl: env.CITO_API_BASE_URL.trim() }
      : {}),
    oddsApiIoBookmakers: parseBookmakers(env),
    xSpendCapUsd: parseNonNegativeNumber(env, "X_SPEND_CAP_USD", 0),
    xRequestCostUsd: parseNonNegativeNumber(
      env,
      "X_REQUEST_COST_USD",
      0.01,
    ),
    xEmbeds: parseXEmbeds(env, "X_EMBED_POSTS_JSON"),
    xManualScores: parseXConfiguredScores(
      env,
      "X_MANUAL_SCORES_JSON",
    ),
    sherdog: {
      permissionScope:
        env.SHERDOG_PERMISSION_SCOPE?.trim() || "none",
      requestIntervalMs: parsePositiveInteger(
        env,
        "SHERDOG_REQUEST_INTERVAL_MS",
        300_000,
      ),
    },
    credentials,
  };
}
