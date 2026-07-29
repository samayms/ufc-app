import eventFixture from "../fixtures/event.json";
import type { Bout, Corner, Fighter } from "../schema.ts";
import { describe, expect, it } from "vitest";
import liveOdds from "../fixtures/theOddsApiLive.json" with { type: "json" };
import {
  createOddsApiSource,
  createTheOddsApiLiveHook,
  parseTheOddsApiSnapshot,
  THE_ODDS_API_H2H_REQUEST,
  type OddsApiEvent,
} from "./oddsapi.ts";

function getFixtureBout(boutId: string): Bout {
  const rawBout = eventFixture.bouts.find((bout) => bout.id === boutId);
  if (!rawBout) {
    throw new Error(`Missing fixture bout: ${boutId}`);
  }

  const fighters = Object.fromEntries(
    Object.entries(rawBout.fighterIds).map(([corner, fighterId]) => {
      const fighter = eventFixture.fighters.find(
        (candidate) => candidate.id === fighterId,
      );
      if (!fighter) {
        throw new Error(`Missing fixture fighter: ${fighterId}`);
      }

      return [corner, fighter];
    }),
  ) as Record<Corner, Fighter>;

  return {
    ...rawBout,
    fighters,
    provenance: eventFixture.event.provenance,
  } as Bout;
}

describe("createOddsApiSource", () => {
  const source = createOddsApiSource({ mode: "fixture" });

  it("returns moneyline quotes for both corners from multiple books", async () => {
    const snapshot = await source.getOddsSnapshot(getFixtureBout("bout-main"));

    expect(snapshot).not.toBeNull();
    expect(snapshot?.boutId).toBe("bout-main");
    expect(snapshot?.market).toBe("sportsbook");
    expect(snapshot?.provenance).toEqual({
      source: "odds-api",
      fetchedAt: "2026-07-26T02:40:28Z",
      synthetic: true,
    });

    const quotes = snapshot?.quotes ?? [];
    const books = new Set(
      quotes.map((quote) =>
        quote.native.kind === "american-moneyline"
          ? quote.native.book
          : "unexpected",
      ),
    );

    expect(books.size).toBeGreaterThan(1);
    for (const book of books) {
      expect(
        quotes
          .filter(
            (quote) =>
              quote.native.kind === "american-moneyline" &&
              quote.native.book === book,
          )
          .map((quote) => quote.corner)
          .sort(),
      ).toEqual(["blue", "red"]);
    }
  });

  it("converts each American moneyline to implied probability", async () => {
    const snapshot = await source.getOddsSnapshot(getFixtureBout("bout-main"));
    if (!snapshot) {
      throw new Error("Expected odds snapshot for bout-main");
    }

    for (const quote of snapshot.quotes) {
      if (quote.native.kind !== "american-moneyline") {
        throw new Error("Expected an American moneyline quote");
      }

      const moneyline = quote.native.moneyline;
      const expected =
        moneyline < 0
          ? -moneyline / (-moneyline + 100)
          : 100 / (moneyline + 100);

      expect(quote.impliedProbability).toBeCloseTo(expected, 4);
    }
  });

  it("returns null for a finished bout with no lines", async () => {
    await expect(
      source.getOddsSnapshot(getFixtureBout("bout-comain")),
    ).resolves.toBeNull();
  });

  it("fails closed in live mode when the credential or hook is absent", async () => {
    const missingCredential = createOddsApiSource({ mode: "live" });
    await expect(
      missingCredential.getOddsSnapshot(getFixtureBout("bout-main")),
    ).rejects.toThrow("The Odds API live source is not installed");

    const missingHook = createOddsApiSource({
      mode: "live",
      credentials: { THE_ODDS_API_KEY: "server-only" },
    });
    await expect(
      missingHook.getOddsSnapshot(getFixtureBout("bout-main")),
    ).rejects.toThrow("The Odds API live source is not installed");
  });
});

describe("createOddsApiSource getTickHistory", () => {
  const source = createOddsApiSource({ mode: "fixture" });

  it("returns bout-main's DraftKings h2h tick history, agreeing with the current snapshot", async () => {
    const ticks = await source.getTickHistory("bout-main");
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks.every((t) => t.boutId === "bout-main")).toBe(true);
    expect(ticks.every((t) => t.source === "the-odds-api")).toBe(true);

    const last = [...ticks]
      .filter((t) => t.outcome === "Danilo Reyes")
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
      .at(-1);
    expect(last?.rawOdds).toBe(-185);
  });

  it("returns an empty history for a bout with no ticks", async () => {
    expect(await source.getTickHistory("bout-comain")).toEqual([]);
  });

  it("returns an empty history when asked for a different source", async () => {
    expect(await source.getTickHistory("bout-main", "odds-api-io")).toEqual([]);
  });
});

