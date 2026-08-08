import { describe, expect, it } from "vitest";
import fixture from "../src/fixtures/polymarketTicks.json" with {
  type: "json",
};
import { CollectorEventBus } from "./eventBus.ts";
import type {
  MarketSocket,
  MarketSubscription,
  MarketTransportTimer,
} from "./marketTransport.ts";
import {
  createPolymarketRestBookFetcher,
  normalizePolymarketMessage,
  POLYMARKET_PING_INTERVAL_MS,
  polymarketSubscriptionMessage,
  PolymarketFixtureTransport,
  startPolymarketPingLoop,
} from "./polymarketTransport.ts";
import { MemoryStorage } from "./storage.ts";
import { MarketTickStore } from "./tickStore.ts";

const RECEIVED_AT = "2026-07-26T02:40:29.500Z";
const TOKEN =
  "10488201673418507703957484917278688764049206352911886332818699846300512815635";
const SUBSCRIPTION: MarketSubscription = {
  source: "polymarket",
  boutId: "bout-main",
  externalId: TOKEN,
  marketType: "fight-winner",
  outcome: "Danilo Reyes",
};

class ManualTimer implements MarketTransportTimer {
  readonly pending: Array<{
    callback: () => void;
    delayMs: number;
    active: boolean;
  }> = [];

  setTimeout(callback: () => void, delayMs: number): unknown {
    const entry = { callback, delayMs, active: true };
    this.pending.push(entry);
    return entry;
  }

  clearTimeout(handle: unknown): void {
    (handle as { active: boolean }).active = false;
  }

  runNext(): void {
    const next = this.pending.find(({ active }) => active);
    if (next === undefined) throw new Error("No timer is pending");
    next.active = false;
    next.callback();
  }
}

class MockSocket implements MarketSocket {
  readyState = 0;

  readonly sent: string[] = [];

  private openListeners = new Set<() => void>();

  private messageListeners = new Set<(data: unknown) => void>();

  private closeListeners = new Set<(reason?: string) => void>();

  private errorListeners = new Set<(error: Error) => void>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  onMessage(listener: (data: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (reason?: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    for (const listener of this.openListeners) listener();
  }
}

describe("normalizePolymarketMessage", () => {
  it("builds public subscriptions from outcome token ids", () => {
    expect(
      JSON.parse(polymarketSubscriptionMessage([SUBSCRIPTION])),
    ).toEqual({
      assets_ids: [TOKEN],
      type: "market",
      custom_feature_enabled: true,
    });
  });

  it("normalizes book snapshots and price deltas", () => {
    expect(
      normalizePolymarketMessage(
        fixture.sampleMessages.book,
        [SUBSCRIPTION],
        RECEIVED_AT,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "snapshot",
        ticks: [
          expect.objectContaining({
            bid: 0.59,
            ask: 0.61,
            impliedProbability: 0.6,
            depth: { bids: [0.59, 0.57], asks: [0.61, 0.63] },
            sourceUpdatedAt: "2026-07-26T02:40:28.000Z",
          }),
        ],
      }),
    ]);

    expect(
      normalizePolymarketMessage(
        fixture.sampleMessages.priceChange,
        [SUBSCRIPTION],
        RECEIVED_AT,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "delta",
        ticks: [
          expect.objectContaining({
            bid: 0.6,
            ask: 0.62,
            impliedProbability: 0.61,
          }),
        ],
      }),
    ]);
  });

  it("normalizes best prices, trades, tick-size, and lifecycle events", () => {
    const samples = fixture.sampleMessages;
    expect(
      normalizePolymarketMessage(
        samples.bestBidAsk,
        [SUBSCRIPTION],
        RECEIVED_AT,
      )[0],
    ).toMatchObject({
      kind: "delta",
      ticks: [{ bid: 0.61, ask: 0.63 }],
    });
    expect(
      normalizePolymarketMessage(
        samples.lastTradePrice,
        [SUBSCRIPTION],
        RECEIVED_AT,
      )[0],
    ).toMatchObject({
      kind: "delta",
      ticks: [{ lastTrade: 0.625 }],
    });
    expect(
      normalizePolymarketMessage(
        samples.tickSizeChange,
        [SUBSCRIPTION],
        RECEIVED_AT,
      )[0],
    ).toMatchObject({
      kind: "delta",
      ticks: [{ tickSize: 0.001 }],
    });
    expect(
      normalizePolymarketMessage(
        samples.lifecycle,
        [SUBSCRIPTION],
        RECEIVED_AT,
      )[0],
    ).toMatchObject({
      kind: "lifecycle",
      ticks: [{ status: "resolved", bid: 1, ask: 1, impliedProbability: 1 }],
    });
  });

  it("prices a resolved market at the true 100/0 outcome, not the last bid/ask midpoint", () => {
    const samples = fixture.sampleMessages;
    const winningSubscription: MarketSubscription = SUBSCRIPTION;
    const losingSubscription: MarketSubscription = {
      ...SUBSCRIPTION,
      externalId: "some-other-losing-token-id",
      outcome: "Some Other Fighter",
    };
    const losingResolvedMessage = {
      ...(samples.lifecycle as Record<string, unknown>),
      asset_id: losingSubscription.externalId,
    };

    // The winning side's own token resolves to a true 1.0 (100%) — not
    // whatever the last bid/ask midpoint happened to be before resolution.
    expect(
      normalizePolymarketMessage(
        samples.lifecycle,
        [winningSubscription, losingSubscription],
        RECEIVED_AT,
      )[0],
    ).toMatchObject({
      kind: "lifecycle",
      ticks: [{ bid: 1, ask: 1, impliedProbability: 1 }],
    });

    // The losing side's token resolves to a true 0.0 (0%).
    expect(
      normalizePolymarketMessage(
        losingResolvedMessage,
        [winningSubscription, losingSubscription],
        RECEIVED_AT,
      )[0],
    ).toMatchObject({
      kind: "lifecycle",
      ticks: [{ bid: 0, ask: 0, impliedProbability: 0 }],
    });
  });
});

