import { describe, expect, it } from "vitest";

import type { UpcomingOddsDocument } from "../lib/upcomingOdds.ts";
import {
  fetchUpcomingOddsDocument,
  resolveUpcomingOddsState,
  upcomingOddsUrl,
} from "./useUpcomingOdds.ts";

function documentFixture(generatedAt: string): UpcomingOddsDocument {
  return {
    version: 1,
    generatedAt,
    synthetic: false,
    events: [],
    providerRuns: {},
    unmatchedMarkets: [],
  };
}

function jsonResponse(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("fetchUpcomingOddsDocument", () => {
  const url = upcomingOddsUrl("http://localhost:8600");

  it("decodes a served document", async () => {
    const document = documentFixture("2026-08-14T12:00:00.000Z");
    await expect(
      fetchUpcomingOddsDocument(url, jsonResponse({ document })),
    ).resolves.toEqual(document);
  });

  it("treats a never-run sync as no document rather than an error", async () => {
    await expect(
      fetchUpcomingOddsDocument(url, jsonResponse({ document: null })),
    ).resolves.toBeNull();
  });

  it("rejects a payload that is not a v1 document", async () => {
    await expect(
      fetchUpcomingOddsDocument(
        url,
        jsonResponse({ document: { version: 99 } }),
      ),
    ).resolves.toBeNull();
  });

  it("throws on a non-200 so the caller can retain the last good document", async () => {
    await expect(
      fetchUpcomingOddsDocument(url, jsonResponse({}, 503)),
    ).rejects.toThrow("503");
  });

  it("builds the collector URL from the configured base", () => {
    expect(upcomingOddsUrl("http://example.test:9000/")).toBe(
      "http://example.test:9000/api/upcoming-odds",
    );
  });
});

describe("resolveUpcomingOddsState", () => {
  const document = documentFixture("2026-08-14T12:00:00.000Z");

  it("reports a successful load as fresh", () => {
    expect(resolveUpcomingOddsState({ ok: true, document }, null)).toEqual({
      status: "ready",
      document,
      stale: false,
    });
  });

  it("errors only when there is nothing good to fall back to", () => {
    const state = resolveUpcomingOddsState(
      { ok: false, error: new Error("collector unreachable") },
      null,
    );
    expect(state.status).toBe("error");
    expect(state.document).toBeNull();
    expect(state.message).toBe("collector unreachable");
  });

  it("retains the last good document across a failed refetch", () => {
    const state = resolveUpcomingOddsState(
      { ok: false, error: new Error("collector unreachable") },
      document,
    );
    expect(state).toMatchObject({
      status: "ready",
      document,
      stale: true,
    });
  });

  it("lets a healthy collector clear a document, unlike a failure", () => {
    // "The sync ran and now covers nothing" must be able to replace an older
    // document; only a *failed* load falls back to it.
    expect(
      resolveUpcomingOddsState({ ok: true, document: null }, document),
    ).toEqual({ status: "ready", document: null, stale: false });
  });
});
