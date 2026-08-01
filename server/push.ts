import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { Storage } from "./storage.ts";

export const DEFAULT_SSE_PATH = "/api/events";
export const DEFAULT_SSE_STORAGE_STREAM = "sse-events";
export const DEFAULT_SSE_BUFFER_SIZE = 256;
export const DEFAULT_HEARTBEAT_MS = 15_000;
/** UI flush cadence: client writes are coalesced to fire at most this often. */
export const DEFAULT_FLUSH_MS = 500;

export interface SsePushTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PersistedSseEvent {
  version: 1;
  id: number;
  event: string;
  data: unknown;
  createdAt: string;
}

export interface SsePushOptions {
  storage: Storage;
  getBootstrap: () => unknown;
  secrets?: readonly string[];
  path?: string;
  storageStream?: string;
  bufferSize?: number;
  heartbeatMs?: number;
  /**
   * Coalescing window for client writes: publishes arriving within this
   * window are batched into a single socket write per client. `0` disables
   * batching and writes synchronously (used by tests asserting immediate
   * delivery).
   */
  flushIntervalMs?: number;
  timer?: SsePushTimer;
  now?: () => string;
}

const SENSITIVE_KEY =
  /^(?:authorization|auth(?:entication)?(?:[-_]?(?:details?|headers?))?|credentials?|api[-_]?keys?|bearer(?:[-_]?token)?|tokens?|private[-_]?keys?|signatures?)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeString(value: string, secrets: readonly string[]): string {
  let sanitized = value;

  for (const secret of secrets) {
    if (secret.length > 0) {
      sanitized = sanitized.split(secret).join("[REDACTED]");
    }
  }

  return sanitized;
}

export function sanitizeClientPayload(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  if (typeof value === "string") {
    return sanitizeString(value, secrets);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeClientPayload(entry, secrets));
  }

  if (!isRecord(value)) {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!SENSITIVE_KEY.test(key)) {
      sanitized[key] = sanitizeClientPayload(entry, secrets);
    }
  }

  return sanitized;
}

function isPersistedSseEvent(value: unknown): value is PersistedSseEvent {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    typeof value.event === "string" &&
    value.event.length > 0 &&
    typeof value.createdAt === "string" &&
    "data" in value
  );
}

function formatEvent(event: {
  id: number;
  event: string;
  data: unknown;
}): string {
  return [
    `id: ${event.id}`,
    `event: ${event.event}`,
    `data: ${JSON.stringify(event.data)}`,
    "",
    "",
  ].join("\n");
}

