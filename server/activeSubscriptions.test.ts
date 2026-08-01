/**
 * The streams follow the fight: Kalshi and Polymarket subscribe only to the
 * bout ESPN says is live, and go back to the full mapped set once it ends.
 *
 * The behaviour worth pinning down is what happens on the wire when the set
 * changes — a narrowed set that never re-subscribes, or a widened set whose
 * new market applies deltas to a book that was never rebuilt, would both look
 * fine in the collector and be wrong in the tick store.
 */

import { describe, expect, it, vi } from "vitest";

import {
  SupervisedMarketTransport,
  type MarketSocket,
  type MarketSubscription,
  type MarketTransportTimer,
  type NormalizedTransportMessage,
} from "./marketTransport.ts";
import type { MarketTick } from "../src/sources/contract.ts";
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

  closedWith: string | undefined;

  private openListeners = new Set<() => void>();

  private messageListeners = new Set<(data: unknown) => void>();

  private closeListeners = new Set<(reason?: string) => void>();

  private errorListeners = new Set<(error: Error) => void>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(_code?: number, reason?: string): void {
    this.readyState = 3;
    this.closedWith = reason;
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
    for (const listener of this.closeListeners) listener("network disconnected");
  }
}

function subscription(
  boutId: string,
  externalId: string,
  outcome: string,
): MarketSubscription {
  return {
    source: "kalshi",
    boutId,
    externalId,
    marketType: "fight-winner",
    outcome,
  };
}

const MAIN: MarketSubscription[] = [
  subscription("bout-main", "KX-MAIN-RED", "Islam Makhachev"),
  subscription("bout-main", "KX-MAIN-BLUE", "Ian Machado Garry"),
];
const CO_MAIN: MarketSubscription[] = [
  subscription("bout-co", "KX-CO-RED", "Mackenzie Dern"),
  subscription("bout-co", "KX-CO-BLUE", "Gillian Robertson"),
];
const ALL = [...MAIN, ...CO_MAIN];

function tick(externalId: string, bid: number): MarketTick {
  return {
    source: "kalshi",
    boutId: "bout-main",
    marketType: "fight-winner",
    outcome: externalId,
    bid,
    receivedAt: "2026-08-15T21:10:00.000Z",
    stale: false,
  };
}

function harness() {
  const timer = new ManualTimer();
  const sockets: MockSocket[] = [];
  const ingested: string[] = [];
  const store = {
    ingest: vi.fn(async (marketTick: MarketTick) => {
      ingested.push(`${marketTick.outcome}:${marketTick.bid ?? "none"}`);
      return {};
    }),
    markFresh: vi.fn(async () => undefined),
    markStale: vi.fn(async () => undefined),
  } as unknown as Pick<MarketTickStore, "ingest" | "markFresh" | "markStale">;

  const transport = new SupervisedMarketTransport({
    source: "kalshi",
    tickStore: store,
    subscriptions: ALL,
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    subscribe: (socket, subscriptions) =>
      socket.send(
        subscriptions.map(({ externalId }) => externalId).join(","),
      ),
    normalize: (raw) => raw as NormalizedTransportMessage,
    timer,
    random: () => 0,
    reconnect: { baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0 },
  });

  return { transport, sockets, timer, ingested };
}

describe("lifecycle-gated stream subscriptions", () => {
  it("re-subscribes on the wire when the active bout narrows the set", async () => {
    const { transport, sockets } = harness();

    await transport.connect();
    sockets[0]?.open();
    await transport.idle();
    expect(sockets[0]?.sent).toEqual([
      "KX-MAIN-RED,KX-MAIN-BLUE,KX-CO-RED,KX-CO-BLUE",
    ]);

    // ESPN says the main event started.
    transport.setSubscriptions(MAIN);
    await transport.idle();

    expect(sockets[0]?.closedWith).toBe("subscription change");
    expect(sockets[1]).toBeDefined();
    sockets[1]?.open();
    await transport.idle();
    expect(sockets[1]?.sent).toEqual(["KX-MAIN-RED,KX-MAIN-BLUE"]);

    await transport.disconnect();
  });

  it("leaves a healthy stream alone when the set has not changed", async () => {
    const { transport, sockets } = harness();

    await transport.connect();
    sockets[0]?.open();
    await transport.idle();

    // Same set, different order — not a change.
    transport.setSubscriptions([...ALL].reverse());
    await transport.idle();

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.closedWith).toBeUndefined();

    await transport.disconnect();
  });

  it("rebuilds from a snapshot before applying deltas to a widened set", async () => {
    const { transport, sockets, ingested } = harness();

    await transport.connect();
    sockets[0]?.open();
    await transport.idle();

    transport.setSubscriptions(MAIN);
    await transport.idle();
    sockets[1]?.open();
    await transport.idle();

    // The fight ended; the full mapped set comes back.
    transport.setSubscriptions(ALL);
    await transport.idle();
    sockets[2]?.open();
    await transport.idle();

    // A delta for the newly restored market arrives before its snapshot and
    // must be buffered, not ingested against a book that was never rebuilt.
    sockets[2]?.message({
      kind: "delta",
      subscriptionId: "KX-CO-RED",
      ticks: [tick("KX-CO-RED", 0.4)],
    });
    await transport.idle();
    expect(ingested).toEqual([]);

    sockets[2]?.message({
      kind: "snapshot",
      subscriptionId: "KX-CO-RED",
      ticks: [tick("KX-CO-RED", 0.41)],
    });
    await transport.idle();
    expect(ingested).toEqual(["KX-CO-RED:0.41", "KX-CO-RED:0.4"]);

    await transport.disconnect();
  });

  it("drops ticks for a market that is no longer subscribed", async () => {
    const { transport, sockets, ingested } = harness();

    await transport.connect();
    sockets[0]?.open();
    await transport.idle();

    transport.setSubscriptions(MAIN);
    await transport.idle();
    sockets[1]?.open();
    await transport.idle();

    sockets[1]?.message({
      kind: "snapshot",
      subscriptionId: "KX-CO-RED",
      ticks: [tick("KX-CO-RED", 0.4)],
    });
    await transport.idle();

    expect(ingested).toEqual([]);
    await transport.disconnect();
  });

  it("recovers the narrowed set after an unexpected disconnect", async () => {
    const { transport, sockets, timer, ingested } = harness();

    await transport.connect();
    sockets[0]?.open();
    await transport.idle();

    transport.setSubscriptions(MAIN);
    await transport.idle();
    sockets[1]?.open();
    await transport.idle();

    sockets[1]?.remoteClose();
    await transport.idle();
    timer.runNext();
    await transport.idle();

    sockets[2]?.open();
    await transport.idle();
    // Reconnect restores the narrowed set, not the original full one.
    expect(sockets[2]?.sent).toEqual(["KX-MAIN-RED,KX-MAIN-BLUE"]);

    // And the rebuild protocol still applies after the reconnect.
    sockets[2]?.message({
      kind: "delta",
      subscriptionId: "KX-MAIN-RED",
      ticks: [tick("KX-MAIN-RED", 0.68)],
    });
    await transport.idle();
    expect(ingested).toEqual([]);

    sockets[2]?.message({
      kind: "snapshot",
      subscriptionId: "KX-MAIN-RED",
      ticks: [tick("KX-MAIN-RED", 0.69)],
    });
    await transport.idle();
    expect(ingested).toEqual(["KX-MAIN-RED:0.69", "KX-MAIN-RED:0.68"]);

    await transport.disconnect();
  });
});
