import { readFile } from "node:fs/promises";
import fixture from "../src/fixtures/kalshiTicks.json" with {
  type: "json",
};
import type { MarketTick } from "../src/sources/contract.ts";
import {
  importKalshiPrivateKey,
  signKalshiRequest,
} from "../src/sources/kalshiAuth.ts";
import type { CollectorConfig } from "./config.ts";
import {
  adaptWebSocket,
  FixtureReplayTransport,
  type MarketSocketFactory,
  type MarketSubscription,
  type MarketTransportClock,
  type MarketTransportTimer,
  type NormalizedTransportMessage,
  type ReconnectPolicy,
  SupervisedMarketTransport,
  TerminalTransportError,
} from "./marketTransport.ts";
import type { MarketTickStore } from "./tickStore.ts";

const KALSHI_SOCKET_URL =
  "wss://external-api-ws.kalshi.com/trade-api/ws/v2";
const KALSHI_SOCKET_PATH = "/trade-api/ws/v2";

interface KalshiBook {
  bids: number[];
  asks: number[];
  bidSizes?: Readonly<Record<string, number>>;
  askSizes?: Readonly<Record<string, number>>;
}

export interface KalshiNormalization {
  message: NormalizedTransportMessage;
  book?: KalshiBook;
}

interface KalshiLiveDependencies {
  socketFactory?: MarketSocketFactory;
  readPrivateKey?: (path: string) => Promise<string>;
  clock?: MarketTransportClock;
  timer?: MarketTransportTimer;
  random?: () => number;
  reconnect?: Partial<ReconnectPolicy>;
}

