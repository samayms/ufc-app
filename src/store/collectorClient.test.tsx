import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_ENV_NAMES } from "../../server/config.ts";
import { DeliveryFreshness } from "../ui/DeliveryFreshness.tsx";
import { SourceStatus } from "../ui/SourceStatus.tsx";
import {
  createCollectorClient,
  getCollectorRoundDelivery,
} from "./collectorClient.ts";
import {
  assembleDashboard,
  resolveDashboardData,
} from "./useDashboard.ts";

class MockEventSource {
  static latest: MockEventSource | undefined;

  readonly listeners = new Map<string, EventListener[]>();

  onopen: ((event: Event) => void) | null = null;

  onerror: ((event: Event) => void) | null = null;

  closed = false;

  constructor(readonly url: string) {
    MockEventSource.latest = this;
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: unknown): void {
    const event = {
      data: JSON.stringify(data),
    } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  close(): void {
    this.closed = true;
  }
}

function bootstrapResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function roundRecord(provisional: boolean, revision: number) {
  return {
    boutId: "bout-main",
    round: 2,
    detectedEndedAt: "2026-07-28T01:02:03Z",
    endingSignal: provisional
      ? "clock_zero_provisional"
      : "period_transition",
    citoStats: {
      boutId: "bout-main",
      round: 2,
      fighterA: {
        significantStrikes: revision === 1 ? 40 : 42,
        totalStrikes: 52,
        takedowns: 1,
        takedownsAttempted: 3,
        controlTimeSeconds: 48,
        knockdowns: 0,
      },
      fighterB: {
        significantStrikes: 31,
        totalStrikes: 46,
        takedowns: 0,
        takedownsAttempted: 1,
        controlTimeSeconds: 17,
        knockdowns: 0,
      },
      provisional,
      revision,
      sourceUpdatedAt: "2026-07-28T01:02:00Z",
      firstObservedAt: "2026-07-28T01:02:04Z",
      lastObservedAt: `2026-07-28T01:02:0${revision + 3}Z`,
    },
    sherdog: {
      boutId: "bout-main",
      round: 2,
      commentary: "Collector-delivered commentary.",
      scorerCards: [
        {
          scorer: "Sherdog",
          winner: "Volkov",
          roundScore: "10-9",
        },
      ],
      sourceUrl: "https://www.sherdog.com/news/fixture",
      publishedAt: "2026-07-28T01:02:02Z",
      fetchedAt: "2026-07-28T01:02:05Z",
      parserVersion: "test",
      payloadHash: `hash-${revision}`,
    },
    xScores: [
      {
        source: "x",
        sourcePostId: "12345",
        scorer: "MMAJunkie",
        round: 2,
        score: { red: 9, blue: 10 },
        fetchedAt: "2026-07-28T01:02:40Z",
        parseConfidence: 1,
        mode: "embed",
        postUrl: "https://x.com/MMAJunkie/status/12345",
      },
    ],
    expertConsensus: {
      sherdog: {
        source: "sherdog",
        redVotes: 0,
        blueVotes: 1,
        drawVotes: 0,
        total: 1,
        leader: "blue",
      },
      x: {
        source: "x",
        redVotes: 0,
        blueVotes: 1,
        drawVotes: 0,
        total: 1,
        leader: "blue",
      },
    },
    marketAtEnd: {},
    provisional,
    ...(provisional
      ? {}
      : { finalizedAt: "2026-07-28T01:02:06Z" }),
  };
}

describe("collector browser client", () => {
  it("keeps the fixture dashboard unchanged when the collector is unavailable", async () => {
    const fixture = await assembleDashboard();
    const client = createCollectorClient({
      baseUrl: "http://collector.test",
      fetch: async () => {
        throw new TypeError("collector offline");
      },
      createEventSource: (url) => new MockEventSource(url),
    });

    await client.start();
    const snapshot = client.getSnapshot();

    expect(snapshot.connection).toBe("unavailable");
    expect(snapshot.dashboard).toBeNull();
    expect(resolveDashboardData(fixture, snapshot)).toBe(fixture);

    const sources = renderToStaticMarkup(
      <SourceStatus state={fixture} collector={snapshot} />,
    );
    expect(sources).toContain("Fixture data");
    expect(sources).toContain("Collector unavailable");
    client.close();
  });

  it("hydrates lifecycle, unified rounds, and health from bootstrap plus SSE", async () => {
    const fixture = await assembleDashboard();
    let tick = 0;
    const receivedTimes = [
      "2026-07-28T01:00:00Z",
      "2026-07-28T01:00:01Z",
      "2026-07-28T01:00:02Z",
      "2026-07-28T01:00:03Z",
      "2026-07-28T01:00:04Z",
    ];
    const client = createCollectorClient({
      baseUrl: "http://collector.test/",
      fetch: async () =>
        bootstrapResponse({
          state: fixture,
          boutMappings: [],
          health: {
            cito: {
              source: "cito",
              status: "healthy",
              fresh: true,
              checkedAt: "2026-07-28T00:59:59Z",
              sourceUpdatedAt: "2026-07-28T00:59:58Z",
            },
          },
          unifiedRounds: [roundRecord(true, 1)],
        }),
      createEventSource: (url) => new MockEventSource(url),
      now: () => receivedTimes[tick++] ?? receivedTimes.at(-1)!,
    });

    await client.start();
    const events = MockEventSource.latest;
    expect(events?.url).toBe("http://collector.test/api/events");
    events?.open();
    const bootstrapped = client.getSnapshot();
    expect(
      bootstrapped.dashboard?.boutViews["bout-main"]?.bout,
    ).toMatchObject({
      status: "between-rounds",
      currentRound: 2,
    });
    expect(
      bootstrapped.dashboard?.boutViews["bout-main"]?.rounds.cito
        ?.find((update) => update.round === 2)
        ?.stats?.red?.significantStrikes,
    ).toBe(40);
    expect(
      bootstrapped.dashboard?.boutViews["bout-main"]?.rounds.sherdog
        ?.find((update) => update.round === 2)?.summary,
    ).toBe("Collector-delivered commentary.");
    expect(
      bootstrapped.dashboard?.boutViews["bout-main"]?.scorecards,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ postId: "12345", round: 2 }),
      ]),
    );
    expect(bootstrapped.unifiedRounds[0]?.expertConsensus).toMatchObject({
      sherdog: { source: "sherdog" },
      x: { source: "x" },
    });
    expect(
      getCollectorRoundDelivery(bootstrapped, "bout-main", 2),
    ).toMatchObject({
      provisional: true,
      revision: 1,
    });

