import type {
  MarketSource,
  MarketTick,
} from "../src/sources/contract.ts";
import type { BoutMapping } from "./mapping.ts";
import { NOOP_METRICS, type Metrics } from "./health.ts";
import type { ParserErrorSink } from "./review.ts";
import type { MarketTickStore } from "./tickStore.ts";

export type StreamingMarketSource = Extract<
  MarketSource,
  "kalshi" | "polymarket"
>;

export interface MarketSubscription {
  source: StreamingMarketSource;
  boutId: string;
  externalId: string;
  marketType: string;
  outcome: string;
}

export type NormalizedTransportMessage =
  | {
      kind: "snapshot";
      subscriptionId: string;
      ticks: readonly MarketTick[];
    }
  | {
      kind: "delta";
      subscriptionId: string;
      ticks: readonly MarketTick[];
    }
  | {
      kind: "lifecycle";
      subscriptionId: string;
      ticks: readonly MarketTick[];
    };

export type MarketTransportEvent =
  | { type: "open"; source: StreamingMarketSource }
  | { type: "close"; source: StreamingMarketSource; reason?: string }
  | { type: "error"; source: StreamingMarketSource; error: Error }
  | {
      type: "message";
      source: StreamingMarketSource;
      message: NormalizedTransportMessage;
    }
  | {
      type: "tick";
      source: StreamingMarketSource;
      tick: MarketTick;
    };

export type MarketTransportListener = (
  event: MarketTransportEvent,
) => void;

export interface MarketTransport {
  readonly source: StreamingMarketSource;
  readonly subscriptions: readonly MarketSubscription[];
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  idle(): Promise<void>;
  /** Resolves once the current subscription set has rebuilt from full books. */
  waitUntilReady(timeoutMs: number): Promise<boolean>;
  setSubscriptions(subscriptions: readonly MarketSubscription[]): void;
  on(listener: MarketTransportListener): () => void;
}

export interface ReplayMarketTransport extends MarketTransport {
  replay(): Promise<void>;
}

export interface MarketTransportClock {
  now(): number;
}

export interface MarketTransportTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface MarketSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onOpen(listener: () => void): () => void;
  onMessage(listener: (data: unknown) => void): () => void;
  onClose(listener: (reason?: string) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
}

export type MarketSocketFactory = () =>
  | MarketSocket
  | Promise<MarketSocket>;

export interface ReconnectPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
};

const DEFAULT_TIMER: MarketTransportTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** REST fallback while the WebSocket is down: `every 3 seconds` per the SLA. */
export const DEFAULT_REST_FALLBACK_INTERVAL_MS = 3_000;
/** Full-book reconciliation cadence, regardless of connection state. */
export const DEFAULT_RECONCILIATION_INTERVAL_MS = 60_000;

/**
 * Polls a REST snapshot while the WebSocket is disconnected, so the book
 * doesn't go stale during an outage. Only runs when the transport is not
 * currently connected; a live socket already delivers continuously.
 */
export interface MarketRestFallbackOptions {
  fetchSnapshot: (
    subscriptions: readonly MarketSubscription[],
  ) => Promise<readonly MarketTick[]>;
  intervalMs?: number;
}

/**
 * Periodically fetches the full order book over REST and ingests it
 * regardless of connection state, correcting drift from any WS messages
 * missed by the incremental delta application in tickStore's
 * `LocalOrderBookState`. A correctness safety net, not a disconnect
 * fallback — `shouldReplace`'s sourceUpdatedAt/receivedAt comparison means a
 * stale REST read can never clobber a fresher WS tick.
 */
export interface MarketReconciliationOptions {
  fetchFullBook: (
    subscriptions: readonly MarketSubscription[],
  ) => Promise<readonly MarketTick[]>;
  intervalMs?: number;
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class TerminalTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalTransportError";
  }
}

function validateSubscription(
  subscription: MarketSubscription,
  source: StreamingMarketSource,
): void {
  if (
    subscription.source !== source ||
    subscription.boutId.trim().length === 0 ||
    subscription.externalId.trim().length === 0 ||
    subscription.marketType.trim().length === 0 ||
    subscription.outcome.trim().length === 0
  ) {
    throw new TypeError(`Invalid ${source} market subscription`);
  }
}

