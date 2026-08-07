import { describe, expect, it, vi } from "vitest";
import kalshiFixture from "../src/fixtures/kalshiTicks.json" with {
  type: "json",
};
import polymarketFixture from "../src/fixtures/polymarketTicks.json" with {
  type: "json",
};
import { CollectorEventBus } from "./eventBus.ts";
import { MemoryStorage } from "./storage.ts";
import {
  MARKET_SNAPSHOTS_STORAGE_STREAM,
  MARKET_TICKS_STORAGE_STREAM,
  MarketTickStore,
  type MarketTick,
  type TickStoreClock,
} from "./tickStore.ts";

const BOUT_ID = "bout-main";
const BASE_TIME = Date.parse("2026-07-26T02:40:00Z");

class ManualClock implements TickStoreClock {
  value = BASE_TIME;

  now(): number {
    return this.value;
  }
}

function at(offsetMs: number): string {
  return new Date(BASE_TIME + offsetMs).toISOString();
}

function tick(
  outcome: string,
  values: Partial<MarketTick> = {},
): MarketTick {
  return {
    source: "polymarket",
    boutId: BOUT_ID,
    marketType: "fight-winner",
    outcome,
    bid: outcome === "red" ? 0.58 : 0.4,
    ask: outcome === "red" ? 0.6 : 0.42,
    lastTrade: outcome === "red" ? 0.59 : 0.41,
    sourceUpdatedAt: at(0),
    receivedAt: at(0),
    stale: false,
    ...values,
  };
}

async function setup(options: {
  storage?: MemoryStorage;
  clock?: ManualClock;
  staleAfterMs?: number;
  // Existing tests assert on synchronous per-tick persistence, unrelated to
  // the sampled-persistence behavior; default to immediate writes here and
  // opt individual tests into sampling explicitly.
  persistIntervalMs?: number;
  onSnapshot?: (snapshot: Parameters<
    NonNullable<
      ConstructorParameters<typeof MarketTickStore>[0]["onSnapshot"]
    >
  >[0]) => Promise<void>;
} = {}): Promise<{
  bus: CollectorEventBus;
  clock: ManualClock;
  storage: MemoryStorage;
  store: MarketTickStore;
}> {
  const bus = new CollectorEventBus();
  const clock = options.clock ?? new ManualClock();
  const storage = options.storage ?? new MemoryStorage();
  const store = await MarketTickStore.create({
    eventBus: bus,
    storage,
    clock,
    staleAfterMs: options.staleAfterMs ?? 30_000,
    persistIntervalMs: options.persistIntervalMs ?? 0,
    ...(options.onSnapshot === undefined
      ? {}
      : { onSnapshot: options.onSnapshot }),
  });
  return { bus, clock, storage, store };
}

