import { afterEach, describe, expect, it, vi } from "vitest";
import { LabTimeline } from "./timeline.ts";
import { LabWatcher } from "./watcher.ts";

const BASE_TIME = Date.parse("2026-08-01T20:00:00.000Z");

function citoResponse(roundStats: unknown[]): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        availability:
          roundStats.length > 0 ? "available" : "pending_stat_enrichment",
        roundStats,
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LabWatcher CITO round polling", () => {
  it("checks every five seconds and stops requesting after stats arrive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(citoResponse([]))
      .mockResolvedValueOnce(
        citoResponse([
          { fighterSlug: "red-fighter", round: 2, significantStrikes: "12 of 20" },
          { fighterSlug: "blue-fighter", round: 2, significantStrikes: "9 of 18" },
        ]),
      );
    const timeline = new LabTimeline({ now: () => Date.now() });
    const watcher = new LabWatcher({
      timeline,
      fetchImpl,
      now: () => Date.now(),
      env: {
        CITO_API_BASE_URL: "https://cito.example.test/api/v1",
        CITO_API_KEY: "test-key",
      },
    });

    watcher.start({ citoBoutIds: ["12879"], citoIntervalMs: 5_000 });
    timeline.record({
      kind: "marker",
      source: "user",
      label: "round ended (broadcast)",
      boutId: "12879",
      round: 2,
    });
    watcher.markRoundEnded(2, "12879");

    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(timeline.since(0)).toContainEqual(
      expect.objectContaining({
        source: "cito",
        boutId: "12879",
        round: 2,
        deltaMs: 10_000,
        detail: expect.objectContaining({
          availability: "available",
          rows: expect.any(Array),
        }),
      }),
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it("cancels the next CITO check when stopped manually", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const fetchImpl = vi.fn<typeof fetch>();
    const watcher = new LabWatcher({
      timeline: new LabTimeline({ now: () => Date.now() }),
      fetchImpl,
      now: () => Date.now(),
      env: {
        CITO_API_BASE_URL: "https://cito.example.test/api/v1",
        CITO_API_KEY: "test-key",
      },
    });

    watcher.start({ citoBoutIds: ["12879"], citoIntervalMs: 5_000 });
    watcher.markRoundEnded(1, "12879");
    watcher.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
