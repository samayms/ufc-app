import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every screen that renders a bout header has the fighters' headshots
 * available — the bout list you tapped through to reach it was already
 * showing them. Forgetting to pass them doesn't fail a type check or throw:
 * the header just quietly falls back to the no-photo silhouette, which
 * reads as "ESPN has no picture of this fighter" rather than "a prop is
 * missing". That's exactly how a live/finished bout ended up photoless on
 * the Fight tab while its own row in the card rail showed both faces.
 */
const SOURCES = ["../App.tsx", "../ui/ScheduledFightPreview.tsx"];

function boutHeaderCalls(source: string): string[] {
  const text = readFileSync(
    fileURLToPath(new URL(source, import.meta.url)),
    "utf8",
  );
  return [...text.matchAll(/<BoutHeader\b[\s\S]*?\/>/g)].map((m) => m[0]);
}

describe("every bout header gets its fighters' photos", () => {
  for (const source of SOURCES) {
    it(`${source} passes photosByCorner everywhere it renders one`, () => {
      const calls = boutHeaderCalls(source);
      expect(calls.length).toBeGreaterThan(0);
      const missing = calls.filter((call) => !call.includes("photosByCorner"));
      expect(
        missing.map((call) => call.slice(0, 120)),
        "a BoutHeader is rendered without headshots",
      ).toEqual([]);
    });
  }
});
