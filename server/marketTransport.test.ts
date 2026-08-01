import { describe, expect, it, vi } from "vitest";
import type { MarketTick } from "../src/sources/contract.ts";
import {
  reconnectDelay,
  resolveMarketSubscriptions,
  type MarketSocket,
  type MarketSubscription,
  type MarketTransportTimer,
  type NormalizedTransportMessage,
  SupervisedMarketTransport,
  TerminalTransportError,
} from "./marketTransport.ts";
import type { BoutMapping } from "./mapping.ts";
import type { MarketTickStore } from "./tickStore.ts";

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

  message(value: NormalizedTransportMessage): void {
    for (const listener of this.messageListeners) listener(value);
  }

  remoteClose(): void {
    this.readyState = 3;
    for (const listener of this.closeListeners) {
      listener("network disconnected");
    }
  }
}

const SUBSCRIPTIONS: readonly MarketSubscription[] = [
  {
    source: "polymarket",
    boutId: "bout-main",
    externalId: "token-red",
    marketType: "fight-winner",
    outcome: "Red Fighter",
  },
  {
    source: "polymarket",
    boutId: "bout-main",
    externalId: "token-blue",
    marketType: "fight-winner",
    outcome: "Blue Fighter",
  },
];

function tick(
  subscription: MarketSubscription,
  sourceUpdatedAt: string,
  bid: number,
): MarketTick {
  return {
    source: "polymarket",
    boutId: subscription.boutId,
    marketType: subscription.marketType,
    outcome: subscription.outcome,
    bid,
    ask: bid + 0.02,
    sourceUpdatedAt,
    receivedAt: sourceUpdatedAt,
    stale: false,
  };
}

describe("market transport subscription seam", () => {
  it("resolves stream identifiers only from mapping externalRefs", () => {
    const mapping: BoutMapping = {
      internalBoutId: "bout-main",
      redFighter: "Red Fighter",
      blueFighter: "Blue Fighter",
      weightClass: "lightweight",
      scheduledRounds: 5,
      mappingConfidence: 1,
      manuallyVerified: true,
      externalRefs: [
        { source: "polymarket", id: "0xcondition" },
        { source: "polymarket", id: "token-red" },
        { source: "polymarket", id: "token-blue" },
      ],
    };

    expect(resolveMarketSubscriptions([mapping], "polymarket")).toEqual(
      SUBSCRIPTIONS,
    );
  });
});

