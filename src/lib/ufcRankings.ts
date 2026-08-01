/**
 * Official-UFC ranking overlay.
 *
 * ESPN's MMA rankings endpoint is the only ranking source this app had, and it
 * is years stale — probed 2026-07-29 it still listed Francis Ngannou as
 * heavyweight champion and Kamaru Usman as welterweight champion. Any badge
 * built on it is wrong for most of the roster, so the checked-in snapshot in
 * `src/data/ufcRankings.json` (scraped from ufc.com by
 * `scripts/fetchUfcRankings.mjs`) takes precedence, and ESPN is kept only as
 * the fallback for anyone the overlay does not name.
 *
 * Matching is by normalized fighter name because the official page publishes
 * names, not ESPN athlete ids. That reuses the same normalization and alias
 * table the odds matcher uses, so "Ian Garry" and "Ian Machado Garry" resolve
 * to one fighter here exactly as they do there.
 *
 * This is intentionally not a ranking subsystem: one file, one lookup, no
 * scheduler and no fallback chain. Rankings move once a week and a stale badge
 * is cosmetic.
 */

import rankingsData from "../data/ufcRankings.json" with { type: "json" };
import { canonicalFighterKey } from "./boutMatch.ts";

interface RankedFighter {
  rank: number;
  name: string;
}

interface Division {
  champion?: string;
  ranked: RankedFighter[];
}

interface RankingsSnapshot {
  source: string;
  capturedAt: string;
  divisions: Record<string, Division>;
}

const snapshot = rankingsData as RankingsSnapshot;

/** When the checked-in overlay was scraped, for the docs and the data tab. */
export const UFC_RANKINGS_CAPTURED_AT = snapshot.capturedAt;

function buildIndex(): Map<string, string> {
  const index = new Map<string, string>();
  for (const [division, entry] of Object.entries(snapshot.divisions)) {
    // Champion first: a champion also appears in some divisions' numbered
    // list, and "Champion" is the more meaningful label of the two.
    if (entry.champion !== undefined) {
      const key = canonicalFighterKey(entry.champion);
      if (key.length > 0 && !index.has(key)) {
        index.set(key, `${division} Champion`);
      }
    }
    for (const ranked of entry.ranked) {
      const key = canonicalFighterKey(ranked.name);
      if (key.length === 0 || index.has(key)) continue;
      index.set(key, `#${ranked.rank} ${division}`);
    }
  }
  return index;
}

const RANKING_BY_FIGHTER = buildIndex();

/**
 * The official divisional ranking for a fighter, display-ready in the same
 * format ESPN's parser produces ("#1 Welterweight", "Welterweight Champion").
 * Undefined means unranked or not on the official page — never a fabricated
 * "unranked" label.
 */
export function officialUfcRanking(name: string): string | undefined {
  return RANKING_BY_FIGHTER.get(canonicalFighterKey(name));
}
