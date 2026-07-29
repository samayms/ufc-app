/**
 * Regenerates src/data/ufcRankings.json from ufc.com/rankings.
 *
 *   node scripts/fetchUfcRankings.mjs
 *
 * ESPN's own MMA rankings endpoint is years out of date — probed 2026-07-29 it
 * still had Ngannou at heavyweight and Usman at welterweight — so the app
 * cannot use it as the source of truth for the ranking badge. This scrapes the
 * official page once and checks the result in, which keeps the runtime free of
 * a scraping dependency and makes every ranking change a reviewable diff.
 *
 * Deliberately not a subsystem: no scheduler, no cache, no fallback chain.
 * Rankings move once a week and a stale badge is a cosmetic problem, so a
 * checked-in snapshot refreshed by hand is the right size for this.
 */

import { writeFile } from "node:fs/promises";

const RANKINGS_URL = "https://www.ufc.com/rankings";
const OUTPUT = new URL("../src/data/ufcRankings.json", import.meta.url);

function decodeEntities(value) {
  return value
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .trim();
}

const response = await fetch(RANKINGS_URL, {
  headers: {
    // The page 403s without a browser-shaped UA.
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    accept: "text/html",
  },
});
if (!response.ok) {
  throw new Error(`ufc.com/rankings responded ${response.status}`);
}
const html = await response.text();

const divisions = {};
for (const block of html.split('<div class="view-grouping">').slice(1)) {
  const heading = block.match(/view-grouping-header">\s*([^<]+)/)?.[1];
  if (heading === undefined) continue;
  const division = decodeEntities(heading);
  // Pound-for-pound is not a divisional rank and is not what the badge shows.
  if (/pound-for-pound/i.test(division)) continue;
  // The page renders each division twice (desktop and mobile); keep the first.
  if (division in divisions) continue;

  const champion = block.match(
    /rankings--athlete--champion[\s\S]*?<h5><a href="[^"]*" hreflang="en">([^<]+)<\/a>/,
  )?.[1];
  const ranked = [
    ...block.matchAll(
      /views-field-weight-class-rank">(\d+)\s*<\/td>\s*<td class="views-field views-field-title"><a href="[^"]*" hreflang="en">([^<]+)<\/a>/g,
    ),
  ].map((match) => ({
    rank: Number(match[1]),
    name: decodeEntities(match[2]),
  }));

  if (ranked.length === 0) continue;
  divisions[division] = {
    ...(champion === undefined ? {} : { champion: decodeEntities(champion) }),
    ranked,
  };
}

if (Object.keys(divisions).length === 0) {
  throw new Error(
    "No divisions parsed — ufc.com markup likely changed; fix the parser rather than shipping an empty overlay",
  );
}

await writeFile(
  OUTPUT,
  `${JSON.stringify(
    {
      source: RANKINGS_URL,
      capturedAt: new Date().toISOString(),
      divisions,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(
  `Wrote ${Object.keys(divisions).length} divisions to src/data/ufcRankings.json`,
);
