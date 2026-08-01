import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_ENV_NAMES,
  credentialValues,
  loadConfig,
} from "./config.ts";
import { DEFAULT_GEMINI_MODEL } from "./geminiSummarizer.ts";

describe("loadConfig", () => {
  it("uses network-free fixture defaults", () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      dataMode: "fixture",
      preEventPollEnabled: false,
      preEventPollIntervalMs: {
        nonEventDay: 12 * 60 * 60 * 1_000,
        eventDay: 60 * 60 * 1_000,
      },
      preEventPollRetryMs: 900_000,
      port: 8600,
      persistencePath: "./data",
      oddsApiIoBookmakers: ["Bet365", "DraftKings"],
      sherdog: {
        permissionScope: "none",
        requestIntervalMs: 300_000,
        baseUrl: "https://www.sherdog.com",
      },
      roundSummary: {
        enabled: true,
        model: DEFAULT_GEMINI_MODEL,
      },
      credentials: {},
    });
  });

  it("parses collector timing, routing, and permission settings", () => {
    const config = loadConfig({
      COLLECTOR_PORT: "0",
      PERSISTENCE_PATH: "/tmp/ufc-data",
      ODDS_API_IO_BOOKMAKERS: " FanDuel,betmgm,fanduel ",
      SHERDOG_PERMISSION_SCOPE: "live-blog-read",
      SHERDOG_REQUEST_INTERVAL_MS: "600000",
      SHERDOG_BASE_URL: "https://sherdog.example.invalid",
      SHERDOG_LIVE_BLOG_URL: "/news/news/live-card-1234",
      ROUND_SUMMARY_ENABLED: "false",
      GEMINI_MODEL: "gemini-test-model",
      STALE_LIFECYCLE_MS: "1000",
      POLL_ESPN_MS: "2000",
      PRE_EVENT_POLL_NON_EVENT_DAY_MS: "200",
      PRE_EVENT_POLL_EVENT_DAY_MS: "100",
      PRE_EVENT_POLL_RETRY_MS: "50",
    });

    expect(config.port).toBe(0);
    expect(config.persistencePath).toBe("/tmp/ufc-data");
    // Case is preserved for the outbound request (Odds-API.io rejects
    // lowercased names), while duplicates still collapse case-insensitively.
    expect(config.oddsApiIoBookmakers).toEqual([
      "FanDuel",
      "betmgm",
    ]);
    expect(config.sherdog).toEqual({
      permissionScope: "live-blog-read",
      requestIntervalMs: 600_000,
      baseUrl: "https://sherdog.example.invalid",
      liveBlogUrl: "/news/news/live-card-1234",
    });
    expect(config.roundSummary).toEqual({
      enabled: false,
      model: "gemini-test-model",
    });
    expect(config.staleAfterMs.lifecycle).toBe(1000);
    expect(config.pollingMs.espn).toBe(2000);
    expect(config.preEventPollIntervalMs).toEqual({
      nonEventDay: 200,
      eventDay: 100,
    });
    expect(config.preEventPollRetryMs).toBe(50);
  });

  it("defaults the lifecycle driver on for live mode and off for fixture mode", () => {
    expect(loadConfig({}).lifecycleDriverEnabled).toBe(false);
    expect(loadConfig({}).preEventPollEnabled).toBe(false);
    expect(loadConfig({}).lifecycleEspnFailureThreshold).toBe(3);
    expect(loadConfig({}).citoApiBaseUrl).toBeUndefined();

    const base = Object.fromEntries(
      CREDENTIAL_ENV_NAMES.map((name) => [name, `secret-${name}`]),
    );
    expect(
      loadConfig({ ...base, DATA_MODE: "live" }).lifecycleDriverEnabled,
    ).toBe(true);
    expect(
      loadConfig({ ...base, DATA_MODE: "live" }).preEventPollEnabled,
    ).toBe(true);
  });

  it("parses an explicit PRE_EVENT_POLL_ENABLED override in either mode", () => {
    expect(
      loadConfig({ PRE_EVENT_POLL_ENABLED: "true" }).preEventPollEnabled,
    ).toBe(true);
    expect(
      loadConfig({ PRE_EVENT_POLL_ENABLED: "false" }).preEventPollEnabled,
    ).toBe(false);
    expect(() =>
      loadConfig({ PRE_EVENT_POLL_ENABLED: "sometimes" }),
    ).toThrow(/PRE_EVENT_POLL_ENABLED/);
  });

  it("parses an explicit LIFECYCLE_DRIVER_ENABLED override in either mode", () => {
    expect(
      loadConfig({ LIFECYCLE_DRIVER_ENABLED: "true" }).lifecycleDriverEnabled,
    ).toBe(true);
    expect(
      loadConfig({ LIFECYCLE_DRIVER_ENABLED: "false" })
        .lifecycleDriverEnabled,
    ).toBe(false);
    expect(() =>
      loadConfig({ LIFECYCLE_DRIVER_ENABLED: "sometimes" }),
    ).toThrow(/LIFECYCLE_DRIVER_ENABLED/);
  });

  it("parses the ESPN failure threshold and Cito base URL", () => {
    const config = loadConfig({
      LIFECYCLE_ESPN_FAILURE_THRESHOLD: "5",
      CITO_API_BASE_URL: "https://cito.example.invalid",
      CITO_EVENT_SLUG: " ufc-fight-night-august-01-2026 ",
    });

    expect(config.lifecycleEspnFailureThreshold).toBe(5);
    expect(config.citoApiBaseUrl).toBe("https://cito.example.invalid");
    expect(config.citoEventSlug).toBe("ufc-fight-night-august-01-2026");
  });

  it("fails closed when live data credentials are absent", () => {
    expect(() => loadConfig({ DATA_MODE: "live" })).toThrow(
      /CITO_API_KEY.*ODDS_API_IO_KEY.*THE_ODDS_API_KEY.*KALSHI_API_KEY_ID.*KALSHI_PRIVATE_KEY_PATH/,
    );
  });

  it("credentialValues returns every configured credential", () => {
    const base = Object.fromEntries(
      CREDENTIAL_ENV_NAMES.map((name) => [name, `secret-${name}`]),
    );

    const config = loadConfig({ ...base, DATA_MODE: "live" });
    expect(credentialValues(config)).toHaveLength(CREDENTIAL_ENV_NAMES.length);
  });
});
