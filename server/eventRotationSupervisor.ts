import type { Storage } from "./storage.ts";

export const EVENT_ROTATION_STORAGE_STREAM = "event-rotation-supervisor";

export interface EventRotationClock {
  now(): number;
}

export interface EventRotationTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface PersistedEventRotation {
  version: 1;
  eventId: string;
  rotatedAt: string;
}

function isPersistedEventRotation(value: unknown): value is PersistedEventRotation {
  const record = value as Record<string, unknown>;
  return (
    typeof value === "object" &&
    value !== null &&
    record.version === 1 &&
    typeof record.eventId === "string" &&
    record.eventId.trim().length > 0 &&
    typeof record.rotatedAt === "string"
  );
}

const defaultClock: EventRotationClock = { now: () => Date.now() };
const defaultTimer: EventRotationTimer = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/**
 * Polls a caller-owned current-event resolver and rotates exactly once per
 * newly discovered ESPN event id. The supervisor is deliberately unaware of
 * collector internals: its callback can rebuild a collector, swap a card, or
 * perform any other atomic runtime handoff.
 */
export class EventRotationSupervisor {
  private readonly storage: Storage;
  private readonly resolveEventId: () => Promise<string | undefined>;
  private readonly rotate: (eventId: string) => Promise<void>;
  private readonly intervalMs: number;
  private readonly clock: EventRotationClock;
  private readonly timer: EventRotationTimer;
  private readonly stream: string;
  private readonly onError: ((error: unknown) => void) | undefined;

  private readonly initialEventId: string | undefined;

  private currentEventId: string | undefined;
  private timerHandle: unknown;
  private started = false;
  private closed = false;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: EventRotationSupervisorOptions) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new TypeError("event rotation intervalMs must be positive");
    }
    this.storage = options.storage;
    this.resolveEventId = options.resolveEventId;
    this.rotate = options.rotate;
    this.intervalMs = options.intervalMs;
    this.clock = options.clock ?? defaultClock;
    this.timer = options.timer ?? defaultTimer;
    this.stream = options.storageStream ?? EVENT_ROTATION_STORAGE_STREAM;
    this.onError = options.onError;
    this.initialEventId = options.initialEventId;
  }

  getCurrentEventId(): string | undefined {
    return this.currentEventId;
  }

  isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started || this.closed) return;
    const persistedEventId = (await this.storage.read<unknown>(this.stream))
      .filter(isPersistedEventRotation)
      .at(-1)?.eventId;
    // The collector loaded for this process is authoritative. Persisted state
    // is only a fallback for callers that do not already own a live runtime.
    this.currentEventId = this.initialEventId ?? persistedEventId;
    this.started = true;
    await this.enqueue(() => this.pollOnce());
  }

  async pollNow(): Promise<void> {
    if (!this.started || this.closed) return;
    await this.enqueue(() => this.pollOnce());
  }

  async idle(): Promise<void> {
    while (true) {
      const queue = this.operationQueue;
      await queue;
      if (queue === this.operationQueue) return;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timerHandle !== undefined) {
      this.timer.clearTimeout(this.timerHandle);
      this.timerHandle = undefined;
    }
    await this.idle();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async pollOnce(): Promise<void> {
    if (this.closed) return;
    try {
      const eventId = await this.resolveEventId();
      if (eventId !== undefined && eventId !== this.currentEventId) {
        await this.rotate(eventId);
        await this.storage.replace(this.stream, [{
          version: 1,
          eventId,
          rotatedAt: new Date(this.clock.now()).toISOString(),
        } satisfies PersistedEventRotation]);
        this.currentEventId = eventId;
      }
    } catch (error) {
      this.onError?.(error);
    } finally {
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (this.closed || !this.started) return;
    this.timerHandle = this.timer.setTimeout(() => {
      this.timerHandle = undefined;
      void this.enqueue(() => this.pollOnce());
    }, this.intervalMs);
  }
}

export interface EventRotationSupervisorOptions {
  storage: Storage;
  /** Resolves the nearest current or upcoming ESPN event id. */
  resolveEventId: () => Promise<string | undefined>;
  /** Invoked only after the resolved id differs from persisted runtime state. */
  rotate: (eventId: string) => Promise<void>;
  intervalMs: number;
  clock?: EventRotationClock;
  timer?: EventRotationTimer;
  storageStream?: string;
  onError?: (error: unknown) => void;
  /** Event currently loaded by the runtime at process start. */
  initialEventId?: string;
}
