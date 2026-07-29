import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_ENV_NAMES,
  credentialValues,
  loadConfig,
} from "./config.ts";

describe("loadConfig", () => {
  it("uses network-free fixture defaults", () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      dataMode: "fixture",
      xMode: "embed",
      port: 8600,
      persistencePath: "./data",
      oddsApiIoBookmakers: ["Bet365", "DraftKings"],
      xSpendCapUsd: 0,
      sherdog: {
        permissionScope: "none",
        requestIntervalMs: 300_000,
      },
      credentials: {},
    });
  });

  it("parses collector timing, routing, permission, and spend settings", () => {
    const config = loadConfig({
      COLLECTOR_PORT: "0",
      PERSISTENCE_PATH: "/tmp/ufc-data",
      ODDS_API_IO_BOOKMAKERS: " FanDuel,betmgm,fanduel ",
      X_MODE: "manual",
      X_SPEND_CAP_USD: "12.50",
      X_REQUEST_COST_USD: "0.02",
      X_MANUAL_SCORES_JSON: JSON.stringify([
        {
          boutId: "bout-main",
          sourcePostId: "123",
          scorer: "MMAJunkie",
          round: 1,
          score: { red: 10, blue: 9 },
          postUrl: "https://x.com/MMAJunkie/status/123",
        },
      ]),
      SHERDOG_PERMISSION_SCOPE: "live-blog-read",
      SHERDOG_REQUEST_INTERVAL_MS: "600000",
      STALE_LIFECYCLE_MS: "1000",
      POLL_ESPN_MS: "2000",
    });

    expect(config.port).toBe(0);
    expect(config.persistencePath).toBe("/tmp/ufc-data");
    // Case is preserved for the outbound request (Odds-API.io rejects
    // lowercased names), while duplicates still collapse case-insensitively.
    expect(config.oddsApiIoBookmakers).toEqual([
      "FanDuel",
      "betmgm",
    ]);
    expect(config.xMode).toBe("manual");
    expect(config.xSpendCapUsd).toBe(12.5);
    expect(config.xRequestCostUsd).toBe(0.02);
    expect(config.xManualScores).toEqual([
      expect.objectContaining({
        sourcePostId: "123",
        score: { red: 10, blue: 9 },
      }),
    ]);
    expect(config.sherdog).toEqual({
      permissionScope: "live-blog-read",
      requestIntervalMs: 600_000,
    });
    expect(config.staleAfterMs.lifecycle).toBe(1000);
    expect(config.pollingMs.espn).toBe(2000);
  });

  it("defaults the lifecycle driver on for live mode and off for fixture mode", () => {
    expect(loadConfig({}).lifecycleDriverEnabled).toBe(false);
    expect(loadConfig({}).lifecycleEspnFailureThreshold).toBe(3);
    expect(loadConfig({}).citoApiBaseUrl).toBeUndefined();

    const base = Object.fromEntries(
      CREDENTIAL_ENV_NAMES.filter((name) => name !== "X_BEARER_TOKEN").map(
        (name) => [name, `secret-${name}`],
      ),
    );
    expect(
      loadConfig({ ...base, DATA_MODE: "live" }).lifecycleDriverEnabled,
    ).toBe(true);
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
    });

    expect(config.lifecycleEspnFailureThreshold).toBe(5);
    expect(config.citoApiBaseUrl).toBe("https://cito.example.invalid");
  });

  it("fails closed when live data credentials are absent", () => {
    expect(() => loadConfig({ DATA_MODE: "live" })).toThrow(
      /CITO_API_KEY.*ODDS_API_IO_KEY.*THE_ODDS_API_KEY.*KALSHI_API_KEY_ID.*KALSHI_PRIVATE_KEY_PATH/,
    );
  });

  it("requires the X bearer token only for API mode", () => {
    const base = Object.fromEntries(
      CREDENTIAL_ENV_NAMES.filter(
        (name) => name !== "X_BEARER_TOKEN",
      ).map((name) => [name, `secret-${name}`]),
    );

    expect(() => loadConfig({ X_MODE: "api" })).toThrow(
      /X_BEARER_TOKEN/,
    );

    expect(() =>
      loadConfig({
        ...base,
        DATA_MODE: "live",
        X_MODE: "api",
      }),
    ).toThrow(/X_BEARER_TOKEN/);

    const config = loadConfig({
      ...base,
      DATA_MODE: "live",
      X_MODE: "embed",
    });
    expect(credentialValues(config)).toHaveLength(5);
  });
});
