import { afterEach, describe, expect, it, vi } from "vitest";
import liveOdds from "../src/fixtures/oddsApiIoOddsLive.json" with {
  type: "json",
};
import {
  createCollector,
  loadFixtureState,
  type Collector,
} from "./collector.ts";
import { KalshiFixtureTransport } from "./kalshiTransport.ts";
import { PolymarketFixtureTransport } from "./polymarketTransport.ts";
import { MemoryStorage } from "./storage.ts";

const collectors: Collector[] = [];

class ManualTime {
  value = Date.parse("2026-07-26T02:40:40Z");

  private nextId = 1;

  private readonly timers = new Map<
    number,
    { callback: () => void; dueAt: number }
  >();

  now(): number {
    return this.value;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, {
      callback,
      dueAt: this.value + delayMs,
    });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.value)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.dueAt - right.dueAt || leftId - rightId,
        )[0];
      if (due === undefined) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

afterEach(async () => {
  await Promise.all(
    collectors.splice(0).map((collector) => collector.close()),
  );
});

describe("collector market transport wiring", () => {
  it("installs live sportsbook hooks and keeps fixture mode network-free", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      return new Response(JSON.stringify(liveOdds), { status: 200 });
    }) as unknown as typeof fetch;
    const liveCollector = await createCollector({
      env: {
        DATA_MODE: "live",
        COLLECTOR_PORT: "0",
        CITO_API_KEY: "cito-key",
        ODDS_API_IO_KEY: "odds-io-key",
        THE_ODDS_API_KEY: "odds-api-key",
        KALSHI_API_KEY_ID: "kalshi-id",
        KALSHI_PRIVATE_KEY_PATH: "not-read-with-injected-transports",
        LIFECYCLE_DRIVER_ENABLED: "false",
        PRE_EVENT_POLL_ENABLED: "false",
      },
      storage: new MemoryStorage(),
      market: { transports: [] },
      sportsbook: { fetchImpl },
      stateLoader: async () => {
        const state = await loadFixtureState();
        const fixtureBout = state.event.bouts.find(
          (bout) => bout.id === "bout-main",
        );
        if (fixtureBout === undefined) throw new Error("Missing fixture bout");
        const fixtureView = state.boutViews[fixtureBout.id];
        if (fixtureView === undefined) throw new Error("Missing fixture view");
        const bout = {
          ...fixtureBout,
          fighters: {
            red: { ...fixtureBout.fighters.red, name: "Spasic, Marina" },
            blue: {
              ...fixtureBout.fighters.blue,
              name: "Luciano, Stephanie Bruna",
            },
          },
          externalRefs: fixtureBout.externalRefs.map((ref) =>
            ref.source === "odds-api-io"
              ? { ...ref, id: String(liveOdds.id) }
              : ref,
          ),
        };
        return {
          ...state,
          event: {
            ...state.event,
            bouts: state.event.bouts.map((candidate) =>
              candidate.id === bout.id ? bout : candidate,
            ),
          },
          boutViews: {
            ...state.boutViews,
            [bout.id]: { ...fixtureView, bout },
          },
        };
      },
    });
    collectors.push(liveCollector);

    liveCollector.eventBus.emit({
      type: "FIGHT_STARTED",
      boutId: "bout-main",
      detectedAt: "2026-07-28T14:05:00.000Z",
    });
    await liveCollector.oddsApiIoPoller.idle();
    await liveCollector.theOddsApiActivePoller.idle();
    await liveCollector.tickStore.idle();

    expect(urls.some((url) => url.includes("api.odds-api.io/v3/odds"))).toBe(
      true,
    );
    expect(
      urls.some((url) =>
        url.includes("api.the-odds-api.com/v4/sports/mma_mixed_martial_arts"),
      ),
    ).toBe(true);
    await expect(
      liveCollector.tickStore.getTickHistory("bout-main", "odds-api-io"),
    ).resolves.toHaveLength(2);

    const fixtureFetch = vi.fn(async () => {
      throw new Error("fixture network forbidden");
    }) as unknown as typeof fetch;
    const fixtureCollector = await createCollector({
      env: { DATA_MODE: "fixture", COLLECTOR_PORT: "0" },
      storage: new MemoryStorage(),
      sportsbook: { fetchImpl: fixtureFetch },
    });
    collectors.push(fixtureCollector);
    fixtureCollector.oddsApiIoPoller.startActiveBout("bout-main");
    await fixtureCollector.oddsApiIoPoller.idle();
    expect(fixtureFetch).not.toHaveBeenCalled();
  });

  it("constructs dormant fixture replayers and starts them only on replay()", async () => {
    const storage = new MemoryStorage();
    const collector = await createCollector({
      env: { DATA_MODE: "fixture", COLLECTOR_PORT: "0" },
      storage,
      market: {
        clock: { now: () => Date.parse("2026-07-26T02:40:40Z") },
        staleAfterMs: 60_000,
      },
    });
    collectors.push(collector);

    expect(collector.marketTransports).toEqual([
      expect.any(KalshiFixtureTransport),
      expect.any(PolymarketFixtureTransport),
    ]);
    await expect(
      collector.tickStore.getTickHistory("bout-main"),
    ).resolves.toEqual([]);

    await collector.replayMarkets();
    await expect(
      collector.tickStore.getTickHistory("bout-main", "kalshi"),
    ).resolves.toHaveLength(6);
    await expect(
      collector.tickStore.getTickHistory("bout-main", "polymarket"),
    ).resolves.toHaveLength(6);
    await expect(
      collector.tickStore.getTickHistory("bout-main", "odds-api-io"),
    ).resolves.toHaveLength(4);
    expect(collector.getBootstrap()).toMatchObject({
      boutMappings: expect.arrayContaining([
        expect.objectContaining({
          internalBoutId: "bout-main",
          externalRefs: expect.arrayContaining([
            {
              source: "odds-api-io",
              id: "oai-bout-reyes-volkov",
            },
          ]),
        }),
      ]),
      latestMarkets: expect.arrayContaining([
        expect.objectContaining({
          source: "odds-api-io",
          bookmaker: "draftkings",
          rawOdds: -172,
        }),
      ]),
    });
    await expect(storage.read("sse-events")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "update",
          data: {
            kind: "market-tick",
            tick: expect.objectContaining({
              source: "odds-api-io",
              bookmaker: "draftkings",
            }),
          },
        }),
      ]),
    );
    collector.eventBus.emit({
      type: "PROVISIONAL_ROUND_ENDED",
      boutId: "bout-main",
      round: 2,
      detectedAt: "2026-07-26T02:40:40Z",
    });
    await collector.tickStore.idle();
    await collector.oddsApiIoPoller.idle();
    await collector.tickStore.idle();
    await collector.roundStats.idle();
    expect(
      collector.roundStats.getUnifiedRound("bout-main", 2),
    ).toMatchObject({
      marketAtEnd: {
        oddsApiIo: expect.objectContaining({
          source: "odds-api-io",
          boundaryType: "provisional",
        }),
      },
    });
  });

  it("wires the delayed broad-book snapshot into SSE, bootstrap, and the unified round", async () => {
    const storage = new MemoryStorage();
    const time = new ManualTime();
    const collector = await createCollector({
      env: { DATA_MODE: "fixture", COLLECTOR_PORT: "0" },
      storage,
      market: {
        clock: time,
        staleAfterMs: 60_000,
      },
      sportsbook: {
        clock: time,
        timer: time,
        random: () => 0,
      },
    });
    collectors.push(collector);

    collector.eventBus.emit({
      type: "ROUND_ENDED",
      boutId: "bout-main",
      round: 1,
      detectedAt: new Date(time.now()).toISOString(),
      confirmation: "period_transition",
    });
    await collector.roundStats.idle();
    await collector.theOddsApiJob.idle();
    time.advance(20_000);
    await collector.theOddsApiJob.idle();
    await collector.tickStore.idle();
    await collector.roundStats.idle();

    expect(collector.getBootstrap()).toMatchObject({
      latestMarkets: expect.arrayContaining([
        expect.objectContaining({
          source: "the-odds-api",
          bookmaker: "draftkings",
          rawOdds: -185,
        }),
      ]),
      marketSnapshots: expect.arrayContaining([
        expect.objectContaining({
          source: "the-odds-api",
          label: "broad-post-round-comparison",
        }),
      ]),
      unifiedRounds: expect.arrayContaining([
        expect.objectContaining({
          boutId: "bout-main",
          round: 1,
          marketAtEnd: {
            theOddsApi: expect.objectContaining({
              source: "the-odds-api",
              label: "broad-post-round-comparison",
            }),
          },
        }),
      ]),
    });
    await expect(storage.read("sse-events")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: {
            kind: "market-tick",
            tick: expect.objectContaining({
              source: "the-odds-api",
            }),
          },
        }),
        expect.objectContaining({
          data: {
            kind: "market-snapshot",
            snapshot: expect.objectContaining({
              source: "the-odds-api",
              label: "broad-post-round-comparison",
            }),
          },
        }),
      ]),
    );
  });
});