    events?.emit("update", {
      kind: "lifecycle",
      event: {
        type: "ROUND_ENDED",
        boutId: "bout-main",
        round: 2,
        detectedAt: "2026-07-28T01:02:03Z",
        confirmation: "period_transition",
      },
    });
    events?.emit("health", {
      source: "cito",
      status: "stale",
      fresh: false,
      checkedAt: "2026-07-28T01:03:00Z",
      sourceUpdatedAt: "2026-07-28T01:02:00Z",
      message: "Awaiting a corrected round",
    });

    const snapshot = client.getSnapshot();
    const bout = snapshot.dashboard?.boutViews["bout-main"];
    const round = bout?.rounds.cito?.find((update) => update.round === 2);

    expect(snapshot.connection).toBe("connected");
    expect(bout?.bout).toMatchObject({
      status: "between-rounds",
      currentRound: 2,
    });
    expect(round?.stats?.red?.significantStrikes).toBe(40);
    expect(snapshot.health.cito).toMatchObject({
      status: "stale",
      fresh: false,
    });
    expect(snapshot.lifecycle["bout-main"]).toMatchObject({
      source: "collector lifecycle",
      provisional: false,
    });

    const provisional = getCollectorRoundDelivery(
      snapshot,
      "bout-main",
      2,
    );
    expect(provisional).toMatchObject({
      source: "Cito",
      stale: true,
      provisional: true,
      revision: 1,
    });
    const provisionalMarkup = renderToStaticMarkup(
      <DeliveryFreshness delivery={provisional!} />,
    );
    expect(provisionalMarkup).toContain("source");
    expect(provisionalMarkup).toContain("received");
    expect(provisionalMarkup).toContain("Provisional");
    expect(provisionalMarkup).toContain("rev 1");
    expect(provisionalMarkup).toContain("Stale");

    events?.emit("update", {
      kind: "round",
      record: roundRecord(false, 2),
    });
    const finalized = getCollectorRoundDelivery(
      client.getSnapshot(),
      "bout-main",
      2,
    );
    const finalMarkup = renderToStaticMarkup(
      <DeliveryFreshness delivery={finalized!} />,
    );
    expect(finalMarkup).toContain("Final");
    expect(finalMarkup).toContain("rev 2");
    expect(finalMarkup).not.toContain("Provisional");
    expect(
      client
        .getSnapshot()
        .dashboard?.boutViews["bout-main"]
        ?.rounds.cito?.find((update) => update.round === 2)
        ?.stats?.red?.significantStrikes,
    ).toBe(42);
    client.close();
    expect(events?.closed).toBe(true);
  });

  it("contains no server credential environment names in browser entry source", async () => {
    const browserSources = await Promise.all(
      [
        "src/store/collectorClient.ts",
        "src/store/useDashboard.ts",
        "src/App.tsx",
      ].map((path) => readFile(path, "utf8")),
    );
    const source = browserSources.join("\n");

    for (const credentialName of CREDENTIAL_ENV_NAMES) {
      expect(source).not.toContain(credentialName);
    }
  });
});