/**
 * Resolves source-native stream identifiers exclusively through the mapping
 * seam. Multiple refs for one source are ordered red, then blue.
 *
 * Polymarket mappings may also retain a 0x-prefixed condition id for the
 * snapshot client; the stream subscribes only to numeric outcome token ids.
 */
export function resolveMarketSubscriptions(
  mappings: readonly BoutMapping[],
  source: StreamingMarketSource,
): MarketSubscription[] {
  return mappings.flatMap((mapping) => {
    const refs = mapping.externalRefs.filter(
      (ref) =>
        ref.source === source &&
        (source !== "polymarket" || !ref.id.startsWith("0x")),
    );
    const outcomes = [mapping.redFighter, mapping.blueFighter] as const;

    return refs.flatMap((ref, index) => {
      const outcome = outcomes[index];
      return outcome === undefined
        ? []
        : [
            {
              source,
              boutId: mapping.internalBoutId,
              externalId: ref.id,
              marketType: "fight-winner",
              outcome,
            },
          ];
    });
  });
}

function subscriptionKey(subscription: MarketSubscription): string {
  return [
    subscription.source,
    subscription.boutId,
    subscription.externalId,
    subscription.marketType,
    subscription.outcome,
  ].join("\u0000");
}

/** Order-insensitive set comparison, so a reordered list is not a change. */
function subscriptionsEqual(
  left: readonly MarketSubscription[],
  right: readonly MarketSubscription[],
): boolean {
  if (left.length !== right.length) return false;
  const leftKeys = new Set(left.map(subscriptionKey));
  return right.every((subscription) =>
    leftKeys.has(subscriptionKey(subscription)),
  );
}

export function reconnectDelay(
  attempt: number,
  random: number,
  policy: ReconnectPolicy = DEFAULT_RECONNECT_POLICY,
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new TypeError("Reconnect attempt must be a non-negative integer");
  }
  if (!Number.isFinite(random) || random < 0 || random > 1) {
    throw new TypeError("Reconnect jitter sample must be between 0 and 1");
  }
  if (
    policy.baseDelayMs < 0 ||
    policy.maxDelayMs < policy.baseDelayMs ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 1
  ) {
    throw new TypeError("Invalid reconnect policy");
  }

  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** attempt,
  );
  const multiplier =
    1 - policy.jitterRatio + random * policy.jitterRatio * 2;
  return Math.round(exponential * multiplier);
}

export interface SupervisedMarketTransportOptions {
  source: StreamingMarketSource;
  tickStore: Pick<
    MarketTickStore,
    "ingest" | "markFresh" | "markStale"
  >;
  subscriptions: readonly MarketSubscription[];
  socketFactory: MarketSocketFactory;
  subscribe: (
    socket: MarketSocket,
    subscriptions: readonly MarketSubscription[],
  ) => void | Promise<void>;
  normalize: (
    raw: unknown,
    receivedAt: string,
  ) =>
    | NormalizedTransportMessage
    | readonly NormalizedTransportMessage[]
    | null;
  clock?: MarketTransportClock;
  timer?: MarketTransportTimer;
  random?: () => number;
  reconnect?: Partial<ReconnectPolicy>;
  metrics?: Metrics;
  review?: ParserErrorSink;
  restFallback?: MarketRestFallbackOptions;
  reconciliation?: MarketReconciliationOptions;
}

/**
 * Shared reconnect/rebuild protocol. A newly opened socket is stale until
 * every subscription has produced a snapshot. Deltas arriving early are
 * buffered per subscription and ingested only after that snapshot.
 */
export class SupervisedMarketTransport implements MarketTransport {
  readonly source: StreamingMarketSource;

  private readonly tickStore: SupervisedMarketTransportOptions["tickStore"];

  private readonly socketFactory: MarketSocketFactory;

  private readonly subscribeSocket: SupervisedMarketTransportOptions["subscribe"];

  private readonly normalizeMessage: SupervisedMarketTransportOptions["normalize"];

  protected readonly clock: MarketTransportClock;

