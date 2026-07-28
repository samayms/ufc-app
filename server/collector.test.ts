import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import {
  createCollector,
  loadFixtureState,
  type Collector,
} from "./collector.ts";
import { CREDENTIAL_ENV_NAMES } from "./config.ts";
import { MemoryStorage } from "./storage.ts";

interface ParsedSseEvent {
  id: number;
  event: string;
  data: unknown;
  raw: string;
}

class TestSseClient {
  private readonly controller: AbortController;

  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  private readonly decoder = new TextDecoder();

  private buffer = "";

  constructor(
    controller: AbortController,
    response: Response,
  ) {
    this.controller = controller;
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("SSE response had no body");
    }
    this.reader = reader;
  }

  async nextEvent(): Promise<ParsedSseEvent> {
    const event = await Promise.race([
      this.readEvent(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for SSE")), 3000);
      }),
    ]);
    return event;
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.reader.cancel().catch(() => undefined);
  }

  private async readEvent(): Promise<ParsedSseEvent> {
    while (true) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const frame = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        const parsed = this.parseFrame(frame);
        if (parsed !== null) return parsed;
        continue;
      }

      const chunk = await this.reader.read();
      if (chunk.done) {
        throw new Error("SSE stream ended before an event arrived");
      }
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  private parseFrame(frame: string): ParsedSseEvent | null {
    if (
      frame.trim().length === 0 ||
      frame
        .split("\n")
        .every((line) => line.startsWith(":"))
    ) {
      return null;
    }

    let id: number | undefined;
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("id:")) id = Number(line.slice(3).trim());
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }

    if (id === undefined || !Number.isSafeInteger(id)) {
      throw new Error(`Invalid SSE event: ${frame}`);
    }

    return {
      id,
      event,
      data: JSON.parse(data.join("\n")) as unknown,
      raw: frame,
    };
  }
}

const collectors: Collector[] = [];
const clients: TestSseClient[] = [];

async function canBindLocalhost(): Promise<boolean> {
  const server = createServer((_request, response) => {
    response.end();
  });

  return new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(0, "127.0.0.1");
  });
}

const localhostAvailable = await canBindLocalhost();

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    collectors.splice(0).map((collector) => collector.close()),
  );
});

async function startCollector(
  storage = new MemoryStorage(),
  extraEnv: Record<string, string> = {},
): Promise<{ collector: Collector; port: number }> {
  const collector = await createCollector({
    env: {
      DATA_MODE: "fixture",
      COLLECTOR_PORT: "0",
      ...extraEnv,
    },
    storage,
    sse: { heartbeatMs: 50 },
  });
  collectors.push(collector);
  return { collector, port: await collector.start() };
}

async function connectSse(
  port: number,
  lastEventId?: number,
): Promise<TestSseClient> {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
    headers:
      lastEventId === undefined
        ? {}
        : { "Last-Event-ID": String(lastEventId) },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain(
    "text/event-stream",
  );
  const client = new TestSseClient(controller, response);
  clients.push(client);
  return client;
}

