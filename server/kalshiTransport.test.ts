import { describe, expect, it } from "vitest";
import fixture from "../src/fixtures/kalshiTicks.json" with {
  type: "json",
};
import { CollectorEventBus } from "./eventBus.ts";
import type { MarketSubscription } from "./marketTransport.ts";
import { MemoryStorage } from "./storage.ts";
import { MarketTickStore } from "./tickStore.ts";
import {
  KalshiFixtureTransport,
  kalshiSubscriptionMessage,
  normalizeKalshiMessage,
} from "./kalshiTransport.ts";

const RECEIVED_AT = "2026-07-26T02:40:29.500Z";
const SUBSCRIPTION: MarketSubscription = {
  source: "kalshi",
  boutId: "bout-main",
  externalId: "KXUFCFIGHT-26JUL25REYVOL-REY",
  marketType: "fight-winner",
  outcome: "Danilo Reyes",
};

describe("normalizeKalshiMessage", () => {
  it("builds ticker-scoped subscriptions with unified YES pricing", () => {
    expect(JSON.parse(kalshiSubscriptionMessage([SUBSCRIPTION]))).toMatchObject(
      {
        cmd: "subscribe",
        params: {
          market_tickers: [SUBSCRIPTION.externalId],
          use_yes_price: true,
        },
      },
    );
  });

  it("normalizes order-book snapshots and deltas in cents with depth", () => {
    const snapshot = normalizeKalshiMessage(
      fixture.sampleMessages.orderbookSnapshot,
      [SUBSCRIPTION],
      RECEIVED_AT,
    );
    expect(snapshot).toMatchObject({
      book: { bids: [59, 57], asks: [61, 63] },
      message: {
        kind: "snapshot",
        ticks: [
          {
            bid: 59,
            ask: 61,
            impliedProbability: 0.6,
            depth: { bids: [59, 57], asks: [61, 63] },
          },
        ],
      },
    });

    const delta = normalizeKalshiMessage(
      fixture.sampleMessages.orderbookDelta,
      [SUBSCRIPTION],
      RECEIVED_AT,
      snapshot?.book,
    );
    expect(delta).toMatchObject({
      book: { bids: [60, 59, 57], asks: [61, 63] },
      message: {
        kind: "delta",
        ticks: [
          {
            bid: 60,
            ask: 61,
            sourceUpdatedAt: "2026-07-26T02:40:28.000Z",
          },
        ],
      },
    });
  });

  it("normalizes ticker, trade, and lifecycle messages", () => {
    const ticker = normalizeKalshiMessage(
      fixture.sampleMessages.ticker,
      [SUBSCRIPTION],
      RECEIVED_AT,
    );
    expect(ticker?.message).toMatchObject({
      kind: "delta",
      ticks: [
        {
          bid: 60,
          ask: 62,
          lastTrade: 61,
          volume: 48210,
          impliedProbability: 0.61,
          receivedAt: RECEIVED_AT,
        },
      ],
    });

    const trade = normalizeKalshiMessage(
      fixture.sampleMessages.trade,
      [SUBSCRIPTION],
      RECEIVED_AT,
    );
    expect(trade?.message).toMatchObject({
      kind: "delta",
      ticks: [{ lastTrade: 61.5 }],
    });

    const lifecycle = normalizeKalshiMessage(
      fixture.sampleMessages.lifecycle,
      [SUBSCRIPTION],
      RECEIVED_AT,
    );
    expect(lifecycle?.message).toMatchObject({
      kind: "lifecycle",
      ticks: [{ status: "closed" }],
    });
  });
});

describe("KalshiFixtureTransport", () => {
  it("replays deterministically into the tick store and boundary cache", async () => {
    const eventBus = new CollectorEventBus();
    const store = await MarketTickStore.create({
      eventBus,
      storage: new MemoryStorage(),
      clock: { now: () => Date.parse("2026-07-26T02:40:40Z") },
      staleAfterMs: 60_000,
    });
    const transport = new KalshiFixtureTransport({
      tickStore: store,
      subscriptions: [SUBSCRIPTION],
    });

    await transport.replay();
    await expect(
      store.getTickHistory("bout-main", "kalshi"),
    ).resolves.toHaveLength(6);

    eventBus.emit({
      type: "ROUND_ENDED",
      boutId: "bout-main",
      round: 2,
      detectedAt: "2026-07-26T02:40:30Z",
      confirmation: "period_transition",
    });
    await store.idle();
    expect(store.getSnapshots("bout-main", 2)).toEqual([
      expect.objectContaining({
        source: "kalshi",
        fresh: true,
        outcomes: expect.arrayContaining([
          expect.objectContaining({
            outcome: "Danilo Reyes",
            midpoint: 60.5,
          }),
        ]),
      }),
    ]);

    await transport.disconnect();
    expect(store.getLatest("bout-main", "kalshi")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stale: true, fresh: false }),
      ]),
    );
    await store.close();
  });
});
