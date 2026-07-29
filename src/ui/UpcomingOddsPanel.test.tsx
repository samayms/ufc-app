import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  UpcomingBoutOdds,
  UpcomingProviderEntry,
} from "../lib/upcomingOdds.ts";
import { UPCOMING_STALE_AFTER_MS } from "../lib/upcomingOdds.ts";
import { UpcomingOddsPanel } from "./UpcomingOddsPanel.tsx";

const NOW_MS = Date.parse("2026-08-14T12:00:00.000Z");

function loadedKalshi(
  overrides: Partial<UpcomingProviderEntry> = {},
): UpcomingProviderEntry {
  return {
    status: "loaded",
    fetchedAt: "2026-08-14T11:00:00.000Z",
    updatedAt: "2026-08-14T11:00:00.000Z",
    externalId: "KXUFCFIGHT-26AUG15MAKGAR",
    confidence: 1,
    cornersReversed: false,
    snapshot: {
      boutId: "401869336",
      market: "kalshi",
      quotes: [
        {
          corner: "red",
          native: { kind: "kalshi-cents", yesCents: 69, noCents: 31 },
          impliedProbability: 0.69,
        },
        {
          corner: "blue",
          native: { kind: "kalshi-cents", yesCents: 31, noCents: 69 },
          impliedProbability: 0.31,
        },
      ],
      provenance: {
        source: "kalshi",
        fetchedAt: "2026-08-14T11:00:00.000Z",
        synthetic: false,
      },
    },
    ...overrides,
  };
}

function bout(
  providers: UpcomingBoutOdds["providers"],
): UpcomingBoutOdds {
  return {
    boutId: "401869336",
    espnEventId: "600059185",
    redFighter: "Islam Makhachev",
    blueFighter: "Ian Machado Garry",
    providers,
  };
}

function render(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(node);
}

describe("UpcomingOddsPanel", () => {
  it("renders every provider independently, even ones with no data", () => {
    const html = render(
      <UpcomingOddsPanel
        bout={bout({ kalshi: loadedKalshi() })}
        redName="Makhachev"
        blueName="Garry"
        nowMs={NOW_MS}
      />,
    );

    for (const label of [
      "Kalshi",
      "Polymarket",
      "Odds-API.io",
      "The Odds API",
    ]) {
      expect(html).toContain(label);
    }
  });

  it("shows a real price and its update time for a loaded provider", () => {
    const html = render(
      <UpcomingOddsPanel
        bout={bout({ kalshi: loadedKalshi() })}
        redName="Makhachev"
        blueName="Garry"
        nowMs={NOW_MS}
      />,
    );

    expect(html).toContain("69%");
    expect(html).toContain("31%");
    expect(html).toContain("updated");
  });

  it("distinguishes not_listed, unmatched and provider_error", () => {
    const html = render(
      <UpcomingOddsPanel
        bout={bout({
          kalshi: { status: "not_listed", fetchedAt: "2026-08-14T11:00:00.000Z" },
          polymarket: {
            status: "unmatched",
            fetchedAt: "2026-08-14T11:00:00.000Z",
          },
          "odds-api": {
            status: "provider_error",
            fetchedAt: "2026-08-14T11:00:00.000Z",
            message: "HTTP 429",
          },
        })}
        redName="Makhachev"
        blueName="Garry"
        nowMs={NOW_MS}
      />,
    );

    expect(html).toContain("Not listed");
    expect(html).toContain("Unmatched");
    expect(html).toContain("Provider error");
    expect(html).toContain("does not list this fight");
    expect(html).toContain("could not be matched");
  });

  it("derives stale from the age of a loaded price", () => {
    const old = loadedKalshi({
      updatedAt: new Date(
        NOW_MS - UPCOMING_STALE_AFTER_MS - 60_000,
      ).toISOString(),
    });
    const html = render(
      <UpcomingOddsPanel
        bout={bout({ kalshi: old })}
        redName="Makhachev"
        blueName="Garry"
        nowMs={NOW_MS}
      />,
    );

    expect(html).toContain("Stale");
    // A stale price is still shown — it is real, just old.
    expect(html).toContain("69%");
  });

  it("flags a retained price from an earlier successful sync", () => {
    const html = render(
      <UpcomingOddsPanel
        bout={bout({ kalshi: loadedKalshi({ preserved: true }) })}
        redName="Makhachev"
        blueName="Garry"
        nowMs={NOW_MS}
      />,
    );

    expect(html).toContain("last known price retained");
  });

  it("says so when no sync covers this bout, and prices nothing", () => {
    const html = render(
      <UpcomingOddsPanel
        bout={undefined}
        redName="Makhachev"
        blueName="Garry"
        notice="No sync has run yet."
        nowMs={NOW_MS}
      />,
    );

    expect(html).toContain("No sync has run yet.");
    // Four blocks, every probability cell empty — never a fixture price
    // standing in for a real one.
    expect(html.match(/Not listed/g)).toHaveLength(4);
    expect(html.match(/market-pct num">—/g)).toHaveLength(8);
    expect(html).not.toMatch(/market-pct num">\d/);
  });
});