describe.skipIf(!localhostAvailable)(
  "collector SSE and REST delivery",
  () => {
  it("sends a normalized last-known-state bootstrap", async () => {
    const { port } = await startCollector();
    const client = await connectSse(port);
    const event = await client.nextEvent();

    expect(event.event).toBe("bootstrap");
    expect(event.id).toBeGreaterThan(0);
    expect(event.data).toMatchObject({
      state: {
        event: { id: "evt-fixture-001" },
        boutViews: {
          "bout-main": {
            rounds: {
              espn: expect.any(Array),
              cito: expect.any(Array),
              sherdog: expect.any(Array),
            },
          },
        },
      },
      boutMappings: expect.arrayContaining([
        expect.objectContaining({
          internalBoutId: "bout-main",
          mappingConfidence: 1,
          externalRefs: expect.arrayContaining([
            { source: "espn", id: "401770001" },
            { source: "cito", id: "cito-bout-9001" },
          ]),
        }),
      ]),
      health: {
        espn: { status: "healthy", fresh: true },
      },
    });
  });

  it("delivers event-bus updates and health/freshness changes", async () => {
    const { collector, port } = await startCollector();
    const client = await connectSse(port);
    await client.nextEvent();

    collector.eventBus.emit({
      type: "ROUND_ENDED",
      boutId: "bout-main",
      round: 2,
      detectedAt: "2026-07-28T01:02:03Z",
      confirmation: "period_transition",
    });
    const update = await client.nextEvent();

    expect(update.event).toBe("update");
    expect(update.data).toEqual({
      kind: "lifecycle",
      event: {
        type: "ROUND_ENDED",
        boutId: "bout-main",
        round: 2,
        detectedAt: "2026-07-28T01:02:03Z",
        confirmation: "period_transition",
      },
    });

    await expect(
      collector.publishHealth({
        source: "espn",
        status: "stale",
        fresh: false,
        checkedAt: "2026-07-28T01:03:00Z",
        sourceUpdatedAt: "2026-07-28T01:00:00Z",
        message: "No update inside the lifecycle threshold",
      }),
    ).resolves.toBe(true);

    const health = await client.nextEvent();
    expect(health.event).toBe("health");
    expect(health.data).toMatchObject({
      source: "espn",
      status: "stale",
      fresh: false,
    });
  });

  it("resumes strictly after Last-Event-ID without duplicates", async () => {
    const { collector, port } = await startCollector();
    const firstClient = await connectSse(port);
    const bootstrap = await firstClient.nextEvent();

    collector.eventBus.emit({
      type: "FIGHT_STARTED",
      boutId: "bout-main",
      detectedAt: "2026-07-28T01:00:00Z",
    });
    const firstUpdate = await firstClient.nextEvent();
    await firstClient.close();

    collector.eventBus.emit({
      type: "FIGHT_ENDED",
      boutId: "bout-main",
      round: 3,
      detectedAt: "2026-07-28T01:15:00Z",
    });

    const resumed = await connectSse(port, firstUpdate.id);
    const replayed = await resumed.nextEvent();

    expect(firstUpdate.id).toBeGreaterThan(bootstrap.id);
    expect(replayed.id).toBe(firstUpdate.id + 1);
    expect(replayed.data).toMatchObject({
      event: { type: "FIGHT_ENDED" },
    });
  });

  it("restores the replay sequence from storage after restart", async () => {
    const storage = new MemoryStorage();
    const first = await startCollector(storage);
    const client = await connectSse(first.port);
    const bootstrap = await client.nextEvent();

    first.collector.eventBus.emit({
      type: "FIGHT_STARTED",
      boutId: "bout-main",
      detectedAt: "2026-07-28T01:00:00Z",
    });
    const update = await client.nextEvent();
    await client.close();
    await first.collector.close();

    const second = await startCollector(storage);
    const resumed = await connectSse(second.port, bootstrap.id);
    const replayed = await resumed.nextEvent();

    expect(replayed.id).toBe(update.id);
    expect(replayed.event).toBe("update");
    expect(replayed.data).toMatchObject({
      event: { type: "FIGHT_STARTED" },
    });
  });

  it("keeps configured credentials out of serialized SSE and REST", async () => {
    const credentialEnv = Object.fromEntries(
      CREDENTIAL_ENV_NAMES.map((name) => [
        name,
        `never-send-${name.toLowerCase()}`,
      ]),
    );
    const secretValues = Object.values(credentialEnv);
    const { collector, port } = await startCollector(
      new MemoryStorage(),
      credentialEnv,
    );
    const client = await connectSse(port);
    const bootstrap = await client.nextEvent();

    await collector.push.publish("update", {
      note: secretValues.join(" "),
      authorization: credentialEnv.CITO_API_KEY,
      nested: { token: credentialEnv.X_BEARER_TOKEN },
    });
    const update = await client.nextEvent();
    const bootstrapResponse = await fetch(
      `http://127.0.0.1:${port}/api/bootstrap`,
    );
    const healthResponse = await fetch(
      `http://127.0.0.1:${port}/api/health`,
    );
    const serialized = [
      bootstrap.raw,
      update.raw,
      await bootstrapResponse.text(),
      await healthResponse.text(),
    ].join("\n");

    for (const secret of secretValues) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain('"token"');
    expect(update.raw).toContain("[REDACTED]");
  });
  },
);

describe("fixture collector loading", () => {
  it("is deterministic and performs no network calls", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("external network forbidden"));

    const first = await loadFixtureState();
    const second = await loadFixtureState();

    expect(second).toEqual(first);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("persists and restores bout mappings in bootstrap state", async () => {
    const storage = new MemoryStorage();
    const first = await createCollector({
      env: { DATA_MODE: "fixture", COLLECTOR_PORT: "0" },
      storage,
    });
    collectors.push(first);
    await first.boutMappings.matchDiscoveredBout({
      externalRef: {
        source: "polymarket",
        id: "condition-main",
      },
      redFighter: "Danilo Reyes",
      blueFighter: "Artem Volkov",
    });

    expect(first.getBootstrap().boutMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          internalBoutId: "bout-main",
          mappingConfidence: 0.95,
          externalRefs: expect.arrayContaining([
            {
              source: "polymarket",
              id: "condition-main",
            },
          ]),
        }),
      ]),
    );
    await first.close();

    const restored = await createCollector({
      env: { DATA_MODE: "fixture", COLLECTOR_PORT: "0" },
      storage,
    });
    collectors.push(restored);

    expect(
      restored.boutMappings.findInternalBoutId(
        "polymarket",
        "condition-main",
      ),
    ).toBe("bout-main");
    expect(restored.getBootstrap().boutMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          internalBoutId: "bout-main",
          mappingConfidence: 0.95,
        }),
      ]),
    );
  });
});