describe("SupervisedMarketTransport", () => {
  it("resubscribes, enforces snapshot-before-deltas, then marks fresh", async () => {
    const timer = new ManualTimer();
    const sockets = [new MockSocket(), new MockSocket()];
    const calls: string[] = [];
    const store = {
      ingest: vi.fn(async (marketTick: MarketTick) => {
        calls.push(
          `tick:${marketTick.outcome}:${marketTick.bid ?? "none"}`,
        );
        return {};
      }),
      markFresh: vi.fn(async () => {
        calls.push("fresh");
      }),
      markStale: vi.fn(async () => {
        calls.push("stale");
      }),
    } as unknown as Pick<
      MarketTickStore,
      "ingest" | "markFresh" | "markStale"
    >;
    let socketIndex = 0;
    const transport = new SupervisedMarketTransport({
      source: "polymarket",
      tickStore: store,
      subscriptions: SUBSCRIPTIONS,
      socketFactory: () => sockets[socketIndex++]!,
      subscribe: (socket) => socket.send("SUBSCRIBE"),
      normalize: (raw) => raw as NormalizedTransportMessage,
      timer,
      random: () => 0,
      reconnect: {
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        jitterRatio: 0.2,
      },
    });

    await transport.connect();
    sockets[0]!.open();
    await transport.idle();
    expect(sockets[0]!.sent).toEqual(["SUBSCRIBE"]);
    const ready = transport.waitUntilReady(1_000);

    sockets[0]!.message({
      kind: "delta",
      subscriptionId: "token-red",
      ticks: [
        tick(
          SUBSCRIPTIONS[0]!,
          "2026-07-26T02:40:30Z",
          0.61,
        ),
      ],
    });
    sockets[0]!.message({
      kind: "snapshot",
      subscriptionId: "token-red",
      ticks: [
        tick(
          SUBSCRIPTIONS[0]!,
          "2026-07-26T02:40:29Z",
          0.59,
        ),
      ],
    });
    await transport.idle();
    expect(calls.slice(-2)).toEqual([
      "tick:Red Fighter:0.59",
      "tick:Red Fighter:0.61",
    ]);
    expect(calls).not.toContain("fresh");

    sockets[0]!.message({
      kind: "snapshot",
      subscriptionId: "token-blue",
      ticks: [
        tick(
          SUBSCRIPTIONS[1]!,
          "2026-07-26T02:40:29Z",
          0.39,
        ),
      ],
    });
    await transport.idle();
    expect(calls.at(-1)).toBe("fresh");
    await expect(ready).resolves.toBe(true);

    sockets[0]!.remoteClose();
    expect(store.markStale).toHaveBeenCalled();
    await transport.idle();
    expect(timer.pending.at(-1)?.delayMs).toBe(80);
    timer.runNext();
    await Promise.resolve();
    sockets[1]!.open();
    await transport.idle();
    expect(sockets[1]!.sent).toEqual(["SUBSCRIBE"]);
    await transport.disconnect();
  });

  it("keeps out-of-order post-snapshot deltas in history without replacing newer state", async () => {
    const { CollectorEventBus } = await import("./eventBus.ts");
    const { MemoryStorage } = await import("./storage.ts");
    const { MarketTickStore } = await import("./tickStore.ts");
    const store = await MarketTickStore.create({
      eventBus: new CollectorEventBus(),
      storage: new MemoryStorage(),
      clock: { now: () => Date.parse("2026-07-26T02:40:40Z") },
      staleAfterMs: 60_000,
    });
    const socket = new MockSocket();
    const transport = new SupervisedMarketTransport({
      source: "polymarket",
      tickStore: store,
      subscriptions: [SUBSCRIPTIONS[0]!],
      socketFactory: () => socket,
      subscribe: () => undefined,
      normalize: (raw) => raw as NormalizedTransportMessage,
    });

    await transport.connect();
    socket.open();
    socket.message({
      kind: "snapshot",
      subscriptionId: "token-red",
      ticks: [
        tick(
          SUBSCRIPTIONS[0]!,
          "2026-07-26T02:40:30Z",
          0.62,
        ),
      ],
    });
    socket.message({
      kind: "delta",
      subscriptionId: "token-red",
      ticks: [
        tick(
          SUBSCRIPTIONS[0]!,
          "2026-07-26T02:40:20Z",
          0.5,
        ),
      ],
    });
    await transport.idle();

    await expect(
      store.getTickHistory("bout-main", "polymarket"),
    ).resolves.toHaveLength(2);
    expect(store.getLatest("bout-main", "polymarket")[0]).toMatchObject({
      bid: 0.62,
      ask: 0.64,
    });
    await transport.disconnect();
    await store.close();
  });

  it("uses jittered exponential bounds with a fake timer", () => {
    const policy = {
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0.2,
    };
    expect(reconnectDelay(0, 0, policy)).toBe(80);
    expect(reconnectDelay(0, 1, policy)).toBe(120);
    expect(reconnectDelay(3, 0, policy)).toBe(640);
    expect(reconnectDelay(3, 1, policy)).toBe(960);
    expect(reconnectDelay(8, 0, policy)).toBe(800);
    expect(reconnectDelay(8, 1, policy)).toBe(1_200);
  });

  it("does not retry terminal authentication failures", async () => {
    const timer = new ManualTimer();
    const store = {
      ingest: async () => ({}),
      markFresh: async () => undefined,
      markStale: async () => undefined,
    } as unknown as Pick<
      MarketTickStore,
      "ingest" | "markFresh" | "markStale"
    >;
    const transport = new SupervisedMarketTransport({
      source: "kalshi",
      tickStore: store,
      subscriptions: [],
      socketFactory: () => {
        throw new TerminalTransportError(
          "Kalshi WebSocket authentication failed",
        );
      },
      subscribe: () => undefined,
      normalize: () => null,
      timer,
    });

    await transport.connect();
    expect(timer.pending).toEqual([]);
    await transport.disconnect();
  });
});
