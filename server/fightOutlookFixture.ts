/**
 * Real, Gemini-summarized fight-outlook paragraphs captured from Sherdog's
 * preview articles by `scripts/importFightOutlooks.mjs --write`, keyed by
 * the real ESPN bout id (`Bout.id` in live mode is the ESPN competition id;
 * see `toBout` in liveEventState.ts). Deliberately a flat list, not a map,
 * so the fixture file reads cleanly as one entry per bout.
 *
 * This is the one dev/live-mode surface that carries real outlook prose:
 * the mock dev event in `src/fixtures/event.json` describes fictional
 * fighters ("Reyes vs. Volkov") that Sherdog has never previewed, so
 * outlook text is only ever attached to bouts sourced from the real ESPN
 * schedule (`loadLiveEventState`), never to the mock fixture event.
 */
import fixture from "../src/fixtures/fightOutlooks.json" with { type: "json" };

export interface FightOutlookFixtureEntry {
  boutId: string;
  redName: string;
  blueName: string;
  outlook: string;
}

const entries = fixture as FightOutlookFixtureEntry[];

/** Loads the fixture as a boutId -> outlook lookup map. */
export function loadFightOutlookFixture(): Map<string, string> {
  return new Map(entries.map((entry) => [entry.boutId, entry.outlook]));
}
