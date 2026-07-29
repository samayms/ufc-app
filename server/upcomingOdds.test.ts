import { describe, expect, it } from "vitest";

import {
  syncUpcomingOdds,
  type UpcomingCard,
} from "./upcomingOdds.ts";
import {
  persistUpcomingMappings,
  readUpcomingOddsDocument,
  writeUpcomingOddsDocument,
  UPCOMING_MAPPING_STREAM,
} from "./upcomingOddsStore.ts";
import { MemoryStorage } from "./storage.ts";
import type {
  UpcomingOddsProvider,
  UpcomingProviderId,
  UpcomingProviderMarket,
} from "../src/sources/upcoming/types.ts";
import type { UpcomingOddsDocument } from "../src/lib/upcomingOdds.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CARD_START = "2026-08-15T21:00:00.000Z";

const CARD: UpcomingCard = {
  espnEventId: "600059185",
  name: "UFC 330: Makhachev vs. Machado Garry",
  startsAt: CARD_START,
  bouts: [
    {
      boutId: "401869336",
      redFighter: "Islam Makhachev",
      blueFighter: "Ian Machado Garry",
      weightClassLabel: "Welterweight",
      startsAt: CARD_START,
      titleFight: true,
    },
    {
      boutId: "401878072",
      redFighter: "Mackenzie Dern",
      blueFighter: "Gillian Robertson",
      startsAt: CARD_START,
    },
  ],
};

function stubProvider(
  id: UpcomingProviderId,
  markets: UpcomingProviderMarket[] | Error,
): UpcomingOddsProvider {
  return {
    id,
    async listMarkets() {
      if (markets instanceof Error) throw markets;
      return markets;
    },
  };
}

function kalshiMainEvent(): UpcomingProviderMarket {
  return {
    externalId: "KXUFCFIGHT-26AUG15MAKGAR",
    // Alias spelling, listed first — the matcher must both resolve the alias
    // and flip the corners.
    firstFighter: "Ian Garry",
    secondFighter: "Islam Makhachev",
    startsAt: CARD_START,
    promotion: "ufc",
    quotes: [
      {
        side: "first",
        native: { kind: "kalshi-cents", yesCents: 31, noCents: 69 },
        impliedProbability: 0.31,
      },
      {
        side: "second",
        native: { kind: "kalshi-cents", yesCents: 69, noCents: 31 },
        impliedProbability: 0.69,
      },
    ],
  };
}

const NOW = () => new Date("2026-08-14T12:00:00.000Z");

