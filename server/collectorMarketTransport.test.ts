import { afterEach, describe, expect, it } from "vitest";
import {
  createCollector,
  type Collector,
} from "./collector.ts";
import { KalshiFixtureTransport } from "./kalshiTransport.ts";
import { PolymarketFixtureTransport } from "./polymarketTransport.ts";
import { MemoryStorage } from "./storage.ts";

const collectors: Collector[] = [];

afterEach(async () => {
  await Promise.all(
    collectors.splice(0).map((collector) => collector.close()),
  );
});

describe("collector market transport wiring", () => {
  it("constructs dormant fixture replayers and starts them only on replay()", async () => {
    const collector = await createCollector({
      env: { DATA_MODE: "fixture", COLLECTOR_PORT: "0" },
      storage: new MemoryStorage(),
      market: {
        clock: { now: () => Date.parse("2026-07-26T02:40:40Z") },
        staleAfterMs: 60_000,
      },
    });
    collectors.push(collector);

    expect(collector.marketTransports).toEqual([
      expect.any(KalshiFixtureTransport),
      expect.any(PolymarketFixtureTransport),
    ]);
    await expect(
      collector.tickStore.getTickHistory("bout-main"),
    ).resolves.toEqual([]);

    await collector.replayMarkets();
    await expect(
      collector.tickStore.getTickHistory("bout-main", "kalshi"),
    ).resolves.toHaveLength(6);
    await expect(
      collector.tickStore.getTickHistory("bout-main", "polymarket"),
    ).resolves.toHaveLength(6);
  });
});