  protected readonly timer: MarketTransportTimer;

  private readonly random: () => number;

  private readonly reconnectPolicy: ReconnectPolicy;

  private readonly metrics: Metrics;

  private readonly review: ParserErrorSink | undefined;

  private readonly restFallback: MarketRestFallbackOptions | undefined;

  private readonly reconciliation: MarketReconciliationOptions | undefined;

  private restFallbackHandle: unknown;

  private reconciliationHandle: unknown;

  private connectedState = false;

  private readonly listeners = new Set<MarketTransportListener>();

  private currentSubscriptions: MarketSubscription[];

  private socket: MarketSocket | undefined;

  private socketUnsubscribers: Array<() => void> = [];

  private reconnectHandle: unknown;

  private reconnectAttempt = 0;

  private desired = false;

  private opening = false;

  private rebuilt = new Set<string>();

  private buffered = new Map<string, NormalizedTransportMessage[]>();

  private readonly readyWaiters = new Set<(ready: boolean) => void>();

  private messageQueue: Promise<void> = Promise.resolve();

  constructor(options: SupervisedMarketTransportOptions) {
    this.source = options.source;
    this.tickStore = options.tickStore;
    this.socketFactory = options.socketFactory;
    this.subscribeSocket = options.subscribe;
    this.normalizeMessage = options.normalize;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.timer = options.timer ?? DEFAULT_TIMER;
    this.random = options.random ?? Math.random;
    this.reconnectPolicy = {
      ...DEFAULT_RECONNECT_POLICY,
      ...options.reconnect,
    };
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.review = options.review;
    this.restFallback = options.restFallback;
    this.reconciliation = options.reconciliation;
    this.currentSubscriptions = [...options.subscriptions];
    this.currentSubscriptions.forEach((subscription) =>
      validateSubscription(subscription, this.source),
    );
  }

  get subscriptions(): readonly MarketSubscription[] {
    return this.currentSubscriptions.map((subscription) => ({
      ...subscription,
    }));
  }

  /** True once every subscription has produced a fresh snapshot on the current socket. */
  get connected(): boolean {
    return this.connectedState;
  }

  /**
   * Replaces what this transport is subscribed to — used to narrow the stream
   * to the bout ESPN says is live, and to widen it again once that fight ends.
   *
   * When the set actually changes on a live socket, the socket is cycled
   * rather than patched. The subscribe frame is only ever sent on open, so a
   * changed set has to be re-sent; reconnecting re-runs the existing
   * open-handshake path, which marks the source stale and buffers deltas until
   * every subscription has produced a fresh snapshot. Patching the frame in
   * place would leave a newly added market applying deltas to a book that was
   * never rebuilt.
   *
   * An unchanged set is a no-op, so a lifecycle event that does not move the
   * active bout never disturbs a healthy stream.
   */
  setSubscriptions(
    subscriptions: readonly MarketSubscription[],
  ): void {
    subscriptions.forEach((subscription) =>
      validateSubscription(subscription, this.source),
    );
    const next = subscriptions.map((subscription) => ({ ...subscription }));
    if (subscriptionsEqual(this.currentSubscriptions, next)) return;

    this.currentSubscriptions = next;
    if (this.socket === undefined || !this.desired) return;

    const socket = this.socket;
    this.clearSocketListeners();
    this.socket = undefined;
    this.connectedState = false;
    socket.close(1000, "subscription change");
    this.rebuilt.clear();
    this.buffered.clear();
    this.reconnectAttempt = 0;
    void this.open().catch(() => undefined);
  }

  on(listener: MarketTransportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (this.desired && (this.socket !== undefined || this.opening)) {
      return;
    }
    this.desired = true;
    await this.tickStore.markStale(this.source, this.nowIso());
    this.startBackgroundLoops();
    await this.open();
  }

  async disconnect(): Promise<void> {
    this.desired = false;
    this.connectedState = false;
    this.stopBackgroundLoops();
    if (this.reconnectHandle !== undefined) {
      this.timer.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = undefined;
    }
    this.clearSocketListeners();
    const socket = this.socket;
    this.socket = undefined;
    this.opening = false;
    socket?.close(1000, "collector disconnect");
    this.onDisconnected();
    await this.tickStore.markStale(this.source, this.nowIso());
    await this.messageQueue;
    this.emit({ type: "close", source: this.source, reason: "collector disconnect" });
  }

