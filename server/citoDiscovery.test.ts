import { describe, expect, it } from "vitest";
import citoBoutsFixture from "../src/fixtures/citoEventBoutsLive.json" with {
  type: "json",
};
import espnScoreboardFixture from "../src/fixtures/espnScoreboardWeekend.json" with {
  type: "json",
};
import type {
  Bout,
  Fighter,
  UfcEvent,
} from "../src/schema.ts";
import {
  createBoutMappingRegistry,
} from "./mapping.ts";
import {
  discoverCitoBouts,
  type CitoDiscoveryTransport,
} from "./citoDiscovery.ts";
import { MemoryStorage } from "./storage.ts";

interface RawScoreboardCompetitor {
  order: number;
  athlete: { fullName: string };
}

interface RawScoreboardCompetition {
  id: string;
  competitors: RawScoreboardCompetitor[];
}

interface RawScoreboardEvent {
  id: string;
  name: string;
  date: string;
  competitions: RawScoreboardCompetition[];
}

interface RawScoreboard {
  events: RawScoreboardEvent[];
}

interface RawCitoFighter {
  fighterName: string;
  corner: string;
}

interface RawCitoBout {
  id: string;
  fighters: RawCitoFighter[];
}

interface RawCitoBoutsPayload {
  data: RawCitoBout[];
}

const scoreboard = espnScoreboardFixture as unknown as RawScoreboard;
const citoBouts = citoBoutsFixture as unknown as RawCitoBoutsPayload;

function fighter(id: string, name: string): Fighter {
  return {
    id,
    externalRefs: [],
    name,
    record: { wins: 0, losses: 0, draws: 0, noContests: 0 },
    provenance: {
      source: "espn",
      fetchedAt: "2026-07-30T00:00:00.000Z",
      synthetic: false,
    },
  };
}

function espnEventFromFixture(): UfcEvent {
  const rawEvent = scoreboard.events.find(
    (candidate) => candidate.id === "600059339",
  );
  if (rawEvent === undefined) throw new Error("Weekend ESPN fixture is missing the card");

  const bouts: Bout[] = rawEvent.competitions.map((competition, index) => {
    const competitors = [...competition.competitors].sort(
      (left, right) => left.order - right.order,
    );
    const red = competitors[0];
    const blue = competitors[1];
    if (red === undefined || blue === undefined) {
      throw new Error(`ESPN fixture bout ${competition.id} is missing a corner`);
    }
    return {
      id: competition.id,
      externalRefs: [{ source: "espn", id: competition.id }],
      eventId: rawEvent.id,
      cardPosition: index + 1,
      segment: "main-card",
      weightClass: "catchweight",
      scheduledRounds: 3,
      titleFight: false,
      fighters: {
        red: fighter(`${competition.id}-red`, red.athlete.fullName),
        blue: fighter(`${competition.id}-blue`, blue.athlete.fullName),
      },
      status: "upcoming",
      provenance: {
        source: "espn",
        fetchedAt: "2026-07-30T00:00:00.000Z",
        synthetic: false,
      },
    };
  });

  return {
    id: rawEvent.id,
    externalRefs: [{ source: "espn", id: rawEvent.id }],
    name: rawEvent.name,
    startsAt: rawEvent.date,
    bouts,
    provenance: {
      source: "espn",
      fetchedAt: "2026-07-30T00:00:00.000Z",
      synthetic: false,
    },
  };
}

function transportFor(
  bouts: RawCitoBout[],
  upcoming: unknown[] = [],
): CitoDiscoveryTransport & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    async get(path) {
      paths.push(path);
      if (path === "ufc/events/upcoming?limit=25") {
        return { success: true, data: upcoming };
      }
      return { success: true, data: bouts };
    },
  };
}