describe("syncUpcomingOdds", () => {
  it("attaches an aliased, reversed market to the right corners", async () => {
    const document = await syncUpcomingOdds({
      cards: [CARD],
      providers: [stubProvider("kalshi", [kalshiMainEvent()])],
      now: NOW,
    });

    const entry = document.events[0]?.bouts[0]?.providers.kalshi;
    expect(entry?.status).toBe("loaded");
    expect(entry?.cornersReversed).toBe(true);
    expect(entry?.externalId).toBe("KXUFCFIGHT-26AUG15MAKGAR");

    const quotes = entry?.snapshot?.quotes ?? [];
    // Garry was listed first at 0.31, so blue (Garry's ESPN corner) is 0.31.
    expect(quotes.find((quote) => quote.corner === "blue")?.impliedProbability)
      .toBeCloseTo(0.31);
    expect(quotes.find((quote) => quote.corner === "red")?.impliedProbability)
      .toBeCloseTo(0.69);
  });

  it("marks a bout the provider does not list as not_listed", async () => {
    const document = await syncUpcomingOdds({
      cards: [CARD],
      providers: [stubProvider("kalshi", [kalshiMainEvent()])],
      now: NOW,
    });

    expect(document.events[0]?.bouts[1]?.providers.kalshi?.status).toBe(
      "not_listed",
    );
  });

  it("marks every bout provider_error when the provider throws", async () => {
    const document = await syncUpcomingOdds({
      cards: [CARD],
      providers: [stubProvider("polymarket", new Error("gamma timed out"))],
      now: NOW,
    });

    const entry = document.events[0]?.bouts[0]?.providers.polymarket;
    expect(entry?.status).toBe("provider_error");
    expect(entry?.message).toBe("gamma timed out");
    expect(document.providerRuns.polymarket?.status).toBe("error");
  });

  it("keeps one provider's failure from affecting the others", async () => {
    const document = await syncUpcomingOdds({
      cards: [CARD],
      providers: [
        stubProvider("kalshi", [kalshiMainEvent()]),
        stubProvider("odds-api", new Error("quota exhausted")),
      ],
      now: NOW,
    });

    const providers = document.events[0]?.bouts[0]?.providers;
    expect(providers?.kalshi?.status).toBe("loaded");
    expect(providers?.["odds-api"]?.status).toBe("provider_error");
  });

  it("records a listed-but-unpriced market as not_listed, not a fake price", async () => {
    const document = await syncUpcomingOdds({
      cards: [CARD],
      providers: [
        stubProvider("polymarket", [
          { ...kalshiMainEvent(), externalId: "0xabc", quotes: [] },
        ]),
      ],
      now: NOW,
    });

    const entry = document.events[0]?.bouts[0]?.providers.polymarket;
    expect(entry?.status).toBe("not_listed");
    expect(entry?.snapshot).toBeUndefined();
    expect(entry?.message).toContain("no priced side");
  });

  it("records an ambiguous market as unmatched instead of attaching it", async () => {
    const twinCard: UpcomingCard = {
      ...CARD,
      bouts: [
        {
          boutId: "bout-a",
          redFighter: "Diego Lopes",
          blueFighter: "Movsar Evloev",
          startsAt: CARD_START,
        },
        {
          boutId: "bout-b",
          redFighter: "Diego Lopes",
          blueFighter: "Movsar Evloev",
          startsAt: CARD_START,
        },
      ],
    };

    const document = await syncUpcomingOdds({
      cards: [twinCard],
      providers: [
        stubProvider("kalshi", [
          {
            externalId: "KX-TWIN",
            firstFighter: "Diego Lopes",
            secondFighter: "Movsar Evloev",
            startsAt: CARD_START,
            promotion: "ufc",
            quotes: [
              {
                side: "first",
                native: { kind: "kalshi-cents", yesCents: 50, noCents: 50 },
                impliedProbability: 0.5,
              },
            ],
          },
        ]),
      ],
      now: NOW,
    });

    expect(document.unmatchedMarkets).toHaveLength(1);
    expect(document.unmatchedMarkets[0]?.reason).toBe("ambiguous");
    for (const bout of document.events[0]?.bouts ?? []) {
      expect(bout.providers.kalshi?.status).toBe("not_listed");
    }
  });

  it("honours a manual override over the name score", async () => {
    const document = await syncUpcomingOdds({
      cards: [CARD],
      providers: [
        stubProvider("kalshi", [
          { ...kalshiMainEvent(), firstFighter: "Mystery", secondFighter: "Man" },
        ]),
      ],
      overrides: [
        {
          provider: "kalshi",
          externalId: "KXUFCFIGHT-26AUG15MAKGAR",
          boutId: "401878072",
        },
      ],
      now: NOW,
    });

    expect(document.events[0]?.bouts[1]?.providers.kalshi?.status).toBe(
      "loaded",
    );
    expect(document.events[0]?.bouts[1]?.providers.kalshi?.confidence).toBe(1);
  });

  it("is idempotent: two identical runs produce identical bouts", async () => {
    const run = () =>
      syncUpcomingOdds({
        cards: [CARD],
        providers: [stubProvider("kalshi", [kalshiMainEvent()])],
        now: NOW,
      });

    const first = await run();
    const second = await run();
    expect(second.events).toEqual(first.events);
  });

  it("retains the last valid snapshot when a later run fails", async () => {
    const good = await syncUpcomingOdds({
      cards: [CARD],
      providers: [stubProvider("kalshi", [kalshiMainEvent()])],
      now: NOW,
    });

    const degraded = await syncUpcomingOdds({
      cards: [CARD],
      providers: [stubProvider("kalshi", new Error("kalshi unreachable"))],
      previous: good,
      now: () => new Date("2026-08-14T18:00:00.000Z"),
    });

    const entry = degraded.events[0]?.bouts[0]?.providers.kalshi;
    expect(entry?.status).toBe("loaded");
    expect(entry?.preserved).toBe(true);
    expect(entry?.snapshot).toEqual(
      good.events[0]?.bouts[0]?.providers.kalshi?.snapshot,
    );
    expect(entry?.message).toBe("kalshi unreachable");
  });

  it("retains the last valid snapshot when a later run returns nothing", async () => {
    const good = await syncUpcomingOdds({
      cards: [CARD],
      providers: [stubProvider("kalshi", [kalshiMainEvent()])],
      now: NOW,
    });

    const empty = await syncUpcomingOdds({
      cards: [CARD],
      providers: [stubProvider("kalshi", [])],
      previous: good,
      now: NOW,
    });

    expect(empty.events[0]?.bouts[0]?.providers.kalshi?.preserved).toBe(true);
  });

  it("does not resurrect a price when the provider answered without this fight", async () => {
    const good = await syncUpcomingOdds({
      cards: [CARD],
      providers: [stubProvider("kalshi", [kalshiMainEvent()])],
      now: NOW,
    });

    // The provider is healthy and listing other fights — this bout genuinely
    // came off the board, so the old price must not be retained.
    const dropped = await syncUpcomingOdds({
      cards: [CARD],
      providers: [
        stubProvider("kalshi", [
          {
            ...kalshiMainEvent(),
            externalId: "KX-OTHER",
            firstFighter: "Mackenzie Dern",
            secondFighter: "Gillian Robertson",
          },
        ]),
      ],
      previous: good,
      now: NOW,
    });

    expect(dropped.events[0]?.bouts[0]?.providers.kalshi?.status).toBe(
      "not_listed",
    );
  });
});

