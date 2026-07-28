import fixture from "../src/fixtures/polymarketTicks.json" with {
  type: "json",
};
import type { MarketTick } from "../src/sources/contract.ts";
import type { CollectorConfig } from "./config.ts";
import {
  adaptWebSocket,
  FixtureReplayTransport,
  type MarketSocket,
  type MarketSocketFactory,
  type MarketSubscription,
  type MarketTransport,
  type MarketTransportClock,
  type MarketTransportTimer,
  type NormalizedTransportMessage,
  type ReconnectPolicy,
  SupervisedMarketTransport,
} from "./marketTransport.ts";
import type { MarketTickStore } from "./tickStore.ts";
import type { Metrics } from "./health.ts";
import type { ParserErrorSink } from "./review.ts";

const POLYMARKET_SOCKET_URL =
  "wss://ws-subscriptions-clob.polymarket.com/ws/market";
export const POLYMARKET_PING_INTERVAL_MS = 10_000;

interface PolymarketLiveTransportOptions {
  tickStore: Pick<
    MarketTickStore,
    "ingest" | "markFresh" | "markStale"
  >;
  subscriptions: readonly MarketSubscription[];
  socketFactory?: MarketSocketFactory;
  clock?: MarketTransportClock;
  timer?: MarketTransportTimer;
  random?: () => number;
  reconnect?: Partial<ReconnectPolicy>;
  metrics?: Metrics;
  review?: ParserErrorSink;
}

export function startPolymarketPingLoop(
  socket: Pick<MarketSocket, "readyState" | "send">,
  timer: MarketTransportTimer,
): () => void {
  let active = true;
  let handle: unknown;
  const schedule = (): void => {
    handle = timer.setTimeout(() => {
      if (!active) return;
      if (socket.readyState === 1) socket.send("PING");
      schedule();
    }, POLYMARKET_PING_INTERVAL_MS);
  };
  schedule();
  return () => {
    active = false;
    if (handle !== undefined) timer.clearTimeout(handle);
  };
}

