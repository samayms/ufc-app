import eventFixture from "../fixtures/event.json";
import type { Bout, Corner, Fighter } from "../schema.ts";
import { describe, expect, it, vi } from "vitest";
import liveEvents from "../fixtures/oddsApiIoEventsLive.json" with {
  type: "json",
};
import liveOdds from "../fixtures/oddsApiIoOddsLive.json" with {
  type: "json",
};
import {
  createOddsApiIoSource,
  decimalToAmerican,
  OddsApiIoRequestError,
  parseOddsApiIoEventOdds,
  parseOddsApiIoEvents,
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
      bookmakers: ["draftkings", "bet365"],
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
        "bet365",
        "bet365",
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

  it("fails closed for getTickHistory in live mode without an installed hook", async () => {
    const source = createOddsApiIoSource({
      mode: "live",
      credentials: { ODDS_API_IO_KEY: "server-only" },
    });
    await expect(source.getTickHistory("bout-main")).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("returns the canonical bout-main tick history derived from the DraftKings snapshots", async () => {
    const source = createOddsApiIoSource({ mode: "fixture" });
    const ticks = await source.getTickHistory("bout-main");

    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks.every((t) => t.boutId === "bout-main")).toBe(true);
    expect(ticks.every((t) => t.source === "odds-api-io")).toBe(true);
  });

  it("returns an empty history for a bout with no ticks", async () => {
    const source = createOddsApiIoSource({ mode: "fixture" });
    expect(await source.getTickHistory("bout-comain")).toEqual([]);
  });

  it("returns an empty history when asked for a different source", async () => {
    const source = createOddsApiIoSource({ mode: "fixture" });
    expect(
      await source.getTickHistory("bout-main", "the-odds-api"),
    ).toEqual([]);
  });
});

// Captured live 2026-07-28 from api.odds-api.io/v3 (both HTTP 200). These
// guard the live shape, which differs from the synthetic fixture in every
// dimension: numeric ids, surname-first names, one bout per event, and
// bookmakers as an object of decimal-string markets.
describe("Odds-API.io live shapes", () => {
  const base = fixtureBout("bout-main");
  const liveBout: Bout = {
    ...base,
    id: "bout-live",
    fighters: {
      red: { ...base.fighters.red, name: "Marina Spasić" },
      blue: { ...base.fighters.blue, name: "Stephanie Bruna Luciano" },
    },
  };

  it("groups the captured /events payload into cards and bouts", () => {
    const events = parseOddsApiIoEvents(liveEvents);

    expect(events).toHaveLength(1);
    const card = events[0];
    expect(card?.name).toBe("UFC - UFC Fight Night: Medic vs. Rodriguez");
    expect(card?.bouts.length).toBe(liveEvents.length);
    // Numeric ids in the payload must survive as string ExternalRefs.
    expect(card?.bouts[0]?.externalRef).toEqual({
      source: "odds-api-io",
      id: String(liveEvents[0]?.id),
    });
  });

  it("rejects a non-array /events payload", () => {
    expect(() => parseOddsApiIoEvents({})).toThrow(/not an array/);
  });

  it("normalizes captured decimal odds into a snapshot", () => {
    const snapshot = parseOddsApiIoEventOdds(
      liveOdds,
      liveBout,
      ["Bet365"],
      "2026-07-28T14:05:00.000Z",
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot?.market).toBe("sportsbook");
    expect(snapshot?.provenance.synthetic).toBe(false);
    expect(snapshot?.marketUpdatedAt).toBe("2026-07-28T14:02:59.494Z");

    // home "3.30" -> red corner, away "1.35" -> blue corner.
    const red = snapshot?.quotes.find((q) => q.corner === "red");
    const blue = snapshot?.quotes.find((q) => q.corner === "blue");
    expect(red?.native).toEqual({
      kind: "american-moneyline",
      moneyline: 230,
      book: "bet365",
    });
    expect(blue?.native).toEqual({
      kind: "american-moneyline",
      moneyline: -286,
      book: "bet365",
    });
    expect(red?.impliedProbability).toBeCloseTo(1 / 3.3, 10);
    expect(blue?.impliedProbability).toBeCloseTo(1 / 1.35, 10);
  });

  it("maps corners by name regardless of home/away order", () => {
    const swapped: Bout = {
      ...liveBout,
      fighters: { red: liveBout.fighters.blue, blue: liveBout.fighters.red },
    };
    const snapshot = parseOddsApiIoEventOdds(
      liveOdds,
      swapped,
      ["Bet365"],
      "2026-07-28T14:05:00.000Z",
    );

    expect(
      snapshot?.quotes.find((q) => q.corner === "blue")?.native,
    ).toMatchObject({ moneyline: 230 });
  });

  it("returns null when the payload is a different bout", () => {
    expect(
      parseOddsApiIoEventOdds(liveOdds, base, ["Bet365"], "t"),
    ).toBeNull();
  });

  it("returns null when the requested bookmaker is absent", () => {
    expect(
      parseOddsApiIoEventOdds(liveOdds, liveBout, ["FanDuel"], "t"),
    ).toBeNull();
  });

  it("converts decimal odds to american at the even-money boundary", () => {
    expect(decimalToAmerican(2)).toBe(100);
    expect(decimalToAmerican(1.5)).toBe(-200);
    expect(decimalToAmerican(1)).toBeNull();
    expect(decimalToAmerican(Number.NaN)).toBeNull();
  });
});