describe("Cito card discovery", () => {
  it("maps all 14 captured Cito bouts to ESPN internal ids", async () => {
    const event = espnEventFromFixture();
    const registry = await createBoutMappingRegistry({
      event,
      storage: new MemoryStorage(),
    });
    const transport = transportFor(citoBouts.data, [
      {
        id: "ae9a4067-05b9-4ae1-a7f7-28db3498c1aa",
        slug: "ufc-fight-night-august-01-2026",
        title: "UFC Fight Night: Medic vs Rodriguez",
        startsAt: "2026-08-01T17:00:00.000Z",
      },
    ]);

    const summary = await discoverCitoBouts({
      event,
      registry,
      transport,
    });

    expect(summary).toEqual({
      eventSlug: "ufc-fight-night-august-01-2026",
      matched: 14,
      unmatched: [],
    });
    expect(registry.getExternalRefs("401870843")).toContainEqual({
      source: "cito",
      id: "12879",
    });
    expect(registry.getExternalRefs("401892191")).toContainEqual({
      source: "cito",
      id: "12966",
    });
    expect(event.externalRefs).toContainEqual({
      source: "cito",
      id: "ae9a4067-05b9-4ae1-a7f7-28db3498c1aa",
    });
  });

  it("skips malformed corners and reports an unmatchable bout", async () => {
    const event = espnEventFromFixture();
    const registry = await createBoutMappingRegistry({
      event,
      storage: new MemoryStorage(),
    });
    const malformed = citoBouts.data.map((bout, index) =>
      index === 0
        ? {
            ...bout,
            fighters: bout.fighters.map((fighter, fighterIndex) =>
              fighterIndex === 0 ? { ...fighter, corner: "unknown" } : fighter,
            ),
          }
        : bout,
    );
    malformed.push({
      id: "99999",
      fighters: [
        { fighterName: "Unrelated Alpha", corner: "red" },
        { fighterName: "Different Beta", corner: "blue" },
      ],
    });
    const transport = transportFor(malformed, []);

    const summary = await discoverCitoBouts({
      event,
      registry,
      transport,
      configuredEventSlug: "ufc-fight-night-august-01-2026",
    });

    expect(summary.matched).toBe(13);
    expect(summary.unmatched).toEqual(["99999"]);
  });

  it("uses a configured slug without resolving upcoming events", async () => {
    const event = espnEventFromFixture();
    const registry = await createBoutMappingRegistry({
      event,
      storage: new MemoryStorage(),
    });
    const transport = transportFor(citoBouts.data);

    const summary = await discoverCitoBouts({
      event,
      registry,
      transport,
      configuredEventSlug: "ufc-fight-night-august-01-2026",
    });

    expect(summary.eventSlug).toBe("ufc-fight-night-august-01-2026");
    expect(transport.paths).toEqual([
      "ufc/events/ufc-fight-night-august-01-2026/bouts",
    ]);
  });

  it("rejects a candidate more than 36 hours from the event", async () => {
    const event = espnEventFromFixture();
    const registry = await createBoutMappingRegistry({
      event,
      storage: new MemoryStorage(),
    });
    const transport = transportFor(citoBouts.data, [
      {
        id: "week-away",
        slug: "wrong-week",
        title: event.name,
        startsAt: "2026-08-08T17:00:00.000Z",
      },
    ]);

    await expect(
      discoverCitoBouts({ event, registry, transport }),
    ).resolves.toEqual({ eventSlug: undefined, matched: 0, unmatched: [] });
    expect(transport.paths).toEqual(["ufc/events/upcoming?limit=25"]);
  });

  it("does not guess when equally good nearby event titles tie", async () => {
    const event = espnEventFromFixture();
    const registry = await createBoutMappingRegistry({
      event,
      storage: new MemoryStorage(),
    });
    const transport = transportFor(citoBouts.data, [
      {
        id: "one",
        slug: "one",
        title: "UFC Fight Night: Medic vs Rodriguez",
        startsAt: "2026-08-01T16:00:00.000Z",
      },
      {
        id: "two",
        slug: "two",
        title: "UFC Fight Night: Medic vs Rodriguez",
        startsAt: "2026-08-01T18:00:00.000Z",
      },
    ]);

    await expect(
      discoverCitoBouts({ event, registry, transport }),
    ).resolves.toEqual({ eventSlug: undefined, matched: 0, unmatched: [] });
  });
});