export function polymarketSubscriptionMessage(
  subscriptions: readonly MarketSubscription[],
): string {
  return JSON.stringify({
    assets_ids: subscriptions.map(({ externalId }) => externalId),
    type: "market",
    custom_feature_enabled: true,
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function finite(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" || typeof value === "string"
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRaw(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function sourceTimestamp(
  message: Record<string, unknown>,
  receivedAt: string,
): string {
  const raw = finite(message.timestamp);
  if (raw === undefined) return receivedAt;
  const milliseconds = raw < 10_000_000_000 ? raw * 1_000 : raw;
  return new Date(milliseconds).toISOString();
}

function subscriptionFor(
  subscriptions: readonly MarketSubscription[],
  externalId: unknown,
): MarketSubscription | undefined {
  return typeof externalId === "string"
    ? subscriptions.find(
        (subscription) => subscription.externalId === externalId,
      )
    : undefined;
}

function depthPrices(
  levels: unknown,
  direction: "ascending" | "descending",
): number[] {
  if (!Array.isArray(levels)) return [];
  return levels
    .flatMap((level) => {
      const parsed = record(level);
      const price = finite(parsed?.price);
      const size = finite(parsed?.size);
      return price === undefined || size === undefined || size <= 0
        ? []
        : [price];
    })
    .sort((left, right) =>
      direction === "ascending" ? left - right : right - left,
    );
}

function baseTick(
  subscription: MarketSubscription,
  receivedAt: string,
  sourceUpdatedAt: string,
  values: Partial<MarketTick>,
): MarketTick {
  const bid = values.bid;
  const ask = values.ask;
  return {
    source: "polymarket",
    boutId: subscription.boutId,
    marketType: subscription.marketType,
    outcome: subscription.outcome,
    ...values,
    ...(bid === undefined || ask === undefined
      ? {}
      : { impliedProbability: (bid + ask) / 2 }),
    sourceUpdatedAt,
    receivedAt,
    stale: false,
  };
}

function normalizeOne(
  raw: unknown,
  subscriptions: readonly MarketSubscription[],
  receivedAt: string,
): NormalizedTransportMessage[] {
  const message = record(raw);
  if (message === undefined) return [];
  const eventType = message?.event_type;
  if (typeof eventType !== "string") return [];
  const timestamp = sourceTimestamp(message, receivedAt);

  if (eventType === "price_change") {
    if (!Array.isArray(message.price_changes)) return [];
    return message.price_changes.flatMap((changeValue) => {
      const change = record(changeValue);
      const subscription = subscriptionFor(
        subscriptions,
        change?.asset_id,
      );
      if (subscription === undefined) return [];
      const bid = finite(change?.best_bid);
      const ask = finite(change?.best_ask);
      return [
        {
          kind: "delta" as const,
          subscriptionId: subscription.externalId,
          ticks: [
            baseTick(subscription, receivedAt, timestamp, {
              ...(bid === undefined ? {} : { bid }),
              ...(ask === undefined ? {} : { ask }),
            }),
          ],
        },
      ];
    });
  }

  const subscription = subscriptionFor(
    subscriptions,
    message.asset_id,
  );
  if (subscription === undefined) return [];

  if (eventType === "book") {
    const bids = depthPrices(message.bids, "descending");
    const asks = depthPrices(message.asks, "ascending");
    return [
      {
        kind: "snapshot",
        subscriptionId: subscription.externalId,
        ticks: [
          baseTick(subscription, receivedAt, timestamp, {
            ...(bids[0] === undefined ? {} : { bid: bids[0] }),
            ...(asks[0] === undefined ? {} : { ask: asks[0] }),
            depth: { bids, asks },
          }),
        ],
      },
    ];
  }

  if (eventType === "best_bid_ask") {
    const bid = finite(message.best_bid);
    const ask = finite(message.best_ask);
    if (bid === undefined && ask === undefined) return [];
    return [
      {
        kind: "delta",
        subscriptionId: subscription.externalId,
        ticks: [
          baseTick(subscription, receivedAt, timestamp, {
            ...(bid === undefined ? {} : { bid }),
            ...(ask === undefined ? {} : { ask }),
          }),
        ],
      },
    ];
  }

  if (eventType === "last_trade_price") {
    const lastTrade = finite(message.price);
    if (lastTrade === undefined) return [];
    return [
      {
        kind: "delta",
        subscriptionId: subscription.externalId,
        ticks: [
          baseTick(subscription, receivedAt, timestamp, {
            lastTrade,
            ...(finite(message.size) === undefined
              ? {}
              : { volume: finite(message.size) }),
          }),
        ],
      },
    ];
  }

  if (eventType === "tick_size_change") {
    const tickSize = finite(message.new_tick_size);
    if (tickSize === undefined) return [];
    return [
      {
        kind: "delta",
        subscriptionId: subscription.externalId,
        ticks: [
          baseTick(subscription, receivedAt, timestamp, { tickSize }),
        ],
      },
    ];
  }

  if (
    eventType === "market_resolved" ||
    eventType === "new_market"
  ) {
    return [
      {
        kind: "lifecycle",
        subscriptionId: subscription.externalId,
        ticks: [
          baseTick(subscription, receivedAt, timestamp, {
            status:
              eventType === "market_resolved" ? "resolved" : "active",
          }),
        ],
      },
    ];
  }

  return [];
}

/** Pure Polymarket wire normalizer, including batched payloads. */
export function normalizePolymarketMessage(
  raw: unknown,
  subscriptions: readonly MarketSubscription[],
  receivedAt: string,
): readonly NormalizedTransportMessage[] {
  const parsed = parseRaw(raw);
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.flatMap((message) =>
    normalizeOne(message, subscriptions, receivedAt),
  );
}

export class PolymarketFixtureTransport extends FixtureReplayTransport {
  readonly source = "polymarket" as const;

  constructor(options: {
    tickStore: Pick<
      MarketTickStore,
      "ingest" | "markFresh" | "markStale"
    >;
    subscriptions: readonly MarketSubscription[];
  }) {
    super({
      ...options,
      ticks: (fixture.ticks as MarketTick[]).map((tick) => ({
        ...tick,
        source: "polymarket",
      })),
    });
  }
}

class PolymarketLiveTransport extends SupervisedMarketTransport {
  private stopPing: (() => void) | undefined;

  constructor(options: PolymarketLiveTransportOptions) {
    super({
      source: "polymarket",
      tickStore: options.tickStore,
      subscriptions: options.subscriptions,
      socketFactory:
        options.socketFactory ??
        (() => adaptWebSocket(new WebSocket(POLYMARKET_SOCKET_URL))),
      subscribe: (socket, subscriptions) => {
        socket.send(polymarketSubscriptionMessage(subscriptions));
      },
      normalize: (raw, receivedAt) =>
        normalizePolymarketMessage(
          raw,
          options.subscriptions,
          receivedAt,
        ),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.timer === undefined ? {} : { timer: options.timer }),
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.reconnect === undefined
        ? {}
        : { reconnect: options.reconnect }),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
      ...(options.review === undefined ? {} : { review: options.review }),
    });
  }

  protected override onConnected(socket: MarketSocket): void {
    this.stopPing = startPolymarketPingLoop(socket, this.timer);
  }

  protected override onDisconnected(): void {
    this.stopPing?.();
    this.stopPing = undefined;
  }
}

export function createPolymarketLiveTransport(
  config: Pick<CollectorConfig, "dataMode">,
  options: PolymarketLiveTransportOptions,
): MarketTransport {
  if (config.dataMode !== "live") {
    throw new Error(
      "Polymarket live transport requires live data mode",
    );
  }
  return new PolymarketLiveTransport(options);
}