describe("Polymarket transports", () => {
  it("sends text PING every ten seconds with injected timers", async () => {
    const socket = new MockSocket();
    const timer = new ManualTimer();
    socket.open();
    const stop = startPolymarketPingLoop(socket, timer);
    expect(timer.pending.at(-1)?.delayMs).toBe(
      POLYMARKET_PING_INTERVAL_MS,
    );

    timer.runNext();
    expect(socket.sent.at(-1)).toBe("PING");
    expect(timer.pending.at(-1)?.delayMs).toBe(
      POLYMARKET_PING_INTERVAL_MS,
    );
    stop();
  });

  it("replays into boundary snapshots without opening a socket", async () => {
    const eventBus = new CollectorEventBus();
    const store = await MarketTickStore.create({
      eventBus,
      storage: new MemoryStorage(),
      clock: { now: () => Date.parse("2026-07-26T02:40:40Z") },
      staleAfterMs: 60_000,
    });
    const transport = new PolymarketFixtureTransport({
      tickStore: store,
      subscriptions: [SUBSCRIPTION],
    });

    await transport.replay();
    eventBus.emit({
      type: "PROVISIONAL_ROUND_ENDED",
      boutId: "bout-main",
      round: 2,
      detectedAt: "2026-07-26T02:40:30Z",
    });
    await store.idle();
    expect(store.getSnapshots("bout-main", 2)).toEqual([
      expect.objectContaining({
        source: "polymarket",
        boundaryType: "provisional",
        fresh: true,
      }),
    ]);
    await transport.disconnect();
    await store.close();
  });
});

describe("Polymarket REST metadata", () => {
  it("uses Gamma cumulative volume instead of websocket trade size", async () => {
    const fetcher = createPolymarketRestBookFetcher({
      clock: { now: () => Date.parse(RECEIVED_AT) },
      fetchImpl: async (url) => {
        if (String(url).startsWith("https://gamma.test")) {
          return new Response(JSON.stringify([{ volume: "384153.8023580001" }]));
        }
        return new Response(JSON.stringify({
          bids: [{ price: "0.59", size: "10" }],
          asks: [{ price: "0.61", size: "10" }],
        }));
      },
      baseUrl: "https://clob.test",
      gammaBaseUrl: "https://gamma.test",
    });

    const ticks = await fetcher([{ ...SUBSCRIPTION, marketId: "0xcondition" }]);
    expect(ticks).toEqual([
      expect.objectContaining({ bid: 0.59, ask: 0.61, volume: 384153.8023580001 }),
    ]);
  });
});