const DEFAULT_TIMER: SsePushTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function parseLastEventId(request: IncomingMessage): number | undefined {
  const raw = request.headers["last-event-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim() === "") return undefined;

  const id = Number(value);
  return Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

export class SsePush {
  private readonly storage: Storage;

  private readonly getBootstrap: () => unknown;

  private readonly secrets: readonly string[];

  private readonly path: string;

  private readonly storageStream: string;

  private readonly bufferSize: number;

  private readonly now: () => string;

  private readonly flushIntervalMs: number;

  private readonly timer: SsePushTimer;

  private readonly clients = new Set<ServerResponse>();

  private buffer: PersistedSseEvent[] = [];

  private lastEventId = 0;

  private restorePromise: Promise<void> | undefined;

  private publishQueue: Promise<void> = Promise.resolve();

  private readonly heartbeat: ReturnType<typeof setInterval>;

  private pendingOutbound: string[] = [];

  private flushHandle: unknown;

  constructor(options: SsePushOptions) {
    const bufferSize = options.bufferSize ?? DEFAULT_SSE_BUFFER_SIZE;
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_MS;

    if (!Number.isSafeInteger(bufferSize) || bufferSize < 1) {
      throw new TypeError("bufferSize must be a positive integer");
    }
    if (!Number.isFinite(heartbeatMs) || heartbeatMs < 1) {
      throw new TypeError("heartbeatMs must be a positive number");
    }
    if (!Number.isFinite(flushIntervalMs) || flushIntervalMs < 0) {
      throw new TypeError("flushIntervalMs must be a non-negative number");
    }

    this.storage = options.storage;
    this.getBootstrap = options.getBootstrap;
    this.secrets = [...(options.secrets ?? [])].filter(Boolean);
    this.path = options.path ?? DEFAULT_SSE_PATH;
    this.storageStream =
      options.storageStream ?? DEFAULT_SSE_STORAGE_STREAM;
    this.bufferSize = bufferSize;
    this.now = options.now ?? (() => new Date().toISOString());
    this.flushIntervalMs = flushIntervalMs;
    this.timer = options.timer ?? DEFAULT_TIMER;
    this.heartbeat = setInterval(() => {
      const comment = `: heartbeat ${this.now()}\n\n`;
      for (const client of this.clients) {
        client.write(comment);
      }
    }, heartbeatMs);
    (
      this.heartbeat as unknown as { unref?: () => void }
    ).unref?.();
  }

  async restore(): Promise<void> {
    this.restorePromise ??= this.restoreFromStorage();
    await this.restorePromise;
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://collector.local");
    if (request.method !== "GET" || url.pathname !== this.path) {
      return false;
    }

    await this.restore();
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();

    const requestedId = parseLastEventId(request);
    const oldestId = this.buffer[0]?.id;
    const canResume =
      requestedId !== undefined &&
      requestedId <= this.lastEventId &&
      (oldestId === undefined
        ? requestedId === this.lastEventId
        : requestedId >= oldestId - 1);

    if (canResume && requestedId !== undefined) {
      for (const event of this.buffer) {
        if (event.id > requestedId) {
          response.write(formatEvent(this.forClient(event)));
        }
      }
    } else {
      response.write(
        formatEvent({
          id: this.lastEventId,
          event: "bootstrap",
          data: sanitizeClientPayload(
            this.getBootstrap(),
            this.secrets,
          ),
        }),
      );
    }

    this.clients.add(response);
    const remove = (): void => {
      this.clients.delete(response);
    };
    request.on("close", remove);
    response.on("close", remove);
    return true;
  }

  publish(event: string, data: unknown): Promise<PersistedSseEvent> {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(event)) {
      return Promise.reject(
        new TypeError(
          "event must contain only letters, numbers, underscores, or hyphens",
        ),
      );
    }

    let published: PersistedSseEvent | undefined;
    const operation = this.publishQueue.then(async () => {
      await this.restore();
      published = {
        version: 1,
        id: this.lastEventId + 1,
        event,
        data: sanitizeClientPayload(data, this.secrets),
        createdAt: this.now(),
      };
      await this.storage.append(this.storageStream, published);
      this.lastEventId = published.id;
      this.buffer.push(published);
      this.trimBuffer();

      this.enqueueOutbound(formatEvent(this.forClient(published)));
    });

    this.publishQueue = operation.then(
      () => undefined,
      () => undefined,
    );

    return operation.then(() => {
      if (published === undefined) {
        throw new Error("SSE event was not published");
      }
      return { ...published };
    });
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getLastEventId(): number {
    return this.lastEventId;
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    await this.publishQueue;
    if (this.flushHandle !== undefined) {
      this.timer.clearTimeout(this.flushHandle);
      this.flushHandle = undefined;
    }
    this.flushOutbound();
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }

  /**
   * Batches client writes so a burst of publishes within `flushIntervalMs`
   * costs one socket write per client instead of one per event. The append
   * to storage and the buffer above still happen synchronously per publish,
   * so replay/resume behavior is unaffected — only the live write is
   * coalesced. `flushIntervalMs: 0` opts out and writes immediately.
   */
  private enqueueOutbound(formatted: string): void {
    if (this.flushIntervalMs === 0) {
      for (const client of this.clients) client.write(formatted);
      return;
    }
    this.pendingOutbound.push(formatted);
    if (this.flushHandle !== undefined) return;
    this.flushHandle = this.timer.setTimeout(() => {
      this.flushHandle = undefined;
      this.flushOutbound();
    }, this.flushIntervalMs);
  }

  private flushOutbound(): void {
    if (this.pendingOutbound.length === 0) return;
    const outbound = this.pendingOutbound.join("");
    this.pendingOutbound = [];
    for (const client of this.clients) {
      client.write(outbound);
    }
  }

  private async restoreFromStorage(): Promise<void> {
    const records = await this.storage.read<unknown>(this.storageStream);
    const restored = records
      .filter(isPersistedSseEvent)
      .sort((left, right) => left.id - right.id);
    const unique = new Map<number, PersistedSseEvent>();

    for (const event of restored) {
      unique.set(event.id, event);
    }

    this.buffer = [...unique.values()].slice(-this.bufferSize);
    this.lastEventId = restored.at(-1)?.id ?? 0;
  }

  private trimBuffer(): void {
    if (this.buffer.length > this.bufferSize) {
      this.buffer.splice(0, this.buffer.length - this.bufferSize);
    }
  }

  private forClient(event: PersistedSseEvent): PersistedSseEvent {
    return {
      ...event,
      event: sanitizeString(event.event, this.secrets),
      data: sanitizeClientPayload(event.data, this.secrets),
    };
  }
}
