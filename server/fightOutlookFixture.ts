/**
 * Real, Gemini-summarized fight-outlook paragraphs captured from Sherdog's
 * preview articles by `scripts/importFightOutlooks.mjs --write`, keyed by
 * the real ESPN bout id (`Bout.id` in live mode is the ESPN competition id;
 * see `toBout` in liveEventState.ts). Deliberately a flat list, not a map,
 * so the fixture file reads cleanly as one entry per bout.
 *
 * This captured output remains a regression fixture for extraction and UI
 * review. Production restores newly discovered outlooks from persistent
 * storage instead of importing this card-specific file.
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
