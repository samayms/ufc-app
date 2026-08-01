import { DEFAULT_GEMINI_MODEL } from "./geminiSummarizer.ts";
import { DEFAULT_DATA_DIRECTORY } from "./storage.ts";

export const CREDENTIAL_ENV_NAMES = [
  "ODDS_API_IO_KEY",
  "THE_ODDS_API_KEY",
  "KALSHI_API_KEY_ID",
  "KALSHI_PRIVATE_KEY_PATH",
  "GEMINI_API_KEY",
] as const;

export type CredentialEnvName = (typeof CREDENTIAL_ENV_NAMES)[number];
export type DataMode = "fixture" | "live";

export interface CollectorConfig {
  dataMode: DataMode;
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
  /**
   * Target interval for each sportsbook API while a bout is actually live.
   * These are targets, not guarantees: the quota guards slow or stop polling
   * before a plan is exhausted, and quota protection always wins. The Odds
   * API's plan is 500 requests a *month*, so its interval degrades to
   * round-boundary-only long before the target is reached.
   */
  activePollMs: {
    oddsApiIo: number;
    theOddsApi: number;
  };
  /** Whether the lifecycle driver polls providers and drives FightLifecycleMachine. */
  lifecycleDriverEnabled: boolean;
  /** Whether the collector owns the pre-event upcoming-market schedule. */
  preEventPollEnabled: boolean;
  preEventPollIntervalMs: {
    nonEventDay: number;
    eventDay: number;
  };
  /** Delay for a transient pre-event sync failure. */
  preEventPollRetryMs: number;
  oddsApiIoBookmakers: readonly string[];
  sherdog: {
    permissionScope: string;
    requestIntervalMs: number;
    baseUrl: string;
    /**
     * The card's play-by-play page. One page carries every bout, so this is
     * set per event rather than per bout; a bout's own Sherdog external ref
     * still wins where one exists.
     */
    liveBlogUrl?: string;
  };
  /** Model-written condensations of each Sherdog round, for the summary box. */
  roundSummary: {
    enabled: boolean;
    model: string;
  };
  credentials: Readonly<Partial<Record<CredentialEnvName, string>>>;
}

export type CollectorEnvironment = Readonly<
  Record<string, string | undefined>
>;

const LIVE_REQUIRED_CREDENTIALS: readonly CredentialEnvName[] = [
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


function assertLiveCredentials(
  credentials: Readonly<Partial<Record<CredentialEnvName, string>>>,
): void {
  const missing = LIVE_REQUIRED_CREDENTIALS.filter(
    (name) => !credentials[name],
  );

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
  const credentials = readCredentials(env);

  if (dataMode === "live") {
    assertLiveCredentials(credentials);
  }

  return {
    dataMode,
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
      espn: parsePositiveInteger(env, "POLL_ESPN_MS", 2_500),
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
    activePollMs: {
      oddsApiIo: parsePositiveInteger(
        env,
        "ODDS_API_IO_ACTIVE_POLL_MS",
        60_000,
      ),
      theOddsApi: parsePositiveInteger(
        env,
        "THE_ODDS_API_ACTIVE_POLL_MS",
        45_000,
      ),
    },
    lifecycleDriverEnabled:
      parseOptionalBoolean(env, "LIFECYCLE_DRIVER_ENABLED") ??
      dataMode === "live",
    preEventPollEnabled:
      parseOptionalBoolean(env, "PRE_EVENT_POLL_ENABLED") ??
      dataMode === "live",
    preEventPollIntervalMs: {
      nonEventDay: parsePositiveInteger(
        env,
        "PRE_EVENT_POLL_NON_EVENT_DAY_MS",
        12 * 60 * 60 * 1_000,
      ),
      eventDay: parsePositiveInteger(
        env,
        "PRE_EVENT_POLL_EVENT_DAY_MS",
        60 * 60 * 1_000,
      ),
    },
    preEventPollRetryMs: parsePositiveInteger(
      env,
      "PRE_EVENT_POLL_RETRY_MS",
      900_000,
    ),
    oddsApiIoBookmakers: parseBookmakers(env),
    sherdog: {
      permissionScope:
        env.SHERDOG_PERMISSION_SCOPE?.trim() || "none",
      requestIntervalMs: parsePositiveInteger(
        env,
        "SHERDOG_REQUEST_INTERVAL_MS",
        10_000,
      ),
      baseUrl:
        env.SHERDOG_BASE_URL?.trim() || "https://www.sherdog.com",
      ...(env.SHERDOG_LIVE_BLOG_URL?.trim()
        ? { liveBlogUrl: env.SHERDOG_LIVE_BLOG_URL.trim() }
        : {}),
    },
    roundSummary: {
      enabled: parseOptionalBoolean(env, "ROUND_SUMMARY_ENABLED") ?? true,
      model: env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
    },
    credentials,
  };
}
