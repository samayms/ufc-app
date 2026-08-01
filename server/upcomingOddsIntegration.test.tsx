/**
 * The whole upcoming-odds path in one test:
 *
 *   ESPN fixture + provider fixtures
 *     -> shared matcher -> persistence -> /api/upcoming-odds -> frontend
 *
 * This is the test that would have caught the two live breakages found while
 * building this (Polymarket's listing-date-not-fight-date, Odds-API.io's
 * case-sensitive bookmakers) if the fixtures had carried the real shapes —
 * they now do, so it guards the same seams going forward.
 *
 * The assertions deliberately end at rendered markup rather than at the
 * document: "the sync produced a snapshot" and "a price is on the screen" have
 * been two different things at every stage of this feature.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { espnCardToUpcomingCard } from "./syncUpcoming.ts";
import { syncUpcomingOdds } from "./upcomingOdds.ts";
import {
  persistUpcomingMappings,
  readUpcomingOddsDocument,
  writeUpcomingOddsDocument,
} from "./upcomingOddsStore.ts";
import { MemoryStorage } from "./storage.ts";
import { parseEspnFightcenterCard } from "../src/sources/espnSchedule.ts";
import espnFightcenterFixture from "../src/fixtures/espnFightcenter.json" with {
  type: "json",
};
import {
  createFixtureUpcomingProviders,
  FIXTURE_UPCOMING_EVENT_ID,
} from "../src/sources/upcoming/fixtureUpcoming.ts";
import { findUpcomingBout } from "../src/lib/upcomingOdds.ts";
import { UpcomingOddsPanel } from "../src/ui/UpcomingOddsPanel.tsx";

const NOW = () => new Date("2026-08-14T12:00:00.000Z");
const NOW_MS = NOW().getTime();

/** The main event of the bundled UFC 330 card. */
const MAIN_EVENT_BOUT_ID = "401869336";

function fixtureCard() {
  const payloads = espnFightcenterFixture as Record<string, unknown>;
  const card = parseEspnFightcenterCard(
    payloads[FIXTURE_UPCOMING_EVENT_ID],
    FIXTURE_UPCOMING_EVENT_ID,
  );
  if (card === null) throw new Error("ESPN fightcenter fixture did not parse");
  return espnCardToUpcomingCard(card);
}

describe("upcoming odds, ESPN fixture through to the frontend", () => {
  it("carries all providers from discovery to rendered markup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ufc-upcoming-e2e-"));
    try {
      const card = fixtureCard();
      expect(card.bouts.length).toBeGreaterThan(0);

      // 1. matching
      const document = await syncUpcomingOdds({
        cards: [card],
        providers: createFixtureUpcomingProviders(),
        synthetic: true,
        now: NOW,
      });

      // 2. persistence, then read back exactly as the collector would
      await writeUpcomingOddsDocument(directory, document);
      const storage = new MemoryStorage();
      await persistUpcomingMappings(storage, document);
      const served = await readUpcomingOddsDocument(directory);
      expect(served).toEqual(document);

      // 3. the API payload shape the hook consumes
      const payload = { document: served };
      const bout = findUpcomingBout(payload.document, MAIN_EVENT_BOUT_ID);
      expect(bout).toBeDefined();

      // Every provider reached this bout.
      for (const provider of [
        "kalshi",
        "polymarket",
        "odds-api-io",
        "odds-api",
      ] as const) {
        expect(bout?.providers[provider]?.status).toBe("loaded");
      }

      // Kalshi lists this fight as "Ian Garry" first; the matcher must resolve
      // the alias and flip the corners so Makhachev keeps the red price.
      const kalshi = bout?.providers.kalshi;
      expect(kalshi?.cornersReversed).toBe(true);
      expect(
        kalshi?.snapshot?.quotes.find((quote) => quote.corner === "red")
          ?.impliedProbability,
      ).toBeCloseTo(0.69);

      // 4. frontend
      const html = renderToStaticMarkup(
        <UpcomingOddsPanel
          bout={bout}
          redName="Makhachev"
          blueName="Garry"
          nowMs={NOW_MS}
        />,
      );

      expect(html).toContain("Kalshi");
      expect(html).toContain("Polymarket");
      expect(html).toContain("Sportsbooks");
      expect(html).not.toContain("Odds-API.io");
      expect(html).not.toContain("The Odds API");
      expect(html).not.toContain("69%");
      expect(html.match(/Not listed/g)).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("renders explicit absence for a bout no provider lists", async () => {
    const card = fixtureCard();
    const document = await syncUpcomingOdds({
      cards: [card],
      providers: createFixtureUpcomingProviders(),
      synthetic: true,
      now: NOW,
    });

    // Geoff Neal vs Chidi Njokuani: Polymarket lists it with an empty book and
    // no one else lists it at all.
    const bout = document.events[0]?.bouts.find(
      (candidate) => candidate.redFighter === "Geoff Neal",
    );
    expect(bout).toBeDefined();
    for (const entry of Object.values(bout?.providers ?? {})) {
      expect(entry?.status).toBe("not_listed");
      expect(entry?.snapshot).toBeUndefined();
    }

    const html = renderToStaticMarkup(
      <UpcomingOddsPanel
        bout={bout}
        redName="Neal"
        blueName="Njokuani"
        nowMs={NOW_MS}
      />,
    );
    expect(html.match(/class="market"/g)).toHaveLength(4);
    expect(html.match(/class="market-pct num">—/g)).toHaveLength(6);
    expect(html.match(/class="market-moneyline num">—/g)).toHaveLength(2);
    expect(html).not.toMatch(/market-pct num">\d/);
  });

  it("never marks a synthetic run as live data", async () => {
    const document = await syncUpcomingOdds({
      cards: [fixtureCard()],
      providers: createFixtureUpcomingProviders(),
      synthetic: true,
      now: NOW,
    });

    expect(document.synthetic).toBe(true);
    for (const bout of document.events[0]?.bouts ?? []) {
      for (const entry of Object.values(bout.providers)) {
        if (entry?.snapshot === undefined) continue;
        expect(entry.snapshot.provenance.synthetic).toBe(true);
      }
    }
  });
});
