/**
 * Verifies the Lab's bout ids are still correct.
 *
 * The Lab builds its fight list from a fixture snapshot
 * (`src/fixtures/citoEventBoutsLive.json`) captured once before fight night.
 * Cito's bout ids are normally stable, but a late card change (an injury
 * replacement, a bout pulled or reordered) can leave that snapshot pointing
 * at the wrong id — and a wrong id is silent: every probe and the watcher
 * both return clean, well-formed "no data for this bout" responses, which
 * looks identical to "Cito just hasn't published yet."
 *
 * This script re-fetches the live card from Cito and diffs it against the
 * fixture by fighter name, so a mismatch shows up as a diagnostic instead of
 * a mystery.
 *
 *   npm run lab:check-bout-ids
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL("../src/fixtures/citoEventBoutsLive.json", import.meta.url),
);

function usage() {
  return `Usage:
  npm run lab:check-bout-ids -- --slug <cito-event-slug>

Requires CITO_API_KEY and CITO_API_BASE_URL (see .env). Reads the fixture at
${FIXTURE_PATH}, fetches the same event's live bout list from Cito, and
reports any bout whose id, fighters, or card position have drifted. Pass
--write to overwrite the fixture with the live payload once you've reviewed
the diff.`;
}

function readArguments(argv) {
  const values = { write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      values.help = true;
      continue;
    }
    if (argument === "--write") {
      values.write = true;
      continue;
    }
    if (argument === "--slug") {
      const value = argv[index + 1]?.trim();
      if (!value) throw new TypeError("--slug needs a value");
      values.slug = value;
      index += 1;
      continue;
    }
    throw new TypeError(`Unknown argument: ${argument}`);
  }
  return values;
}

function fighterKey(fighters) {
  return fighters
    .map((fighter) => fighter.fighterName)
    .filter((name) => typeof name === "string")
    .sort()
    .join(" / ");
}

function indexByFighters(rows) {
  const index = new Map();
  for (const row of rows) {
    const key = fighterKey(row.fighters ?? []);
    if (key.length > 0) index.set(key, row);
  }
  return index;
}

async function fetchLiveBouts(baseUrl, apiKey, slug) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(`ufc/events/${encodeURIComponent(slug)}/bouts`, base);
  const response = await fetch(url, { headers: { "x-api-key": apiKey } });
  if (!response.ok) {
    throw new Error(
      `Cito bouts request failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
  const payload = await response.json();
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function main() {
  const args = readArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const apiKey = process.env.CITO_API_KEY?.trim();
  const baseUrl = process.env.CITO_API_BASE_URL?.trim();
  if (!apiKey || !baseUrl) {
    throw new Error("CITO_API_KEY and CITO_API_BASE_URL must both be set");
  }

  const fixtureRaw = readFileSync(FIXTURE_PATH, "utf8");
  const fixture = JSON.parse(fixtureRaw);
  const fixtureRows = Array.isArray(fixture?.data) ? fixture.data : [];
  const slug = args.slug ?? fixtureRows[0]?.eventSlug;
  if (!slug) {
    throw new Error(
      "no event slug in the fixture and none passed with --slug",
    );
  }

  const liveRows = await fetchLiveBouts(baseUrl, apiKey, slug);
  const fixtureByFighters = indexByFighters(fixtureRows);
  const liveByFighters = indexByFighters(liveRows);

  const mismatches = [];
  for (const [key, liveRow] of liveByFighters) {
    const fixtureRow = fixtureByFighters.get(key);
    if (fixtureRow === undefined) {
      mismatches.push(`NEW on the live card, missing from the fixture: ${key} (id ${liveRow.id})`);
      continue;
    }
    if (fixtureRow.id !== liveRow.id) {
      mismatches.push(
        `id drifted for ${key}: fixture has ${fixtureRow.id}, live has ${liveRow.id}`,
      );
    }
    if (fixtureRow.cardPosition !== liveRow.cardPosition) {
      mismatches.push(
        `card position changed for ${key}: fixture has "${fixtureRow.cardPosition}", live has "${liveRow.cardPosition}"`,
      );
    }
  }
  for (const [key, fixtureRow] of fixtureByFighters) {
    if (!liveByFighters.has(key)) {
      mismatches.push(
        `in the fixture but not on the live card (pulled/replaced?): ${key} (id ${fixtureRow.id})`,
      );
    }
  }

  if (mismatches.length === 0) {
    process.stdout.write(
      `All ${liveRows.length} bout ids match between the fixture and Cito's live card for ${slug}.\n`,
    );
    return;
  }

  process.stdout.write(
    `${mismatches.length} bout-id mismatch(es) for ${slug}:\n`,
  );
  for (const line of mismatches) process.stdout.write(`  - ${line}\n`);

  if (args.write) {
    writeFileSync(
      FIXTURE_PATH,
      `${JSON.stringify({ ...fixture, data: liveRows }, null, 2)}\n`,
    );
    process.stdout.write(`\nWrote the live payload to ${FIXTURE_PATH}.\n`);
  } else {
    process.stdout.write(
      "\nRe-run with --write to overwrite the fixture with the live payload.\n",
    );
    process.exitCode = 1;
  }
}

await main();
