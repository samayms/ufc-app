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
    ).resolves.toEqual(payload);
  });

  it("throws on a non-200 so the caller can report an error state", async () => {
    await expect(
      fetchArchivedEvent("e1", jsonResponse("nope", 500)),
    ).rejects.toThrow("500");
  });
});
