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
      oddsApiIoBookmakers: ["draftkings", "fanduel"],
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
    expect(config.oddsApiIoBookmakers).toEqual([
      "fanduel",
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