// Captured live 2026-07-28 from
// api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds (HTTP 200,
// regions=us&markets=h2h, 1 credit). The live shape matched this parser with
// no changes; this test is the regression guard on that match.
describe("parseTheOddsApiSnapshot against the captured live payload", () => {
  const liveEvent = liveOdds[0];
  const base = getFixtureBout("bout-main");
  const liveBout: Bout = {
    ...base,
    id: "bout-live",
    fighters: {
      red: { ...base.fighters.red, name: liveEvent?.home_team ?? "" },
      blue: { ...base.fighters.blue, name: liveEvent?.away_team ?? "" },
    },
  };

  it("normalizes real bookmaker moneylines for both corners", () => {
    const snapshot = parseTheOddsApiSnapshot(
      liveOdds as OddsApiEvent[],
      liveBout,
      false,
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot?.market).toBe("sportsbook");
    expect(snapshot?.provenance.synthetic).toBe(false);
    // Two books in the capture, both corners quoted by each.
    expect(snapshot?.quotes).toHaveLength(4);
    expect(
      snapshot?.quotes.every(
        (quote) =>
          quote.native.kind === "american-moneyline" &&
          Number.isFinite(quote.native.moneyline) &&
          quote.impliedProbability > 0 &&
          quote.impliedProbability < 1,
      ),
    ).toBe(true);
    // The snapshot stamps the latest last_update across every book.
    const latest = (liveEvent?.bookmakers ?? [])
      .flatMap((book) => book.markets.map((market) => market.last_update))
      .sort()
      .at(-1);
    expect(snapshot?.marketUpdatedAt).toBe(latest);
  });

  it("returns null for a bout the payload does not cover", () => {
    expect(
      parseTheOddsApiSnapshot(liveOdds as OddsApiEvent[], base, false),
      ).toBeNull();
  });

  it("fetches the captured live market with the required request shape", async () => {
    const liveEvent = liveOdds[0];
    const bout = getFixtureBout("bout-main");
    const liveBout: Bout = {
      ...bout,
      id: "bout-live",
      fighters: {
        red: { ...bout.fighters.red, name: liveEvent?.home_team ?? "" },
        blue: { ...bout.fighters.blue, name: liveEvent?.away_team ?? "" },
      },
    };
    let requestedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify(liveOdds), { status: 200 });
    }) as typeof fetch;
    const hook = createTheOddsApiLiveHook({ fetchImpl });
    const source = createOddsApiSource(
      {
        mode: "live",
        credentials: { THE_ODDS_API_KEY: "server-only" },
      },
      hook,
    );

    const snapshot = await source.getH2hSnapshot(
      liveBout,
      THE_ODDS_API_H2H_REQUEST,
    );
    expect(snapshot?.quotes).toHaveLength(4);
    expect(snapshot?.provenance).toMatchObject({
      source: "odds-api",
      synthetic: false,
    });
    expect(requestedUrl).toContain("/sports/mma_mixed_martial_arts/odds");
    expect(requestedUrl).toContain("regions=us");
    expect(requestedUrl).toContain("markets=h2h");
    expect(requestedUrl).toContain("oddsFormat=american");
  });

  it("omits the live snapshot when the market does not list the bout", async () => {
    const hook = createTheOddsApiLiveHook({
      fetchImpl: (async () =>
        new Response(JSON.stringify(liveOdds), { status: 200 })) as typeof fetch,
    });
    const source = createOddsApiSource(
      {
        mode: "live",
        credentials: { THE_ODDS_API_KEY: "server-only" },
      },
      hook,
    );

    await expect(
      source.getH2hSnapshot(
        getFixtureBout("bout-main"),
        THE_ODDS_API_H2H_REQUEST,
      ),
    ).resolves.toBeNull();
  });

  it("omits a failed live request without retrying", async () => {
    let calls = 0;
    const hook = createTheOddsApiLiveHook({
      fetchImpl: (async () => {
        calls += 1;
        return new Response("{}", { status: 503 });
      }) as typeof fetch,
    });
    const source = createOddsApiSource(
      {
        mode: "live",
        credentials: { THE_ODDS_API_KEY: "server-only" },
      },
      hook,
    );

    await expect(
      source.getH2hSnapshot(
        getFixtureBout("bout-main"),
        THE_ODDS_API_H2H_REQUEST,
      ),
    ).resolves.toBeNull();
    expect(calls).toBe(1);
  });
});