describe("upcoming odds store", () => {
  it("round-trips a document and rejects a corrupt one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ufc-upcoming-"));
    try {
      const document = await syncUpcomingOdds({
        cards: [CARD],
        providers: [stubProvider("kalshi", [kalshiMainEvent()])],
        now: NOW,
      });

      await writeUpcomingOddsDocument(directory, document);
      expect(await readUpcomingOddsDocument(directory)).toEqual(document);

      await writeUpcomingOddsDocument(directory, {
        version: 2,
      } as unknown as UpcomingOddsDocument);
      expect(await readUpcomingOddsDocument(directory)).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("misses cleanly when nothing has been written yet", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ufc-upcoming-"));
    try {
      expect(await readUpcomingOddsDocument(directory)).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists one reviewable mapping per attached market, skipping retained ones", async () => {
    const storage = new MemoryStorage();
    const good = await syncUpcomingOdds({
      cards: [CARD],
      providers: [stubProvider("kalshi", [kalshiMainEvent()])],
      now: NOW,
    });
    expect(await persistUpcomingMappings(storage, good)).toBe(1);

    const preserved = await syncUpcomingOdds({
      cards: [CARD],
      providers: [stubProvider("kalshi", new Error("down"))],
      previous: good,
      now: NOW,
    });
    expect(await persistUpcomingMappings(storage, preserved)).toBe(0);

    const records = await storage.read(UPCOMING_MAPPING_STREAM);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      boutId: "401869336",
      provider: "kalshi",
      externalId: "KXUFCFIGHT-26AUG15MAKGAR",
      cornersReversed: true,
    });
  });
});
