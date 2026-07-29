import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import {
  createCollector,
  loadFixtureState,
  type Collector,
} from "./collector.ts";
import { CREDENTIAL_ENV_NAMES } from "./config.ts";
import { MemoryStorage } from "./storage.ts";
import type {
  RoundJobClock,
  RoundJobTimer,
} from "./roundJobs.ts";

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

  async nextEventOfType(eventName: string): Promise<ParsedSseEvent> {
    while (true) {
      const event = await this.nextEvent();
      if (event.event === eventName) return event;
    }
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

class ManualRoundTime implements RoundJobClock, RoundJobTimer {
  value = Date.parse("2026-07-28T00:00:00Z");
  private nextId = 1;
  private readonly timers = new Map<
    number,
    { callback: () => void; dueAt: number }
  >();

  now(): number {
    return this.value;
  }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, {
      callback,
      dueAt: this.value + delayMs,
    });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  advance(milliseconds: number): void {
    this.value += milliseconds;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.value)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.dueAt - right.dueAt || leftId - rightId,
        )[0];
      if (next === undefined) return;
      this.timers.delete(next[0]);
      next[1].callback();
    }
  }
}

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

    const health = await client.nextEventOfType("health");
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

    let lifecycleEnd = replayed;
    let previousId = replayed.id;
    while (
      (lifecycleEnd.data as { event?: { type?: string } }).event?.type !==
      "FIGHT_ENDED"
    ) {
      lifecycleEnd = await resumed.nextEvent();
      expect(lifecycleEnd.id).toBe(previousId + 1);
      previousId = lifecycleEnd.id;
    }
    expect(lifecycleEnd.data).toMatchObject({
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

  it("exposes metrics/review and accepts only strict manual mapping overrides", async () => {
    const { collector, port } = await startCollector();
    await collector.review.recordParserError({
      source: "sherdog",
      context: "fixture-review",
      error: new Error("invalid fixture markup"),
      localTimestamp: "2026-07-28T01:00:00Z",
    });

    const metricsResponse = await fetch(
      `http://127.0.0.1:${port}/api/metrics`,
    );
    expect(metricsResponse.status).toBe(200);
    await expect(metricsResponse.json()).resolves.toMatchObject({
      generatedAt: expect.any(String),
      sources: expect.any(Object),
    });

    const reviewResponse = await fetch(
      `http://127.0.0.1:${port}/api/review`,
    );
    expect(reviewResponse.status).toBe(200);
    await expect(reviewResponse.json()).resolves.toMatchObject({
      deadLetters: expect.any(Array),
      parserErrors: [
        expect.objectContaining({
          source: "sherdog",
          context: "fixture-review",
        }),
      ],
      ambiguousMappings: expect.any(Array),
    });

    const invalidResponse = await fetch(
      `http://127.0.0.1:${port}/api/mapping-override`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          internalBoutId: "bout-main",
          externalRef: { source: "espn", id: "manual-espn-id" },
          unsupported: true,
        }),
      },
    );
    expect(invalidResponse.status).toBe(400);

    const overrideResponse = await fetch(
      `http://127.0.0.1:${port}/api/mapping-override`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          internalBoutId: "bout-main",
          externalRef: { source: "espn", id: "manual-espn-id" },
        }),
      },
    );
    expect(overrideResponse.status).toBe(200);
    await expect(overrideResponse.json()).resolves.toMatchObject({
      mapping: {
        internalBoutId: "bout-main",
        manuallyVerified: true,
        mappingConfidence: 1,
        externalRefs: expect.arrayContaining([
          { source: "espn", id: "manual-espn-id" },
        ]),
      },
    });
  });

  it("leaves the lifecycle driver stopped by default in fixture mode", async () => {
    const { collector } = await startCollector();

    expect(collector.lifecycleDriver.isStarted()).toBe(false);
  });

  it("drives the lifecycle machine from the fixture provider once enabled, and stops cleanly on close", async () => {
    const time = new ManualRoundTime();
    const collector = await createCollector({
      env: { DATA_MODE: "fixture", COLLECTOR_PORT: "0" },
      storage: new MemoryStorage(),
      sse: { heartbeatMs: 50 },
      lifecycle: { enabled: true, clock: time, timer: time },
    });
    collectors.push(collector);

    await collector.start();
    expect(collector.lifecycleDriver.isStarted()).toBe(true);
    // The fixture bout-main is already "between-rounds" at round 2; the
    // first poll only establishes that baseline, so no events fire yet.
    expect(collector.lifecycle.getState("bout-main")).toMatchObject({
      state: "in",
      period: 2,
      clockSeconds: 0,
    });
    expect(collector.eventBus.getEventLog()).toEqual([]);

    time.advance(collector.config.pollingMs.espn);
    await collector.lifecycleDriver.idle();

    expect(collector.eventBus.getEventLog()).toEqual([
      expect.objectContaining({
        type: "PROVISIONAL_ROUND_ENDED",
        boutId: "bout-main",
        round: 2,
      }),
    ]);

    await collector.close();
    // Closing stops the poll loop; further time advances do nothing.
    time.advance(collector.config.pollingMs.espn * 5);
    expect(collector.eventBus.getEventLog()).toHaveLength(1);
  });

  it("starts and stops the collector-owned pre-event poller", async () => {
    const time = new ManualRoundTime();
    let syncCalls = 0;
    const collector = await createCollector({
      env: {
        DATA_MODE: "fixture",
        COLLECTOR_PORT: "0",
        PRE_EVENT_POLL_NON_EVENT_DAY_MS: "1000",
      },
      storage: new MemoryStorage(),
      sse: { heartbeatMs: 50 },
      preEventPoll: {
        enabled: true,
        clock: time,
        timer: time,
        runSync: async () => {
          syncCalls += 1;
        },
      },
    });
    collectors.push(collector);

    await collector.start();
    await collector.preEventPoller.idle();
    expect(collector.preEventPoller.isStarted()).toBe(true);
    expect(syncCalls).toBe(1);

    // The injected timer proves the collector armed the next slot rather than
    // running once at startup and going quiet.
    time.advance(1_000);
    await collector.preEventPoller.idle();
    expect(syncCalls).toBe(2);

    await collector.close();
    time.advance(10_000);
    await collector.preEventPoller.idle();
    expect(syncCalls).toBe(2);
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

  it("wires lifecycle round updates into persisted collector bootstrap state", async () => {
    const storage = new MemoryStorage();
    const first = await createCollector({
      env: { DATA_MODE: "fixture", COLLECTOR_PORT: "0" },
      storage,
    });
    collectors.push(first);

    await first.tickStore.appendTick({
      source: "kalshi",
      boutId: "bout-main",
      marketType: "fight-winner",
      outcome: "Danilo Reyes",
      bid: 58,
      ask: 60,
      receivedAt: "2026-07-28T00:59:58Z",
      sourceUpdatedAt: "2026-07-28T00:59:57Z",
      stale: false,
    });
    await first.tickStore.appendTick({
      source: "kalshi",
      boutId: "bout-main",
      marketType: "fight-winner",
      outcome: "Artem Volkov",
      bid: 40,
      ask: 42,
      receivedAt: "2026-07-28T00:59:58Z",
      sourceUpdatedAt: "2026-07-28T00:59:57Z",
      stale: false,
    });
    first.eventBus.emit({
      type: "PROVISIONAL_ROUND_ENDED",
      boutId: "bout-main",
      round: 1,
      detectedAt: "2026-07-28T01:00:00Z",
    });
    await first.tickStore.idle();
    await first.roundStats.idle();

    expect(first.getBootstrap().unifiedRounds).toEqual([
      expect.objectContaining({
        boutId: "bout-main",
        round: 1,
        endingSignal: "clock_zero_provisional",
        provisional: true,
        marketAtEnd: {
          kalshi: expect.objectContaining({
            source: "kalshi",
            boundaryType: "provisional",
            outcomes: expect.arrayContaining([
              expect.objectContaining({
                outcome: "Danilo Reyes",
                midpoint: 59,
              }),
            ]),
          }),
        },
      }),
    ]);
    expect(first.getBootstrap()).toMatchObject({
      latestMarkets: expect.arrayContaining([
        expect.objectContaining({
          source: "kalshi",
          outcome: "Danilo Reyes",
        }),
      ]),
      marketSnapshots: [
        expect.objectContaining({
          source: "kalshi",
          boundaryType: "provisional",
        }),
      ],
    });
    await expect(storage.read("sse-events")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "update",
          data: {
            kind: "round",
            record: expect.objectContaining({
              boutId: "bout-main",
              round: 1,
              provisional: true,
            }),
          },
        }),
        expect.objectContaining({
          event: "update",
          data: {
            kind: "market-snapshot",
            snapshot: expect.objectContaining({
              source: "kalshi",
              boundaryType: "provisional",
            }),
          },
        }),
      ]),
    );
    await first.close();

    const restored = await createCollector({
      env: { DATA_MODE: "fixture", COLLECTOR_PORT: "0" },
      storage,
    });
    collectors.push(restored);
    expect(restored.getBootstrap().unifiedRounds).toEqual([
      expect.objectContaining({
        boutId: "bout-main",
        round: 1,
        endingSignal: "clock_zero_provisional",
        marketAtEnd: {
          kalshi: expect.objectContaining({
            source: "kalshi",
            boundaryType: "provisional",
          }),
        },
      }),
    ]);
  });

  it("delivers Sherdog observations through unified bootstrap and SSE records", async () => {
    const storage = new MemoryStorage();
    const time = new ManualRoundTime();
    const collector = await createCollector({
      env: {
        DATA_MODE: "fixture",
        COLLECTOR_PORT: "0",
        SHERDOG_REQUEST_INTERVAL_MS: "1",
      },
      storage,
      roundStats: { clock: time, timer: time },
    });
    collectors.push(collector);

    collector.eventBus.emit({
      type: "PROVISIONAL_ROUND_ENDED",
      boutId: "bout-main",
      round: 1,
      detectedAt: "2026-07-28T00:00:00Z",
    });
    await collector.roundStats.idle();
    time.advance(15_000);
    await collector.sherdogJobs.idle();

    expect(collector.getBootstrap().unifiedRounds).toEqual([
      expect.objectContaining({
        boutId: "bout-main",
        round: 1,
        sherdog: expect.objectContaining({
          commentary: expect.stringContaining(
            "Reyes takes the center",
          ),
          parserVersion: expect.any(String),
          payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expertConsensus: {
          sherdog: expect.objectContaining({
            source: "sherdog",
          }),
        },
      }),
    ]);
    await expect(storage.read("sse-events")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: {
            kind: "round",
            record: expect.objectContaining({
              boutId: "bout-main",
              sherdog: expect.objectContaining({ round: 1 }),
            }),
          },
        }),
      ]),
    );
  });

  it("keeps the live Sherdog transport fail-closed without permission and wires it when permitted", async () => {
    const liveEnv = Object.fromEntries(
      CREDENTIAL_ENV_NAMES.filter((name) => name !== "X_BEARER_TOKEN").map(
        (name) => [name, `secret-${name}`],
      ),
    );
    const stateLoader = async () => {
      const state = await loadFixtureState();
      const fixtureBout = state.event.bouts.find(
        (candidate) => candidate.id === "bout-main",
      );
      const fixtureView = state.boutViews["bout-main"];
      if (fixtureBout === undefined || fixtureView === undefined) {
        throw new Error("Missing fixture main bout");
      }
      const mappedBout = {
        ...fixtureBout,
        externalRefs: [
          ...fixtureBout.externalRefs,
          {
            source: "sherdog" as const,
            id: "/news/news/live-card",
          },
        ],
      };
      return {
        ...state,
        event: {
          ...state.event,
          bouts: state.event.bouts.map((candidate) =>
            candidate.id === mappedBout.id ? mappedBout : candidate,
          ),
        },
        boutViews: {
          ...state.boutViews,
          "bout-main": { ...fixtureView, bout: mappedBout },
        },
      };
    };

    const blockedFetch = vi.fn<typeof fetch>();
    const blockedCollector = await createCollector({
      env: {
        ...liveEnv,
        DATA_MODE: "live",
        COLLECTOR_PORT: "0",
        CITO_API_BASE_URL: "https://cito.example.invalid/api/v1",
        SHERDOG_PERMISSION_SCOPE: "none",
        LIFECYCLE_DRIVER_ENABLED: "false",
        PRE_EVENT_POLL_ENABLED: "false",
      },
      storage: new MemoryStorage(),
      stateLoader,
      market: { transports: [] },
      sherdog: { fetchImpl: blockedFetch },
    });
    collectors.push(blockedCollector);
    blockedCollector.eventBus.emit({
      type: "FIGHT_ENDED",
      boutId: "bout-main",
      round: 1,
      detectedAt: "2026-07-28T00:00:00Z",
    });
    await blockedCollector.sherdogJobs.idle();
    expect(blockedFetch).not.toHaveBeenCalled();

    const liveFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          "<article><h3>Round 1</h3><p>Collector live transport</p><p>Sherdog scores the round 10-9 Reyes.</p></article>",
          { status: 200 },
        ),
      );
    const liveTime = new ManualRoundTime();
    const liveCollector = await createCollector({
      env: {
        ...liveEnv,
        DATA_MODE: "live",
        COLLECTOR_PORT: "0",
        CITO_API_BASE_URL: "https://cito.example.invalid/api/v1",
        SHERDOG_PERMISSION_SCOPE: "sherdog-read",
        LIFECYCLE_DRIVER_ENABLED: "false",
        PRE_EVENT_POLL_ENABLED: "false",
      },
      storage: new MemoryStorage(),
      stateLoader,
      market: { transports: [] },
      roundStats: { clock: liveTime, timer: liveTime },
      sherdog: {
        fetchImpl: liveFetch,
        baseUrl: "https://sherdog.example.invalid",
      },
    });
    collectors.push(liveCollector);
    liveCollector.eventBus.emit({
      type: "FIGHT_ENDED",
      boutId: "bout-main",
      round: 1,
      detectedAt: "2026-07-28T00:00:00Z",
    });
    await liveCollector.sherdogJobs.idle();
    liveTime.advance(0);
    await liveCollector.sherdogJobs.idle();

    expect(
      liveCollector.roundStats.scheduler.getJobs().find(
        (job) => job.jobType === "sherdog_final",
      ),
    ).toMatchObject({ status: "completed" });
    expect(liveFetch).toHaveBeenCalledWith(
      "https://sherdog.example.invalid/news/news/live-card",
      expect.objectContaining({
        headers: {
          "User-Agent":
            "UFC Live Dashboard/1.0 (personal non-commercial dashboard)",
        },
      }),
    );
  });

  it("wires configured manual X score links into the unified round", async () => {
    const collector = await createCollector({
      env: {
        DATA_MODE: "fixture",
        COLLECTOR_PORT: "0",
        X_MODE: "manual",
        X_MANUAL_SCORES_JSON: JSON.stringify([
          {
            boutId: "bout-main",
            sourcePostId: "12345",
            scorer: "MMAJunkie",
            round: 1,
            score: { red: 10, blue: 9 },
            postUrl: "https://x.com/MMAJunkie/status/12345",
          },
        ]),
      },
      storage: new MemoryStorage(),
    });
    collectors.push(collector);

    collector.eventBus.emit({
      type: "ROUND_ENDED",
      boutId: "bout-main",
      round: 1,
      detectedAt: "2026-07-28T00:00:00Z",
      confirmation: "period_transition",
    });
    await collector.xJobs.idle();

    expect(
      collector.roundStats.getUnifiedRound("bout-main", 1),
    ).toMatchObject({
      xScores: [
        {
          source: "x",
          sourcePostId: "12345",
          mode: "manual",
          postUrl: "https://x.com/MMAJunkie/status/12345",
        },
      ],
      expertConsensus: {
        x: expect.objectContaining({ source: "x", leader: "red" }),
      },
    });
  });
});
