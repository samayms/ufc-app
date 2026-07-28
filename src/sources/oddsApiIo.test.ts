import eventFixture from "../fixtures/event.json";
import type { Bout, Corner, Fighter } from "../schema.ts";
import { describe, expect, it, vi } from "vitest";
import {
  createOddsApiIoSource,
  OddsApiIoRequestError,
  sportsbookSnapshotToMarketTicks,
} from "./oddsApiIo.ts";

function fixtureBout(id: string): Bout {
  const raw = eventFixture.bouts.find((bout) => bout.id === id);
  if (raw === undefined) throw new Error(`Missing fixture bout ${id}`);
  const fighters = Object.fromEntries(
    Object.entries(raw.fighterIds).map(([corner, fighterId]) => {
      const fighter = eventFixture.fighters.find(
        (candidate) => candidate.id === fighterId,
      );
      if (fighter === undefined) {
        throw new Error(`Missing fixture fighter ${fighterId}`);
      }
      return [corner, fighter];
    }),
  ) as Record<Corner, Fighter>;
  return {
    ...raw,
    fighters,
    provenance: eventFixture.event.provenance,
  } as Bout;
}

describe("Odds-API.io source", () => {
  it("discovers event and bout external refs deterministically without network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const first = createOddsApiIoSource({ mode: "fixture" });
    const second = createOddsApiIoSource({ mode: "fixture" });

    expect(await first.discoverEvents()).toEqual(
      await second.discoverEvents(),
    );
    expect(await first.discoverEvents()).toEqual([
      expect.objectContaining({
        externalRef: {
          source: "odds-api-io",
          id: "oai-event-ufc-fixture-night",
        },
        bouts: expect.arrayContaining([
          expect.objectContaining({
            externalRef: {
              source: "odds-api-io",
              id: "oai-bout-reyes-volkov",
            },
          }),
        ]),
      }),
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("replays timestamped two-book snapshots across a round boundary", async () => {
    const source = createOddsApiIoSource({ mode: "fixture" });
    const bout = fixtureBout("bout-main");
    const query = {
      bout,
      externalBoutId: "oai-bout-reyes-volkov",
      bookmakers: ["draftkings", "fanduel"],
    };
    const snapshots = [];
    for (let index = 0; index < 3; index += 1) {
      snapshots.push(await source.getBoutOdds(query));
    }

    expect(
      snapshots.map((snapshot) => snapshot?.marketUpdatedAt),
    ).toEqual([
      "2026-07-26T02:34:45Z",
      "2026-07-26T02:39:56Z",
      "2026-07-26T02:40:14Z",
    ]);
    for (const snapshot of snapshots) {
      expect(
        snapshot?.quotes.map((quote) =>
          quote.native.kind === "american-moneyline"
            ? quote.native.book
            : "",
        ),
      ).toEqual([
        "draftkings",
        "draftkings",
        "fanduel",
        "fanduel",
      ]);
    }
  });

  it("filters books and adds no-vig only to paired h2h ticks", async () => {
    const source = createOddsApiIoSource({ mode: "fixture" });
    const bout = fixtureBout("bout-main");
    const snapshot = await source.getBoutOdds({
      bout,
      externalBoutId: "oai-bout-reyes-volkov",
      bookmakers: ["draftkings"],
    });
    if (snapshot === null) throw new Error("Expected fixture odds");
    const paired = sportsbookSnapshotToMarketTicks(
      bout,
      snapshot,
      "odds-api-io",
      "2026-07-26T02:34:46Z",
    );
    expect(paired).toHaveLength(2);
    expect(
      paired.every((tick) => tick.noVigProbability !== undefined),
    ).toBe(true);
    expect(
      paired.reduce(
        (sum, tick) => sum + (tick.noVigProbability ?? 0),
        0,
      ),
    ).toBeCloseTo(1);

    const unpaired = sportsbookSnapshotToMarketTicks(
      bout,
      { ...snapshot, quotes: snapshot.quotes.slice(0, 1) },
      "the-odds-api",
      "2026-07-26T02:34:46Z",
    );
    expect(unpaired).toHaveLength(1);
    expect(unpaired[0]?.noVigProbability).toBeUndefined();
  });

  it("requires the server key and otherwise fails closed in live mode", async () => {
    expect(() =>
      createOddsApiIoSource({ mode: "live" }),
    ).toThrowError(
      expect.objectContaining<Partial<OddsApiIoRequestError>>({
        kind: "auth",
      }),
    );
    const source = createOddsApiIoSource({
      mode: "live",
      credentials: { ODDS_API_IO_KEY: "server-only" },
    });
    await expect(source.discoverEvents()).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});
