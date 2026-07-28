import { describe, expect, it, vi } from "vitest";
import {
  METRIC_NAMES,
  SourceHealthRegistry,
} from "./health.ts";
import { RollingQuotaGuard } from "./quota.ts";
import { MemoryStorage } from "./storage.ts";

describe("SourceHealthRegistry", () => {
  it("persists all observability metrics and restores source/local timestamps separately", async () => {
    const storage = new MemoryStorage();
    const now = "2026-07-26T02:41:00.000Z";
    const registry = await SourceHealthRegistry.create({
      storage,
      now: () => now,
      persistIntervalMs: 60_000,
    });
    for (const metric of METRIC_NAMES) {
      if (
        metric === "source_requests_total" ||
        metric === "source_errors_total" ||
        metric === "websocket_reconnects_total" ||
        metric === "parser_failures_total" ||
        metric === "provisional_records_total" ||
        metric === "revisions_total"
      ) {
        registry.increment(metric, "fixture", 1, {
          sourceTimestamp: "2026-07-26T02:40:58.000Z",
          localTimestamp: now,
        });
      } else {
        registry.set(metric, "fixture", 2, {
          sourceTimestamp: "2026-07-26T02:40:58.000Z",
          localTimestamp: now,
        });
      }
    }
    await registry.close();

    const restored = await SourceHealthRegistry.create({
      storage,
      now: () => now,
      persistIntervalMs: 60_000,
    });
    expect(restored.getSourceMetrics("fixture")).toEqual({
      source: "fixture",
      values: Object.fromEntries(
        METRIC_NAMES.map((metric) => [
          metric,
          metric.endsWith("_total") ? 1 : 2,
        ]),
      ),
      sourceTimestamp: "2026-07-26T02:40:58.000Z",
      localTimestamp: now,
    });
    await restored.close();
  });

  it("emits and records quota and freshness threshold crossings", async () => {
    const storage = new MemoryStorage();
    const publish = vi.fn(async () => undefined);
    const registry = await SourceHealthRegistry.create({
      storage,
      now: () => "2026-07-26T02:41:00.000Z",
      persistIntervalMs: 60_000,
      staleAfterMs: { espn: 1_000 },
      quotaThresholds: { "odds-api-io": 2 },
      publish,
    });
    const quota = await RollingQuotaGuard.create({
      storage,
      policies: {
        "odds-api-io": {
          perMinute: 4,
          perHour: 4,
          perDay: 4,
        },
      },
      clock: { now: () => Date.parse("2026-07-26T02:41:00Z") },
      metrics: registry,
    });

    await quota.tryAcquire("odds-api-io");
    await quota.tryAcquire("odds-api-io");
    registry.recordPayload(
      "espn",
      "2026-07-26T02:40:55.000Z",
      "2026-07-26T02:41:00.000Z",
    );
    await registry.flush();

    expect(registry.getAlerts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "odds-api-io",
          type: "quota",
          alert: true,
        }),
        expect.objectContaining({
          source: "espn",
          type: "freshness",
          alert: true,
        }),
      ]),
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "odds-api-io",
        alert: true,
        alertType: "quota",
        metrics: expect.any(Object),
      }),
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "espn",
        status: "stale",
        fresh: false,
        alert: true,
      }),
    );
    await registry.close();
  });
});
