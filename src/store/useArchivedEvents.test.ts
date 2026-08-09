import { describe, expect, it } from "vitest";

import type { DashboardState } from "../schema.ts";
import {
  fetchArchivedEvent,
  fetchArchivedEvents,
  type ArchivedEventSummary,
} from "./useArchivedEvents.ts";

function jsonResponse(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("fetchArchivedEvents", () => {
  it("decodes the archived event list", async () => {
    const events: ArchivedEventSummary[] = [
      {
        id: "e1",
        name: "UFC 300",
        startsAt: "2026-01-01T00:00:00.000Z",
        archivedAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    await expect(
      fetchArchivedEvents(jsonResponse(events)),
    ).resolves.toEqual(events);
  });

  it("throws on a non-200 so the caller can report an error state", async () => {
    await expect(
      fetchArchivedEvents(jsonResponse("nope", 500)),
    ).rejects.toThrow("500");
  });
});

describe("fetchArchivedEvent", () => {
  it("decodes a single archived event's DashboardState", async () => {
    const payload = {
      event: { id: "e1", name: "UFC 300" },
      boutViews: {},
    } as unknown as DashboardState;
    await expect(
      fetchArchivedEvent("e1", jsonResponse(payload)),
    ).resolves.toEqual({ ...payload, unifiedRounds: [], marketSnapshots: [] });
  });

  it("hydrates archived stats and summaries from persisted unified rounds", async () => {
    const bout = {
      id: "b1",
      status: "final",
      fighters: {
        red: { name: "Red Fighter" },
        blue: { name: "Blue Fighter" },
      },
    };
    const payload = {
      event: {
        id: "e1",
        bouts: [bout],
        provenance: { synthetic: false },
      },
      boutViews: {
        b1: {
          bout,
          rounds: {},
          latestOdds: {},
          oddsHistory: {},
          marketMoves: {},
          preFightOdds: {},
        },
      },
      unifiedRounds: [{
        boutId: "b1",
        round: 1,
        detectedEndedAt: "2026-01-01T00:10:00.000Z",
        endingSignal: "period_transition",
        espnStats: {
          boutId: "b1",
          round: 1,
          fighterA: { significantStrikesLanded: 18 },
          fighterB: { significantStrikesLanded: 9 },
          observedAt: "2026-01-01T00:10:00.000Z",
          finalized: true,
        },
        sherdog: {
          boutId: "b1",
          round: 1,
          commentary: "Red controlled the round.",
          scorerCards: [],
          sourceUrl: "https://example.com/round",
          fetchedAt: "2026-01-01T00:11:00.000Z",
          parserVersion: "test",
          payloadHash: "hash",
        },
        marketAtEnd: {},
        provisional: false,
      }],
    } as unknown as DashboardState;

    const archived = await fetchArchivedEvent("e1", jsonResponse(payload));
    expect(archived.boutViews.b1?.rounds.espn?.[0]?.stats?.red?.significantStrikesLanded)
      .toBe(18);
    expect(archived.boutViews.b1?.rounds.sherdog?.[0]?.summary)
      .toBe("Red controlled the round.");
    expect(archived.unifiedRounds).toHaveLength(1);
  });

  it("throws on a non-200 so the caller can report an error state", async () => {
    await expect(
      fetchArchivedEvent("e1", jsonResponse("nope", 500)),
    ).rejects.toThrow("500");
  });
});
