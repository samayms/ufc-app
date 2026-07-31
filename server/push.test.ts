import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SsePush } from "./push.ts";
import { MemoryStorage } from "./storage.ts";

class FakeRequest {
  method = "GET";

  url = "/api/events";

  headers: Record<string, string | string[] | undefined> = {};

  private closeListener: (() => void) | undefined;

  on(_event: "close", listener: () => void): this {
    this.closeListener = listener;
    return this;
  }

  close(): void {
    this.closeListener?.();
  }
}

class FakeResponse {
  headersSent = false;

  readonly chunks: string[] = [];

  status = 0;

  private closeListener: (() => void) | undefined;

  writeHead(statusCode: number): this {
    this.status = statusCode;
    this.headersSent = true;
    return this;
  }

  flushHeaders(): void {
    this.headersSent = true;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(chunk?: string): void {
    if (chunk !== undefined) this.chunks.push(chunk);
    this.closeListener?.();
  }

  on(_event: "close", listener: () => void): this {
    this.closeListener = listener;
    return this;
  }
}

function request(
  lastEventId?: number,
): {
  request: FakeRequest;
  response: FakeResponse;
} {
  const incoming = new FakeRequest();
  if (lastEventId !== undefined) {
    incoming.headers["last-event-id"] = String(lastEventId);
  }

  return { request: incoming, response: new FakeResponse() };
}

function contents(response: FakeResponse): string {
  return response.chunks.join("");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SsePush", () => {
  it("bootstraps and broadcasts sanitized updates to multiple clients", async () => {
    const storage = new MemoryStorage();
    const push = new SsePush({
      storage,
      getBootstrap: () => ({ state: { id: "fixture" } }),
      secrets: ["collector-secret"],
      heartbeatMs: 60_000,
      flushIntervalMs: 0,
    });
    const first = request();
    const second = request();

    await push.handle(
      first.request as unknown as IncomingMessage,
      first.response as unknown as ServerResponse,
    );
    await push.handle(
      second.request as unknown as IncomingMessage,
      second.response as unknown as ServerResponse,
    );
    await push.publish("update", {
      message: "value=collector-secret",
      authDetails: { token: "collector-secret" },
    });

    expect(contents(first.response)).toContain("event: bootstrap");
    expect(contents(first.response)).toContain('"id":"fixture"');
    expect(contents(first.response)).toContain("event: update");
    expect(contents(second.response)).toContain("event: update");
    expect(contents(first.response)).toContain("[REDACTED]");
    expect(contents(first.response)).not.toContain("collector-secret");
    expect(contents(first.response)).not.toContain("authDetails");

    const persisted = JSON.stringify(await storage.read("sse-events"));
    expect(persisted).not.toContain("collector-secret");
    await push.close();
  });

  it("replays only IDs after Last-Event-ID and remains duplicate-safe", async () => {
    const push = new SsePush({
      storage: new MemoryStorage(),
      getBootstrap: () => ({ state: "current" }),
      heartbeatMs: 60_000,
      flushIntervalMs: 0,
    });
    await push.restore();
    await push.publish("update", { sequence: 1 });
    await push.publish("health", { sequence: 2 });
    const resumed = request(1);

    await push.handle(
      resumed.request as unknown as IncomingMessage,
      resumed.response as unknown as ServerResponse,
    );

    const replay = contents(resumed.response);
    expect(replay).not.toContain("event: bootstrap");
    expect(replay).not.toContain('"sequence":1');
    expect(replay).toContain("id: 2");
    expect(replay).toContain('"sequence":2');

    const caughtUp = request(2);
    await push.handle(
      caughtUp.request as unknown as IncomingMessage,
      caughtUp.response as unknown as ServerResponse,
    );
    expect(contents(caughtUp.response)).toBe("");

    await push.publish("update", { sequence: 3 });
    expect(contents(caughtUp.response)).toContain("id: 3");
    expect(contents(caughtUp.response)).not.toContain('"sequence":2');
    await push.close();
  });

  it("restores monotonic replay and bootstraps out-of-window clients", async () => {
    const storage = new MemoryStorage();
    const first = new SsePush({
      storage,
      getBootstrap: () => ({ revision: 1 }),
      bufferSize: 2,
      heartbeatMs: 60_000,
      flushIntervalMs: 0,
    });
    await first.publish("update", { sequence: 1 });
    await first.publish("update", { sequence: 2 });
    await first.publish("update", { sequence: 3 });
    await first.close();

    const second = new SsePush({
      storage,
      getBootstrap: () => ({ revision: 2 }),
      bufferSize: 2,
      heartbeatMs: 60_000,
      flushIntervalMs: 0,
    });
    await second.restore();
    expect(second.getLastEventId()).toBe(3);

    const resumable = request(2);
    await second.handle(
      resumable.request as unknown as IncomingMessage,
      resumable.response as unknown as ServerResponse,
    );
    expect(contents(resumable.response)).toContain("id: 3");
    expect(contents(resumable.response)).not.toContain("bootstrap");

    const tooOld = request(0);
    await second.handle(
      tooOld.request as unknown as IncomingMessage,
      tooOld.response as unknown as ServerResponse,
    );
    expect(contents(tooOld.response)).toContain("id: 3");
    expect(contents(tooOld.response)).toContain("event: bootstrap");
    expect(contents(tooOld.response)).toContain('"revision":2');
    await second.close();
  });

  it("emits heartbeat comments without consuming event IDs", async () => {
    vi.useFakeTimers();
    const push = new SsePush({
      storage: new MemoryStorage(),
      getBootstrap: () => ({ state: "fixture" }),
      heartbeatMs: 100,
      now: () => "2026-07-28T01:02:03Z",
    });
    const client = request();
    await push.handle(
      client.request as unknown as IncomingMessage,
      client.response as unknown as ServerResponse,
    );

    vi.advanceTimersByTime(100);

    expect(contents(client.response)).toContain(
      ": heartbeat 2026-07-28T01:02:03Z",
    );
    expect(push.getLastEventId()).toBe(0);
    await push.close();
  });

  it("batches client writes to at most one flush per flushIntervalMs", async () => {
    vi.useFakeTimers();
    const push = new SsePush({
      storage: new MemoryStorage(),
      getBootstrap: () => ({ state: "fixture" }),
      heartbeatMs: 60_000,
      flushIntervalMs: 500,
    });
    const client = request();
    await push.handle(
      client.request as unknown as IncomingMessage,
      client.response as unknown as ServerResponse,
    );

    // handle() writes the connect-time bootstrap immediately (it's a
    // one-time, per-client message, not part of the broadcast batch).
    expect(client.response.chunks).toHaveLength(1);

    await Promise.all([
      push.publish("update", { sequence: 1 }),
      push.publish("update", { sequence: 2 }),
    ]);

    // Both events are durably appended immediately, but neither has reached
    // the client's socket yet — the flush is still pending.
    expect(client.response.chunks).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);

    expect(client.response.chunks).toHaveLength(2);
    expect(contents(client.response)).toContain('"sequence":1');
    expect(contents(client.response)).toContain('"sequence":2');

    const third = push.publish("update", { sequence: 3 });
    await vi.advanceTimersByTimeAsync(500);
    await third;
    expect(client.response.chunks).toHaveLength(3);

    await push.close();
  });
});