interface KalshiLiveTransportOptions extends KalshiLiveDependencies {
  tickStore: Pick<
    MarketTickStore,
    "ingest" | "markFresh" | "markStale"
  >;
  subscriptions: readonly MarketSubscription[];
  keyId: string;
  privateKeyPath: string;
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

function cents(
  message: Record<string, unknown>,
  centsField: string,
  dollarsFields: readonly string[],
): number | undefined {
  const nativeCents = finite(message[centsField]);
  if (nativeCents !== undefined) return nativeCents;
  for (const field of dollarsFields) {
    const dollars = finite(message[field]);
    if (dollars !== undefined) {
      return Number((dollars * 100).toFixed(4));
    }
  }
  return undefined;
}

function sourceTimestamp(
  message: Record<string, unknown>,
  receivedAt: string,
): string {
  const milliseconds = finite(message.ts_ms);
  if (milliseconds !== undefined) {
    return new Date(milliseconds).toISOString();
  }
  const candidate = message.ts ?? message.time;
  if (typeof candidate === "string") {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const seconds = finite(candidate);
  return seconds === undefined
    ? receivedAt
    : new Date(seconds * 1_000).toISOString();
}

function parseRaw(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string") return record(raw);
  try {
    return record(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

function prices(
  levels: unknown,
  factor = 100,
): number[] {
  if (!Array.isArray(levels)) return [];
  return levels.flatMap((level) => {
    if (!Array.isArray(level)) return [];
    const price = finite(level[0]);
    const size = finite(level[1]);
    return price === undefined || size === undefined || size <= 0
      ? []
      : [Number((price * factor).toFixed(4))];
  });
}

function levelSizes(
  levels: unknown,
  factor = 100,
): Record<string, number> {
  if (!Array.isArray(levels)) return {};
  return Object.fromEntries(
    levels.flatMap((level) => {
      if (!Array.isArray(level)) return [];
      const price = finite(level[0]);
      const size = finite(level[1]);
      if (price === undefined || size === undefined || size <= 0) return [];
      const normalizedPrice = Number((price * factor).toFixed(4));
      return [[String(normalizedPrice), size] as const];
    }),
  );
}

function sortedUnique(
  values: readonly number[],
  direction: "ascending" | "descending",
): number[] {
  return [...new Set(values)].sort((left, right) =>
    direction === "ascending" ? left - right : right - left,
  );
}

function applyLevel(
  sizes: Readonly<Record<string, number>>,
  price: number,
  delta: number,
  direction: "ascending" | "descending",
): { levels: number[]; sizes: Record<string, number> } {
  const nextSizes = { ...sizes };
  const nextSize = (nextSizes[String(price)] ?? 0) + delta;
  if (nextSize <= 0) delete nextSizes[String(price)];
  else nextSizes[String(price)] = nextSize;
  return {
    levels: sortedUnique(
      Object.keys(nextSizes).map(Number),
      direction,
    ),
    sizes: nextSizes,
  };
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

function baseTick(
  subscription: MarketSubscription,
  receivedAt: string,
  sourceUpdatedAt: string,
  values: Partial<MarketTick>,
): MarketTick {
  const bid = values.bid;
  const ask = values.ask;
  return {
    source: "kalshi",
    boutId: subscription.boutId,
    marketType: subscription.marketType,
    outcome: subscription.outcome,
    ...values,
    ...(bid === undefined || ask === undefined
      ? {}
      : { impliedProbability: (bid + ask) / 200 }),
    sourceUpdatedAt,
    receivedAt,
    stale: false,
  };
}

/**
 * Pure Kalshi wire normalizer. The optional prior book is input data rather
 * than hidden mutable state, so order-book delta behavior is deterministic.
 */
export function normalizeKalshiMessage(
  raw: unknown,
  subscriptions: readonly MarketSubscription[],
  receivedAt: string,
  priorBook?: KalshiBook,
): KalshiNormalization | null {
  const envelope = parseRaw(raw);
  const message = record(envelope?.msg);
  const type = envelope?.type;
  if (typeof type !== "string" || message === undefined) return null;

  const subscription = subscriptionFor(
    subscriptions,
    message.market_ticker,
  );
  if (subscription === undefined) return null;
  const timestamp = sourceTimestamp(message, receivedAt);

  if (type === "orderbook_snapshot") {
    const bids = sortedUnique(
      [
        ...prices(message.yes_dollars_fp),
        ...prices(message.yes),
      ],
      "descending",
    );
    const asks = sortedUnique(
      [
        ...prices(message.no_dollars_fp),
        ...prices(message.no),
      ],
      "ascending",
    );
    const book: KalshiBook = { bids, asks };
    book.bidSizes = {
      ...levelSizes(message.yes_dollars_fp),
      ...levelSizes(message.yes),
    };
    book.askSizes = {
      ...levelSizes(message.no_dollars_fp),
      ...levelSizes(message.no),
    };
    const tick = baseTick(subscription, receivedAt, timestamp, {
      ...(bids[0] === undefined ? {} : { bid: bids[0] }),
      ...(asks[0] === undefined ? {} : { ask: asks[0] }),
      depth: book,
    });
    return {
      book,
      message: {
        kind: "snapshot",
        subscriptionId: subscription.externalId,
        ticks: [tick],
      },
    };
  }

  if (type === "orderbook_delta") {
    if (priorBook === undefined) return null;
    const price = cents(message, "price", [
      "price_dollars",
      "price_dollars_fp",
    ]);
    const delta = finite(message.delta ?? message.delta_fp);
    const side = message.side;
    if (
      price === undefined ||
      delta === undefined ||
      (side !== "yes" && side !== "no")
    ) {
      return null;
    }
    const bidUpdate =
      side === "yes"
        ? applyLevel(
            priorBook.bidSizes ??
              Object.fromEntries(
                priorBook.bids.map((level) => [String(level), 1]),
              ),
            price,
            delta,
            "descending",
          )
        : undefined;
    const askUpdate =
      side === "no"
        ? applyLevel(
            priorBook.askSizes ??
              Object.fromEntries(
                priorBook.asks.map((level) => [String(level), 1]),
              ),
            price,
            delta,
            "ascending",
          )
        : undefined;
    const book: KalshiBook = {
      bids: bidUpdate?.levels ?? [...priorBook.bids],
      asks: askUpdate?.levels ?? [...priorBook.asks],
      bidSizes: bidUpdate?.sizes ?? priorBook.bidSizes,
      askSizes: askUpdate?.sizes ?? priorBook.askSizes,
    };
    const tick = baseTick(subscription, receivedAt, timestamp, {
      ...(book.bids[0] === undefined ? {} : { bid: book.bids[0] }),
      ...(book.asks[0] === undefined ? {} : { ask: book.asks[0] }),
      depth: book,
    });
    return {
      book,
      message: {
        kind: "delta",
        subscriptionId: subscription.externalId,
        ticks: [tick],
      },
    };
  }

  if (type === "ticker") {
    const bid = cents(message, "yes_bid", [
      "yes_bid_dollars",
      "yes_bid_dollars_fp",
    ]);
    const ask = cents(message, "yes_ask", [
      "yes_ask_dollars",
      "yes_ask_dollars_fp",
    ]);
    const lastTrade = cents(message, "price", [
      "price_dollars",
      "price_dollars_fp",
      "last_price_dollars",
    ]);
    const tick = baseTick(subscription, receivedAt, timestamp, {
      ...(bid === undefined ? {} : { bid }),
      ...(ask === undefined ? {} : { ask }),
      ...(lastTrade === undefined ? {} : { lastTrade }),
      ...(finite(message.volume) === undefined
        ? {}
        : { volume: finite(message.volume) }),
    });
    return {
      message: {
        kind: "delta",
        subscriptionId: subscription.externalId,
        ticks: [tick],
      },
    };
  }

  if (type === "trade") {
    const lastTrade = cents(message, "yes_price", [
      "yes_price_dollars",
      "yes_price_dollars_fp",
      "price_dollars",
    ]);
    if (lastTrade === undefined) return null;
    return {
      message: {
        kind: "delta",
        subscriptionId: subscription.externalId,
        ticks: [
          baseTick(subscription, receivedAt, timestamp, {
            lastTrade,
            ...(finite(message.volume) === undefined
              ? {}
              : { volume: finite(message.volume) }),
          }),
        ],
      },
    };
  }

  if (
    type === "market_lifecycle_v2" ||
    type === "market_lifecycle"
  ) {
    const status = message.status ?? message.market_status;
    if (typeof status !== "string" || status.length === 0) return null;
    return {
      message: {
        kind: "lifecycle",
        subscriptionId: subscription.externalId,
        ticks: [
          baseTick(subscription, receivedAt, timestamp, { status }),
        ],
      },
    };
  }

  return null;
}

export class KalshiFixtureTransport extends FixtureReplayTransport {
  readonly source = "kalshi" as const;

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
        source: "kalshi",
      })),
    });
  }
}