  async idle(): Promise<void> {
    while (true) {
      const queue = this.messageQueue;
      await queue;
      await Promise.resolve();
      if (queue === this.messageQueue) return;
    }
  }

  waitUntilReady(timeoutMs: number): Promise<boolean> {
    if (this.connectedState) return Promise.resolve(true);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError("timeoutMs must be a non-negative finite number");
    }
    return new Promise((resolve) => {
      const finish = (ready: boolean): void => {
        this.readyWaiters.delete(onReady);
        globalThis.clearTimeout(timeout);
        resolve(ready);
      };
      const onReady = (): void => finish(true);
      const timeout = globalThis.setTimeout(() => finish(false), timeoutMs);
      this.readyWaiters.add(onReady);
    });
  }

  protected onConnected(_socket: MarketSocket): void {
    // Subclasses may start source-specific heartbeat behavior.
  }

  protected onDisconnected(): void {
    // Subclasses may stop source-specific heartbeat behavior.
  }

  protected send(data: string): void {
    if (this.socket?.readyState === 1) this.socket.send(data);
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private emit(event: MarketTransportEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async open(): Promise<void> {
    if (!this.desired || this.opening || this.socket !== undefined) return;
    this.opening = true;
    try {
      const socket = await this.socketFactory();
      if (!this.desired) {
        socket.close(1000, "connect cancelled");
        return;
      }
      this.socket = socket;
      this.bindSocket(socket);
    } catch (error) {
      const normalizedError = errorFrom(error);
      this.emit({
        type: "error",
        source: this.source,
        error: normalizedError,
      });
      if (!(normalizedError instanceof TerminalTransportError)) {
        this.scheduleReconnect();
      }
    } finally {
      this.opening = false;
    }
  }

  private bindSocket(socket: MarketSocket): void {
    this.socketUnsubscribers = [
      socket.onOpen(() => {
        this.messageQueue = this.messageQueue
          .then(() => this.handleOpen(socket))
          .catch((error: unknown) => {
            this.emit({
              type: "error",
              source: this.source,
              error: errorFrom(error),
            });
          });
      }),
      socket.onMessage((data) => {
        this.messageQueue = this.messageQueue
          .then(() => this.handleRawMessage(data))
          .catch((error: unknown) => {
            this.emit({
              type: "error",
              source: this.source,
              error: errorFrom(error),
            });
          });
      }),
      socket.onClose((reason) => {
        void this.tickStore.markStale(this.source, this.nowIso());
        this.messageQueue = this.messageQueue
          .then(() => this.handleClose(socket, reason))
          .catch((error: unknown) => {
            this.emit({
              type: "error",
              source: this.source,
              error: errorFrom(error),
            });
          });
      }),
      socket.onError((error) => {
        this.emit({ type: "error", source: this.source, error });
      }),
    ];
  }

  private async handleOpen(socket: MarketSocket): Promise<void> {
    if (socket !== this.socket || !this.desired) return;
    this.rebuilt.clear();
    this.buffered.clear();
    await this.tickStore.markStale(this.source, this.nowIso());
    await this.subscribeSocket(socket, this.subscriptions);
    this.onConnected(socket);
    this.emit({ type: "open", source: this.source });
  }

  private async handleRawMessage(raw: unknown): Promise<void> {
    const receivedAt = this.nowIso();
    let normalized:
      | NormalizedTransportMessage
      | readonly NormalizedTransportMessage[]
      | null;
    try {
      normalized = this.normalizeMessage(raw, receivedAt);
    } catch (error) {
      if (this.review !== undefined) {
        await this.review.recordParserError({
          source: this.source,
          context: "websocket-message",
          error,
          localTimestamp: receivedAt,
        });
      } else {
        this.metrics.increment(
          "parser_failures_total",
          this.source,
          1,
          { localTimestamp: receivedAt },
        );
      }
      throw error;
    }
    if (normalized === null) return;
    const messages = Array.isArray(normalized)
      ? normalized
      : [normalized];
    for (const message of messages) {
      await this.handleNormalizedMessage(message);
    }
  }

  private async handleNormalizedMessage(
    message: NormalizedTransportMessage,
  ): Promise<void> {
    if (
      !this.currentSubscriptions.some(
        ({ externalId }) => externalId === message.subscriptionId,
      )
    ) {
      return;
    }
    this.emit({ type: "message", source: this.source, message });

    if (
      message.kind === "delta" &&
      !this.rebuilt.has(message.subscriptionId)
    ) {
      const pending = this.buffered.get(message.subscriptionId) ?? [];
      pending.push(message);
      this.buffered.set(message.subscriptionId, pending);
      return;
    }

    await this.ingestTicks(message.ticks);
    if (message.kind !== "snapshot") return;

    this.rebuilt.add(message.subscriptionId);
    const pending = this.buffered.get(message.subscriptionId) ?? [];
    this.buffered.delete(message.subscriptionId);
    for (const delta of pending) await this.ingestTicks(delta.ticks);

    if (
      this.currentSubscriptions.every(({ externalId }) =>
        this.rebuilt.has(externalId),
      )
    ) {
      await this.completeRebuild();
    }
  }

  private async ingestTicks(ticks: readonly MarketTick[]): Promise<void> {
    for (const tick of ticks) {
      await this.tickStore.ingest(tick);
      this.emit({ type: "tick", source: this.source, tick: { ...tick } });
    }
  }

  private async completeRebuild(): Promise<void> {
    this.reconnectAttempt = 0;
    this.connectedState = true;
    await this.tickStore.markFresh(this.source, this.nowIso());
    for (const resolve of this.readyWaiters) resolve(true);
    this.readyWaiters.clear();
  }

  private async handleClose(
    socket: MarketSocket,
    reason?: string,
  ): Promise<void> {
    if (socket !== this.socket) return;
    this.clearSocketListeners();
    this.socket = undefined;
    this.connectedState = false;
    this.onDisconnected();
    this.emit({ type: "close", source: this.source, ...(reason ? { reason } : {}) });
    this.scheduleReconnect();
  }

  private clearSocketListeners(): void {
    for (const unsubscribe of this.socketUnsubscribers.splice(0)) {
      unsubscribe();
    }
  }

  private scheduleReconnect(): void {
    if (!this.desired || this.reconnectHandle !== undefined) return;
    this.metrics.increment(
      "websocket_reconnects_total",
      this.source,
      1,
      { localTimestamp: this.nowIso() },
    );
    const delay = reconnectDelay(
      this.reconnectAttempt,
      this.random(),
      this.reconnectPolicy,
    );
    this.reconnectAttempt += 1;
    this.reconnectHandle = this.timer.setTimeout(() => {
      this.reconnectHandle = undefined;
      void this.open();
    }, delay);
  }

  private startBackgroundLoops(): void {
    if (
      this.reconciliation !== undefined &&
      this.reconciliationHandle === undefined
    ) {
      this.scheduleReconciliation();
    }
    if (
      this.restFallback !== undefined &&
      this.restFallbackHandle === undefined
    ) {
      this.scheduleRestFallback();
    }
  }

  private stopBackgroundLoops(): void {
    if (this.reconciliationHandle !== undefined) {
      this.timer.clearTimeout(this.reconciliationHandle);
      this.reconciliationHandle = undefined;
    }
    if (this.restFallbackHandle !== undefined) {
      this.timer.clearTimeout(this.restFallbackHandle);
      this.restFallbackHandle = undefined;
    }
  }

  private scheduleReconciliation(): void {
    const options = this.reconciliation;
    if (options === undefined) return;
    const intervalMs =
      options.intervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
    this.reconciliationHandle = this.timer.setTimeout(() => {
      this.reconciliationHandle = undefined;
      void this.runReconciliation(options).finally(() => {
        if (this.desired) this.scheduleReconciliation();
      });
    }, intervalMs);
  }

  private async runReconciliation(
    options: MarketReconciliationOptions,
  ): Promise<void> {
    try {
      const ticks = await options.fetchFullBook(this.subscriptions);
      await this.ingestTicks(ticks);
    } catch (error) {
      this.emit({ type: "error", source: this.source, error: errorFrom(error) });
    }
  }

  private scheduleRestFallback(): void {
    const options = this.restFallback;
    if (options === undefined) return;
    const intervalMs =
      options.intervalMs ?? DEFAULT_REST_FALLBACK_INTERVAL_MS;
    this.restFallbackHandle = this.timer.setTimeout(() => {
      this.restFallbackHandle = undefined;
      void this.runRestFallback(options).finally(() => {
        if (this.desired) this.scheduleRestFallback();
      });
    }, intervalMs);
  }

  private async runRestFallback(
    options: MarketRestFallbackOptions,
  ): Promise<void> {
    if (this.connectedState) return;
    try {
      const ticks = await options.fetchSnapshot(this.subscriptions);
      await this.ingestTicks(ticks);
    } catch (error) {
      this.emit({ type: "error", source: this.source, error: errorFrom(error) });
    }
  }
}

export abstract class FixtureReplayTransport
  implements ReplayMarketTransport
{
  abstract readonly source: StreamingMarketSource;

  private readonly tickStore: Pick<
    MarketTickStore,
    "ingest" | "markFresh" | "markStale"
  >;

  private readonly ticks: readonly MarketTick[];

  private readonly listeners = new Set<MarketTransportListener>();

  private connected = false;

  private currentSubscriptions: MarketSubscription[];

  protected constructor(options: {
    tickStore: Pick<
      MarketTickStore,
      "ingest" | "markFresh" | "markStale"
    >;
    ticks: readonly MarketTick[];
    subscriptions: readonly MarketSubscription[];
  }) {
    this.tickStore = options.tickStore;
    this.ticks = options.ticks.map((tick) => ({ ...tick }));
    this.currentSubscriptions = options.subscriptions.map(
      (subscription) => ({ ...subscription }),
    );
  }

  get subscriptions(): readonly MarketSubscription[] {
    return this.currentSubscriptions.map((subscription) => ({
      ...subscription,
    }));
  }

  setSubscriptions(
    subscriptions: readonly MarketSubscription[],
  ): void {
    subscriptions.forEach((subscription) =>
      validateSubscription(subscription, this.source),
    );
    this.currentSubscriptions = subscriptions.map((subscription) => ({
      ...subscription,
    }));
  }

  on(listener: MarketTransportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;
    await this.tickStore.markStale(this.source);
    this.emit({ type: "open", source: this.source });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.tickStore.markStale(this.source);
    this.emit({ type: "close", source: this.source, reason: "fixture disconnect" });
  }

  async idle(): Promise<void> {
    await Promise.resolve();
  }

  async waitUntilReady(_timeoutMs: number): Promise<boolean> {
    return this.connected;
  }

  async replay(): Promise<void> {
    await this.connect();
    const relevantBouts = new Set(
      this.currentSubscriptions.map(({ boutId }) => boutId),
    );
    let ingested = 0;
    for (const tick of this.ticks) {
      if (!relevantBouts.has(tick.boutId)) {
        continue;
      }
      await this.tickStore.ingest(tick);
      ingested += 1;
      this.emit({ type: "tick", source: this.source, tick: { ...tick } });
    }
    if (ingested > 0) await this.tickStore.markFresh(this.source);
  }

  private emit(event: MarketTransportEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export function adaptWebSocket(socket: WebSocket): MarketSocket {
  const bind = <EventValue extends Event>(
    type: string,
    listener: (event: EventValue) => void,
  ): (() => void) => {
    const eventListener = listener as EventListener;
    socket.addEventListener(type, eventListener);
    return () => socket.removeEventListener(type, eventListener);
  };

  return {
    get readyState() {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onOpen: (listener) => bind("open", listener),
    onMessage: (listener) =>
      bind<MessageEvent>("message", (event) => listener(event.data)),
    onClose: (listener) =>
      bind<CloseEvent>("close", (event) => listener(event.reason)),
    onError: (listener) =>
      bind("error", () => listener(new Error("WebSocket error"))),
  };
}
