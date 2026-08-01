import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_ENV_NAMES } from "../../server/config.ts";
import { DeliveryFreshness } from "../ui/DeliveryFreshness.tsx";
import { SourceStatus } from "../ui/SourceStatus.tsx";
import {
  collectorBaseUrl,
  createCollectorClient,
  getCollectorMarketDelivery,
  getCollectorRoundDelivery,
  shouldAdoptClockSync,
  type CollectorClockSync,
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

function roundRecord(
  provisional: boolean,
  revision: number,
  aiSummary?: string,
) {
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
      ...(aiSummary === undefined ? {} : { aiSummary }),
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
  it("uses same-origin collector routes in production", () => {
    expect(collectorBaseUrl(undefined, true)).toBe("");
    expect(collectorBaseUrl("https://collector.test/", true)).toBe(
      "https://collector.test",
    );
  });

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
    // Never having received real data yet is a loading state — the fixture
    // is a reasonable instant-paint placeholder for it.
    expect(resolveDashboardData(fixture, snapshot, false)).toBe(fixture);
    // Production must never show a fake card while waiting for live data.
    expect(resolveDashboardData(fixture, snapshot, false, false)).toBeNull();
    // Once the collector delivered real data at least once, a later null
    // must never fall back to the fixture — that would show fake prices as
    // though they were live.
    expect(resolveDashboardData(fixture, snapshot, true)).toBeNull();

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
    expect(bootstrapped.unifiedRounds[0]?.expertConsensus).toMatchObject({
      sherdog: { source: "sherdog" },
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

  it("hydrates and refreshes ESPN clock synchronization points", async () => {
    const fixture = await assembleDashboard();
    let nowCall = 0;
    const receivedTimes = [
      "2026-07-28T01:00:01Z",
      "2026-07-28T01:00:06Z",
    ];
    const client = createCollectorClient({
      baseUrl: "http://collector.test",
      fetch: async () =>
        bootstrapResponse({
          state: fixture,
          boutMappings: [],
          health: {},
          unifiedRounds: [],
          lifecycleObservations: [
            {
              boutId: "bout-main",
              source: "espn",
              state: "in",
              period: 2,
              completed: false,
              clockSeconds: 197,
              receivedAt: "2026-07-28T01:00:00Z",
            },
          ],
        }),
      createEventSource: (url) => new MockEventSource(url),
      now: () => receivedTimes[nowCall++] ?? receivedTimes.at(-1)!,
    });

    await client.start();
    expect(client.getSnapshot().clocks["bout-main"]).toEqual({
      boutId: "bout-main",
      source: "espn",
      state: "in",
      period: 2,
      completed: false,
      clockSeconds: 197,
      sourceReceivedAt: "2026-07-28T01:00:00Z",
      receivedAt: "2026-07-28T01:00:01Z",
    });
    expect(
      client.getSnapshot().dashboard?.boutViews["bout-main"]?.bout,
    ).toMatchObject({
      status: "in-round",
      currentRound: 2,
    });

    MockEventSource.latest?.emit("update", {
      kind: "lifecycle-observations",
      observations: [
        {
          boutId: "bout-main",
          source: "espn",
          state: "in",
          period: 2,
          completed: false,
          clockSeconds: 192,
          receivedAt: "2026-07-28T01:00:05Z",
        },
      ],
    });

    expect(client.getSnapshot().clocks["bout-main"]).toMatchObject({
      source: "espn",
      period: 2,
      clockSeconds: 192,
      sourceReceivedAt: "2026-07-28T01:00:05Z",
      receivedAt: "2026-07-28T01:00:06Z",
    });
    client.close();
  });

  it("renders the model's summary in place of the raw play-by-play", async () => {
    const fixture = await assembleDashboard();
    const client = createCollectorClient({
      baseUrl: "http://collector.test/",
      fetch: async () =>
        bootstrapResponse({
          state: fixture,
          boutMappings: [],
          health: {},
          unifiedRounds: [
            roundRecord(false, 1, "Volkov takes the round behind the jab."),
          ],
        }),
      createEventSource: (url) => new MockEventSource(url),
      now: () => "2026-07-28T01:00:00Z",
    });

    await client.start();
    MockEventSource.latest?.open();

    expect(
      client
        .getSnapshot()
        .dashboard?.boutViews["bout-main"]?.rounds.sherdog?.find(
          (update) => update.round === 2,
        )?.summary,
    ).toBe("Volkov takes the round behind the jab.");
  });

  it("falls back to the raw play-by-play when no summary was produced", async () => {
    const fixture = await assembleDashboard();
    const client = createCollectorClient({
      baseUrl: "http://collector.test/",
      fetch: async () =>
        bootstrapResponse({
          state: fixture,
          boutMappings: [],
          health: {},
          unifiedRounds: [roundRecord(false, 1)],
        }),
      createEventSource: (url) => new MockEventSource(url),
      now: () => "2026-07-28T01:00:00Z",
    });

    await client.start();
    MockEventSource.latest?.open();

    expect(
      client
        .getSnapshot()
        .dashboard?.boutViews["bout-main"]?.rounds.sherdog?.find(
          (update) => update.round === 2,
        )?.summary,
    ).toBe("Collector-delivered commentary.");
  });

  it("hydrates latestOdds from bootstrap latestMarkets, replacing fixture odds", async () => {
    const fixture = await assembleDashboard();
    const client = createCollectorClient({
      baseUrl: "http://collector.test",
      fetch: async () =>
        bootstrapResponse({
          state: fixture,
          boutMappings: [],
          health: {},
          unifiedRounds: [],
          latestMarkets: [
            {
              source: "kalshi",
              boutId: "bout-main",
              marketType: "fight-winner",
              outcome: "Danilo Reyes",
              bid: 70,
              ask: 74,
              midpoint: 72,
              impliedProbability: 0.72,
              sourceUpdatedAt: "2026-07-28T01:10:00Z",
              receivedAt: "2026-07-28T01:10:01Z",
              stale: false,
              fresh: true,
            },
            {
              source: "kalshi",
              boutId: "bout-main",
              marketType: "fight-winner",
              outcome: "Artem Volkov",
              bid: 24,
              ask: 28,
              midpoint: 26,
              impliedProbability: 0.26,
              sourceUpdatedAt: "2026-07-28T01:10:00Z",
              receivedAt: "2026-07-28T01:10:01Z",
              stale: false,
              fresh: true,
            },
          ],
        }),
      createEventSource: (url) => new MockEventSource(url),
    });

    await client.start();
    const snapshot = client.getSnapshot();
    const view = snapshot.dashboard?.boutViews["bout-main"];

    // Fixture-only Kalshi odds mid to ~0.605; the bootstrap entries above
    // must win, proving the seed replaced fixture odds rather than merging
    // stale fixture history.
    expect(view?.latestOdds.kalshi?.quotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ corner: "red", impliedProbability: 0.72 }),
        expect.objectContaining({ corner: "blue", impliedProbability: 0.26 }),
      ]),
    );
    expect(view?.latestOdds.kalshi?.provenance).toMatchObject({
      source: "kalshi",
      synthetic: false,
    });
    expect(view?.oddsHistory.kalshi).toHaveLength(1);
    expect(
      getCollectorMarketDelivery(snapshot, "bout-main", "kalshi"),
    ).toMatchObject({ source: "Kalshi", stale: false });
    client.close();
  });

  it("applies a market-tick SSE event to the right latest odds entry, appends history, and propagates staleness", async () => {
    const fixture = await assembleDashboard();
    const client = createCollectorClient({
      baseUrl: "http://collector.test",
      fetch: async () =>
        bootstrapResponse({
          state: fixture,
          boutMappings: [],
          health: {},
          unifiedRounds: [],
        }),
      createEventSource: (url) => new MockEventSource(url),
    });

    await client.start();
    const events = MockEventSource.latest;
    events?.open();

    const beforeHistory =
      client.getSnapshot().dashboard?.boutViews["bout-main"]?.oddsHistory
        .sportsbook?.length ?? 0;

    events?.emit("update", {
      kind: "market-tick",
      tick: {
        source: "odds-api-io",
        boutId: "bout-main",
        bookmaker: "draftkings",
        marketType: "h2h",
        outcome: "Danilo Reyes",
        rawOdds: -150,
        impliedProbability: 0.6,
        sourceUpdatedAt: "2026-07-28T01:20:00Z",
        receivedAt: "2026-07-28T01:20:01Z",
        stale: true,
      },
    });

    const snapshot = client.getSnapshot();
    const view = snapshot.dashboard?.boutViews["bout-main"];
    const quote = view?.latestOdds.sportsbook?.quotes.find(
      (q) =>
        q.corner === "red" &&
        q.native.kind === "american-moneyline" &&
        q.native.book === "draftkings",
    );
    expect(quote).toMatchObject({ impliedProbability: 0.6 });
    expect(quote?.native).toMatchObject({
      kind: "american-moneyline",
      moneyline: -150,
    });
    expect(view?.oddsHistory.sportsbook).toHaveLength(beforeHistory + 1);

    const delivery = getCollectorMarketDelivery(
      snapshot,
      "bout-main",
      "sportsbook",
    );
    expect(delivery).toMatchObject({
      source: "Odds-API.io",
      stale: true,
      provisional: false,
    });
    const markup = renderToStaticMarkup(
      <DeliveryFreshness delivery={delivery!} />,
    );
    expect(markup).toContain("Stale");
    client.close();
  });

  it("applies a market-snapshot SSE event into the matching unified round's marketAtEnd", async () => {
    const fixture = await assembleDashboard();
    const client = createCollectorClient({
      baseUrl: "http://collector.test",
      fetch: async () =>
        bootstrapResponse({
          state: fixture,
          boutMappings: [],
          health: {},
          unifiedRounds: [roundRecord(true, 1)],
        }),
      createEventSource: (url) => new MockEventSource(url),
    });

    await client.start();
    const events = MockEventSource.latest;
    events?.open();

    events?.emit("update", {
      kind: "market-snapshot",
      snapshot: {
        source: "kalshi",
        boutId: "bout-main",
        round: 2,
        boundaryType: "provisional",
        takenAt: "2026-07-28T01:02:03Z",
        fresh: true,
        outcomes: [
          {
            marketType: "fight-winner",
            outcome: "Danilo Reyes",
            midpoint: 61,
            impliedProbability: 0.61,
            receivedAt: "2026-07-28T01:02:02Z",
            stale: false,
          },
        ],
      },
    });

    const record = client
      .getSnapshot()
      .unifiedRounds.find(
        (candidate) =>
          candidate.boutId === "bout-main" && candidate.round === 2,
      );
    expect(record?.marketAtEnd.kalshi).toMatchObject({
      boundaryType: "provisional",
      outcomes: [
        expect.objectContaining({ outcome: "Danilo Reyes", midpoint: 61 }),
      ],
    });
    // The lifecycle/round record itself is untouched by the market-snapshot
    // event other than the patched marketAtEnd field.
    expect(record).toMatchObject({ round: 2, provisional: true });
    client.close();
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

describe("shouldAdoptClockSync", () => {
  function sync(overrides: Partial<CollectorClockSync> = {}): CollectorClockSync {
    return {
      boutId: "bout-main",
      source: "espn",
      state: "in",
      period: 1,
      completed: false,
      clockSeconds: 200,
      sourceReceivedAt: "2026-08-01T00:00:00Z",
      receivedAt: "2026-08-01T00:00:00Z",
      ...overrides,
    };
  }

  it("always adopts when there is no existing sync yet", () => {
    expect(
      shouldAdoptClockSync(undefined, sync(), Date.parse("2026-08-01T00:00:00Z")),
    ).toBe(true);
  });

  it("ignores a same-round update that is lower than the last poll but ahead of our projected countdown", () => {
    const existing = sync({ clockSeconds: 200, receivedAt: "2026-08-01T00:00:00Z" });
    // 10s have passed locally, so our countdown reads 190 by now. ESPN's 195
    // is lower than its last reading, but is still stale relative to the
    // visible countdown and must not move it backward.
    const candidate = sync({ clockSeconds: 195, receivedAt: "2026-08-01T00:00:10Z" });
    expect(
      shouldAdoptClockSync(existing, candidate, Date.parse("2026-08-01T00:00:10Z")),
    ).toBe(false);
  });

  it("adopts a same-round update once ESPN's clock is behind our countdown", () => {
    const existing = sync({ clockSeconds: 200, receivedAt: "2026-08-01T00:00:00Z" });
    // Our countdown reads 190 at t+10s; ESPN reporting 188 has caught up.
    const candidate = sync({ clockSeconds: 188, receivedAt: "2026-08-01T00:00:10Z" });
    expect(
      shouldAdoptClockSync(existing, candidate, Date.parse("2026-08-01T00:00:10Z")),
    ).toBe(true);
  });

  it("does not re-adopt an unchanged ESPN clock in the same live round", () => {
    const existing = sync({ clockSeconds: 200 });
    const candidate = sync({ clockSeconds: 200 });
    expect(
      shouldAdoptClockSync(existing, candidate, Date.parse("2026-08-01T00:00:01Z")),
    ).toBe(false);
  });

  it("always adopts once the round or fight is reported over, regardless of the clock", () => {
    const existing = sync({ clockSeconds: 200, receivedAt: "2026-08-01T00:00:00Z" });
    const roundOver = sync({ state: "post", clockSeconds: 999 });
    const completed = sync({ completed: true, clockSeconds: 999 });
    const nextRound = sync({ period: 2, clockSeconds: 999 });
    const now = Date.parse("2026-08-01T00:00:01Z");
    expect(shouldAdoptClockSync(existing, roundOver, now)).toBe(true);
    expect(shouldAdoptClockSync(existing, completed, now)).toBe(true);
    expect(shouldAdoptClockSync(existing, nextRound, now)).toBe(true);
  });

  it("does not adopt a same-round update with no clock reading", () => {
    const existing = sync({ clockSeconds: 200 });
    const candidate = sync({ clockSeconds: undefined });
    expect(
      shouldAdoptClockSync(existing, candidate, Date.parse("2026-08-01T00:00:05Z")),
    ).toBe(false);
  });

  it("adopts the first real clock reading when the existing sync had none", () => {
    const existing = sync({ clockSeconds: undefined });
    const candidate = sync({ clockSeconds: 150 });
    expect(
      shouldAdoptClockSync(existing, candidate, Date.parse("2026-08-01T00:00:05Z")),
    ).toBe(true);
  });

  it("never gives Cito authority over the live clock", () => {
    const cito = sync({ source: "cito", clockSeconds: 150 });
    expect(
      shouldAdoptClockSync(undefined, cito, Date.parse("2026-08-01T00:00:00Z")),
    ).toBe(false);
    expect(
      shouldAdoptClockSync(sync(), cito, Date.parse("2026-08-01T00:00:01Z")),
    ).toBe(false);
  });
});