describe("MarketTickStore", () => {
  it("appends every accepted tick and updates latest state", async () => {
    const { storage, store } = await setup();

    await store.appendTick(tick("red"));
    await store.appendTick(
      tick("red", {
        bid: 0.62,
        ask: 0.64,
        sourceUpdatedAt: at(1_000),
        receivedAt: at(1_100),
      }),
    );

    await expect(store.getTickHistory(BOUT_ID)).resolves.toHaveLength(2);
    await expect(storage.read(MARKET_TICKS_STORAGE_STREAM)).resolves.toHaveLength(
      2,
    );
    expect(store.getLatest(BOUT_ID)).toEqual([
      expect.objectContaining({
        outcome: "red",
        bid: 0.62,
        ask: 0.64,
        midpoint: 0.63,
        impliedProbability: 0.63,
      }),
    ]);
    await store.close();
  });

  it("samples durable persistence to roughly once per second per key while applying every tick in memory", async () => {
    const clock = new ManualClock();
    const storage = new MemoryStorage();
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const timer = {
      setTimeout: (callback: () => void, delayMs: number) => {
        const handle = { callback, delayMs };
        timers.push(handle);
        return handle;
      },
      clearTimeout: (handle: unknown) => {
        const index = timers.indexOf(
          handle as (typeof timers)[number],
        );
        if (index >= 0) timers.splice(index, 1);
      },
    };
    const bus = new CollectorEventBus();
    const store = await MarketTickStore.create({
      eventBus: bus,
      storage,
      clock,
      persistIntervalMs: 1_000,
      timer,
    });

    await store.appendTick(tick("red"));
    await store.appendTick(tick("red", { bid: 0.6, ask: 0.62 }));
    await store.appendTick(tick("red", { bid: 0.61, ask: 0.63 }));

    // In-memory state reflects every tick immediately.
    expect(store.getLatest(BOUT_ID)[0]).toMatchObject({
      bid: 0.61,
      ask: 0.63,
    });
    // Only the first tick for this key was durably written so far — the
    // second and third landed inside the same 1s sampling window.
    await expect(
      storage.read(MARKET_TICKS_STORAGE_STREAM),
    ).resolves.toHaveLength(1);

    // The trailing flush lands the *latest* sample once the window elapses,
    // not the stale one that first triggered it.
    expect(timers).toHaveLength(1);
    timers[0]?.callback();
    await store.idle();
    await expect(
      storage.read(MARKET_TICKS_STORAGE_STREAM),
    ).resolves.toHaveLength(2);
    const persisted = (await storage.read<{
      tick: MarketTick;
    }>(MARKET_TICKS_STORAGE_STREAM)).map((record) => record.tick);
    expect(persisted[1]).toMatchObject({ bid: 0.61, ask: 0.63 });

    await store.close();
  });

  it("prefers the bid/ask midpoint and never presents a stale last trade as current probability", async () => {
    const clock = new ManualClock();
    const { store } = await setup({ clock, staleAfterMs: 1_000 });

    await store.appendTick(
      tick("red", {
        bid: 0.45,
        ask: 0.55,
        lastTrade: 0.9,
      }),
    );
    expect(store.getLatest(BOUT_ID)[0]).toMatchObject({
      midpoint: 0.5,
      impliedProbability: 0.5,
    });

    await store.appendTick(
      tick("blue", {
        bid: undefined,
        ask: undefined,
        lastTrade: 0.4,
      }),
    );
    clock.value += 1_001;
    const staleTrade = store
      .getLatest(BOUT_ID)
      .find(({ outcome }) => outcome === "blue");
    expect(staleTrade).toMatchObject({
      lastTrade: 0.4,
      stale: true,
      fresh: false,
    });
    expect(staleTrade).not.toHaveProperty("impliedProbability");
    await store.close();
  });

  it("retains the last tradable Kalshi quote across a closed 0/100 ticker", async () => {
    const { store } = await setup();
    await store.appendTick(
      tick("Uroš Medić", {
        source: "kalshi",
        bid: 99,
        ask: 100,
        lastTrade: 99,
      }),
    );
    await store.appendTick(
      tick("Uroš Medić", {
        source: "kalshi",
        bid: 0,
        ask: 100,
        lastTrade: 99,
        impliedProbability: 0.5,
        sourceUpdatedAt: at(1_000),
        receivedAt: at(1_100),
      }),
    );

    expect(store.getLatest(BOUT_ID, "kalshi")[0]).toMatchObject({
      bid: 99,
      ask: 100,
      midpoint: 99.5,
      impliedProbability: 0.995,
      lastTrade: 99,
    });
    await store.close();
  });

  it("keeps an out-of-order tick in history without overwriting newer source state", async () => {
    const { store } = await setup();
    await store.appendTick(
      tick("red", {
        bid: 0.65,
        ask: 0.67,
        sourceUpdatedAt: at(5_000),
        receivedAt: at(5_100),
      }),
    );
    await store.appendTick(
      tick("red", {
        bid: 0.5,
        ask: 0.52,
        sourceUpdatedAt: at(2_000),
        receivedAt: at(6_000),
      }),
    );

    await expect(store.getTickHistory(BOUT_ID)).resolves.toHaveLength(2);
    expect(store.getLatest(BOUT_ID)[0]).toMatchObject({
      bid: 0.65,
      ask: 0.67,
      sourceUpdatedAt: at(5_000),
    });
    await store.close();
  });

  it("stays stale after disconnect updates until a completed rebuild is marked fresh", async () => {
    const { store } = await setup();
    await store.appendTick(tick("red"));
    await store.markStale("polymarket");
    expect(store.getLatest(BOUT_ID)[0]).toMatchObject({
      fresh: false,
      stale: true,
    });

    await store.appendTick(
      tick("red", {
        bid: 0.61,
        ask: 0.63,
        sourceUpdatedAt: at(1_000),
        receivedAt: at(1_000),
      }),
    );
    expect(store.getLatest(BOUT_ID)[0]?.fresh).toBe(false);

    await store.markFresh("polymarket");
    expect(store.getLatest(BOUT_ID)[0]).toMatchObject({
      fresh: true,
      stale: false,
      midpoint: 0.62,
    });
    await store.close();
  });

  it("computes no-vig probabilities only for a valid fresh pair", async () => {
    const { store } = await setup();
    await store.appendTick(
      tick("red", { noVigProbability: 0.99 }),
    );
    expect(store.getLatest(BOUT_ID)[0]).not.toHaveProperty(
      "noVigProbability",
    );

    await store.appendTick(tick("blue"));
    const latest = store.getLatest(BOUT_ID);
    const probabilities = latest.map(
      ({ noVigProbability }) => noVigProbability ?? 0,
    );
    expect(probabilities[0]! + probabilities[1]!).toBeCloseTo(1);
    await store.close();
  });

  it("creates provisional and confirmed snapshots from history at each corrected boundary", async () => {
    const onSnapshot = vi.fn(async () => undefined);
    const { bus, storage, store } = await setup({ onSnapshot });
    await store.appendTick(tick("red"));
    await store.appendTick(tick("blue"));
    await store.appendTick(
      tick("red", {
        bid: 0.63,
        ask: 0.65,
        sourceUpdatedAt: at(12_000),
        receivedAt: at(12_000),
      }),
    );

    bus.emit({
      type: "PROVISIONAL_ROUND_ENDED",
      boutId: BOUT_ID,
      round: 1,
      detectedAt: at(10_000),
    });
    await store.idle();
    expect(store.getSnapshots(BOUT_ID, 1)[0]).toMatchObject({
      boundaryType: "provisional",
      takenAt: at(10_000),
      outcomes: expect.arrayContaining([
        expect.objectContaining({ outcome: "red", midpoint: 0.59 }),
      ]),
    });

    bus.emit({
      type: "ROUND_ENDED",
      boutId: BOUT_ID,
      round: 1,
      detectedAt: at(15_000),
      confirmation: "period_transition",
    });
    await store.idle();

    expect(store.getSnapshots(BOUT_ID, 1)).toEqual([
      expect.objectContaining({
        boundaryType: "confirmed",
        takenAt: at(15_000),
        outcomes: expect.arrayContaining([
          expect.objectContaining({ outcome: "red", midpoint: 0.64 }),
        ]),
      }),
      expect.objectContaining({
        boundaryType: "provisional",
        takenAt: at(15_000),
      }),
    ]);
    await expect(
      storage.read(MARKET_SNAPSHOTS_STORAGE_STREAM),
    ).resolves.toHaveLength(2);
    expect(onSnapshot).toHaveBeenCalledTimes(3);

    bus.emit({
      type: "ROUND_ENDED",
      boutId: BOUT_ID,
      round: 1,
      detectedAt: at(15_000),
      confirmation: "period_transition",
    });
    await store.idle();
    expect(onSnapshot).toHaveBeenCalledTimes(3);
    await store.close();
  });

  it("pins a pre-fight opening book at reserved round zero without creating a round boundary", async () => {
    const { store, storage } = await setup();
    await store.appendTick(tick("red"));
    await store.appendTick(tick("blue"));

    await store.snapshotPreFight(BOUT_ID, at(5_000));

    expect(store.getSnapshots(BOUT_ID)).toEqual([
      expect.objectContaining({
        boutId: BOUT_ID,
        round: 0,
        boundaryType: "pre-fight",
        label: "pre-fight-open",
        takenAt: at(5_000),
      }),
    ]);
    expect(store.getSnapshots(BOUT_ID, 1)).toEqual([]);
    await store.close();

    const restored = await setup({ storage });
    expect(restored.store.getSnapshots(BOUT_ID)).toEqual([
      expect.objectContaining({
        round: 0,
        boundaryType: "pre-fight",
        label: "pre-fight-open",
      }),
    ]);
    await restored.store.close();
  });

  it("removes a superseded provisional and replaces it at the corrected boundary without duplicates", async () => {
    const { bus, storage, store } = await setup();
    await store.appendTick(tick("red"));
    await store.appendTick(tick("blue"));
    bus.emit({
      type: "PROVISIONAL_ROUND_ENDED",
      boutId: BOUT_ID,
      round: 1,
      detectedAt: at(5_000),
    });
    await store.idle();

    await store.handleProvisionalSupersession({
      boutId: BOUT_ID,
      round: 1,
      provisionalDetectedAt: at(5_000),
      supersededAt: at(7_000),
      source: "espn",
    });
    expect(store.getSnapshots(BOUT_ID, 1)).toEqual([]);

    await store.appendTick(
      tick("red", {
        bid: 0.66,
        ask: 0.68,
        sourceUpdatedAt: at(8_000),
        receivedAt: at(8_000),
      }),
    );
    bus.emit({
      type: "PROVISIONAL_ROUND_ENDED",
      boutId: BOUT_ID,
      round: 1,
      detectedAt: at(10_000),
    });
    await store.idle();

    expect(store.getSnapshots(BOUT_ID, 1)).toEqual([
      expect.objectContaining({
        boundaryType: "provisional",
        takenAt: at(10_000),
        outcomes: expect.arrayContaining([
          expect.objectContaining({ outcome: "red", midpoint: 0.67 }),
        ]),
      }),
    ]);
    await expect(
      storage.read(MARKET_SNAPSHOTS_STORAGE_STREAM),
    ).resolves.toHaveLength(1);
    await store.close();
  });

  it("restores tick history, latest state, freshness, and unique snapshots after restart", async () => {
    const storage = new MemoryStorage();
    const first = await setup({ storage });
    await first.store.appendTick(tick("red"));
    await first.store.appendTick(tick("blue"));
    first.bus.emit({
      type: "PROVISIONAL_ROUND_ENDED",
      boutId: BOUT_ID,
      round: 1,
      detectedAt: at(5_000),
    });
    await first.store.idle();
    await first.store.markStale("polymarket", at(6_000));
    await first.store.close();

    const restoredClock = new ManualClock();
    restoredClock.value = BASE_TIME + 6_000;
    const restored = await setup({ storage, clock: restoredClock });
    await expect(
      restored.store.getTickHistory(BOUT_ID),
    ).resolves.toHaveLength(2);
    expect(restored.store.getLatest(BOUT_ID)).toHaveLength(2);
    expect(restored.store.getLatest(BOUT_ID)[0]?.fresh).toBe(false);
    expect(restored.store.getSnapshots(BOUT_ID, 1)).toHaveLength(1);
    await restored.store.close();
  });

  it("replays the multi-tick exchange fixtures across a round boundary", async () => {
    const { store } = await setup();
    const ticks = [
      ...(kalshiFixture.ticks as MarketTick[]),
      ...(polymarketFixture.ticks as MarketTick[]),
    ];
    for (const fixtureTick of ticks) {
      await store.appendTick(fixtureTick);
    }

    const snapshots = await store.recomputeBoundary(
      BOUT_ID,
      1,
      "confirmed",
      "2026-07-26T02:40:30Z",
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "kalshi",
          outcomes: expect.arrayContaining([
            expect.objectContaining({
              outcome: "Danilo Reyes",
              midpoint: 60.5,
            }),
          ]),
        }),
        expect.objectContaining({
          source: "polymarket",
          outcomes: expect.arrayContaining([
            expect.objectContaining({
              outcome: "Danilo Reyes",
              midpoint: 0.62,
            }),
          ]),
        }),
      ]),
    );
    // A "confirmed" boundary prunes down to, per key, everything strictly
    // after "2026-07-26T02:40:30Z" plus the single latest tick at or before
    // it (see snapshotBoundary in tickStore.ts): for each of the two
    // outcomes on each source, that's the :40:29/:40:28 tick (superseding
    // the earlier :39:51/:39:53 one) plus the :40:36/:40:38 tick after —
    // 2 keys x 2 sources x 2 survivors = 8 of the twelve total.
    await expect(store.getTickHistory(BOUT_ID)).resolves.toHaveLength(8);
    await store.close();
  });

  it("prunes superseded ticks at a confirmed round boundary but keeps one carry-forward anchor per key", async () => {
    const { bus, store, storage } = await setup();

    // Two ticks for "red", both before the boundary — only the later one
    // should survive as red's carry-forward anchor.
    await store.appendTick(
      tick("red", { receivedAt: at(1_000), sourceUpdatedAt: at(1_000) }),
    );
    await store.appendTick(
      tick("red", { receivedAt: at(2_000), sourceUpdatedAt: at(2_000) }),
    );
    // "blue" never ticks again before the boundary or after — a market
    // gone quiet must still carry forward its last known price, not vanish.
    await store.appendTick(
      tick("blue", { receivedAt: at(1_500), sourceUpdatedAt: at(1_500) }),
    );
    bus.emit({
      type: "PROVISIONAL_ROUND_ENDED",
      boutId: BOUT_ID,
      round: 1,
      detectedAt: at(2_500),
    });
    await store.idle();
    // Provisional boundaries can still be superseded, so nothing is pruned.
    await expect(store.getTickHistory(BOUT_ID)).resolves.toHaveLength(3);

    bus.emit({
      type: "ROUND_ENDED",
      boutId: BOUT_ID,
      round: 1,
      detectedAt: at(4_000),
      confirmation: "period_transition",
    });
    await store.idle();

    // red@1_000 is superseded by red@2_000 and dropped; red@2_000 and
    // blue@1_500 both survive as their key's carry-forward anchor.
    const remaining = await store.getTickHistory(BOUT_ID);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((t) => t.receivedAt).sort()).toEqual(
      [at(1_500), at(2_000)].sort(),
    );
    await expect(
      storage.read(MARKET_TICKS_STORAGE_STREAM),
    ).resolves.toHaveLength(2);

    // A tick after the confirmed boundary survives normally, alongside the
    // still-carried-forward anchors.
    await store.appendTick(
      tick("red", { receivedAt: at(5_000), sourceUpdatedAt: at(5_000) }),
    );
    await expect(store.getTickHistory(BOUT_ID)).resolves.toHaveLength(3);
    await store.close();
  });
});