function defaultKalshiSocketFactory(options: {
  keyId: string;
  privateKeyPath: string;
  readPrivateKey: (path: string) => Promise<string>;
  clock: MarketTransportClock;
}): MarketSocketFactory {
  return async () => {
    let headers: Awaited<ReturnType<typeof signKalshiRequest>>;
    try {
      const pem = await options.readPrivateKey(options.privateKeyPath);
      const privateKey = await importKalshiPrivateKey(pem);
      const timestamp = options.clock.now();
      headers = await signKalshiRequest(
        privateKey,
        options.keyId,
        "GET",
        KALSHI_SOCKET_PATH,
        timestamp,
      );
    } catch {
      throw new TerminalTransportError(
        "Kalshi WebSocket authentication failed",
      );
    }
    type NodeWebSocketConstructor = new (
      url: string,
      options: { headers: Record<string, string> },
    ) => WebSocket;
    const Constructor =
      WebSocket as unknown as NodeWebSocketConstructor;
    return adaptWebSocket(
      new Constructor(KALSHI_SOCKET_URL, { headers: { ...headers } }),
    );
  };
}

export function kalshiSubscriptionMessage(
  subscriptions: readonly MarketSubscription[],
): string {
  return JSON.stringify({
    id: 1,
    cmd: "subscribe",
    params: {
      channels: [
        "ticker",
        "trade",
        "orderbook_delta",
        "market_lifecycle_v2",
      ],
      market_tickers: subscriptions.map(
        ({ externalId }) => externalId,
      ),
      use_yes_price: true,
    },
  });
}

class KalshiLiveTransport extends SupervisedMarketTransport {
  constructor(options: KalshiLiveTransportOptions) {
    const clock = options.clock ?? { now: () => Date.now() };
    const books = new Map<string, KalshiBook>();
    const socketFactory =
      options.socketFactory ??
      defaultKalshiSocketFactory({
        keyId: options.keyId,
        privateKeyPath: options.privateKeyPath,
        readPrivateKey: options.readPrivateKey ?? ((path) => readFile(path, "utf8")),
        clock,
      });

    super({
      source: "kalshi",
      tickStore: options.tickStore,
      subscriptions: options.subscriptions,
      socketFactory,
      subscribe: (socket, subscriptions) => {
        socket.send(kalshiSubscriptionMessage(subscriptions));
      },
      normalize: (raw, receivedAt) => {
        const envelope = parseRaw(raw);
        const message = record(envelope?.msg);
        const externalId =
          typeof message?.market_ticker === "string"
            ? message.market_ticker
            : undefined;
        const normalized = normalizeKalshiMessage(
          raw,
          options.subscriptions,
          receivedAt,
          externalId === undefined ? undefined : books.get(externalId),
        );
        if (
          normalized?.book !== undefined &&
          externalId !== undefined
        ) {
          books.set(externalId, normalized.book);
        }
        return normalized?.message ?? null;
      },
      clock,
      ...(options.timer === undefined ? {} : { timer: options.timer }),
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.reconnect === undefined
        ? {}
        : { reconnect: options.reconnect }),
    });
  }
}

export function createKalshiLiveTransport(
  config: CollectorConfig,
  options: Omit<
    KalshiLiveTransportOptions,
    "keyId" | "privateKeyPath"
  >,
): KalshiLiveTransport {
  const keyId = config.credentials.KALSHI_API_KEY_ID;
  const privateKeyPath =
    config.credentials.KALSHI_PRIVATE_KEY_PATH;
  if (
    config.dataMode !== "live" ||
    keyId === undefined ||
    privateKeyPath === undefined
  ) {
    throw new Error(
      "Kalshi live transport requires live mode and server credentials",
    );
  }
  return new KalshiLiveTransport({
    ...options,
    keyId,
    privateKeyPath,
  });
}
