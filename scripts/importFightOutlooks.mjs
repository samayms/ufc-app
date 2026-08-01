#!/usr/bin/env node
/**
 * Runs the full fight-outlook pipeline for the real upcoming card: discovers
 * Sherdog's main-card and prelims preview articles, fetches and splits them
 * into per-bout write-ups, matches each to the real ESPN bout, and
 * summarizes each with the live Gemini model.
 *
 * This is a paid, real-network, real-API run — it is not the mocked
 * fixture/live boundary the rest of the app respects. Get the extraction
 * logic right against fixtures first (see server/sherdogOutlookContent.test.ts
 * and server/sherdogOutlookSummarizer.test.ts); only run this for real once,
 * not in a loop while iterating.
 *
 *   node --env-file-if-exists=.env scripts/importFightOutlooks.mjs
 *   node --env-file-if-exists=.env scripts/importFightOutlooks.mjs --write
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../server/config.ts";
import { loadLiveEventState } from "../server/liveEventState.ts";
import {
  discoverSherdogOutlookPreview,
  discoverSherdogPrelimsOutlookPreview,
} from "../server/sherdogOutlookDiscovery.ts";
import {
  SherdogForbiddenError,
  collectSherdogOutlookContent,
} from "../server/sherdogOutlookContent.ts";
import { createLiveFightOutlookSummarizer } from "../server/sherdogOutlookSummarizer.ts";
import {
  FIGHT_OUTLOOK_MAX_CHARS,
  FIGHT_OUTLOOK_MIN_CHARS,
} from "../src/sources/fightOutlook.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);

const FIXTURE_PATH = fileURLToPath(
  new URL("../src/fixtures/fightOutlooks.json", import.meta.url),
);

function wordCount(text) {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/u).length;
}

async function run() {
  const config = loadConfig(process.env);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set; nothing to summarize with.");
    process.exitCode = 1;
    return;
  }

  console.log("Loading the real upcoming ESPN card...");
  const state = await loadLiveEventState({ scorecardAccounts: [] });
  const event = state.event;
  const bouts = [...event.bouts].sort(
    (left, right) => left.cardPosition - right.cardPosition,
  );
  const mainCardBouts = bouts.filter((bout) => bout.segment === "main-card");
  console.log(
    `${event.name}: ${bouts.length} bouts (${mainCardBouts.length} main card, ` +
      `${bouts.length - mainCardBouts.length} prelims/early-prelims).`,
  );
  if (bouts.length === 0) {
    console.error("ESPN returned no bouts; nothing to import.");
    process.exitCode = 1;
    return;
  }

  const mainEvent = mainCardBouts[0] ?? bouts[0];
  console.log("\nDiscovering the Sherdog main-card preview article...");
  const mainArticle = await discoverSherdogOutlookPreview(
    {
      eventName: event.name,
      redFighter: mainEvent.fighters.red.name,
      blueFighter: mainEvent.fighters.blue.name,
    },
    {
      permissionScope: config.sherdog.permissionScope,
      baseUrl: config.sherdog.baseUrl,
    },
  );
  if (mainArticle === undefined) {
    console.error(
      "Sherdog has not published the main-card preview yet. Re-run closer to the event.",
    );
    process.exitCode = 2;
    return;
  }
  console.log(`Found: ${mainArticle.title}\n  ${mainArticle.url}`);

  console.log("\nDiscovering the Sherdog prelims preview article...");
  const prelimsArticle = await discoverSherdogPrelimsOutlookPreview(
    { eventName: event.name },
    {
      permissionScope: config.sherdog.permissionScope,
      baseUrl: config.sherdog.baseUrl,
    },
  );
  if (prelimsArticle === undefined) {
    console.warn(
      "No prelims preview found yet; continuing with the main card only.",
    );
  } else {
    console.log(`Found: ${prelimsArticle.title}\n  ${prelimsArticle.url}`);
  }

  const prelimsBoutCount = bouts.length - mainCardBouts.length;
  console.log(
    `\nFetching ${mainCardBouts.length} main-card page(s)` +
      `${prelimsArticle ? ` and ${prelimsBoutCount} prelims page(s)` : ""}...`,
  );
  let matches;
  try {
    matches = await collectSherdogOutlookContent(
      {
        baseArticleUrl: mainArticle.url,
        mainCardBoutCount: mainCardBouts.length,
        ...(prelimsArticle === undefined
          ? {}
          : { prelimsArticleUrl: prelimsArticle.url, prelimsBoutCount }),
        bouts,
      },
      {
        permissionScope: config.sherdog.permissionScope,
        baseUrl: config.sherdog.baseUrl,
      },
    );
  } catch (error) {
    if (error instanceof SherdogForbiddenError) {
      console.error(`\n${error.message}`);
      console.error("Stopping per policy: no retries, no UA/proxy rotation.");
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  console.log(`Matched ${matches.length} of ${bouts.length} bouts to preview text.`);
  const unmatched = bouts.filter(
    (bout) => !matches.some((match) => match.bout.id === bout.id),
  );
  if (unmatched.length > 0) {
    console.warn(
      `No preview text found for: ${unmatched
        .map((bout) => `${bout.fighters.red.name} vs ${bout.fighters.blue.name}`)
        .join(", ")}`,
    );
  }

  const model = process.env.GEMINI_MODEL || undefined;
  const summarizer = createLiveFightOutlookSummarizer({
    apiKey,
    ...(model ? { model } : {}),
    timeoutMs: 30_000,
  });

  const results = [];
  for (const match of matches) {
    const { bout, rawPreviewText } = match;
    const label = `${bout.fighters.red.name} vs ${bout.fighters.blue.name}`;
    process.stdout.write(`Summarizing ${label}... `);
    const outlook = await summarizer.summarize({
      redName: bout.fighters.red.name,
      blueName: bout.fighters.blue.name,
      weightClass: bout.weightClass,
      titleFight: bout.titleFight,
      rawPreviewText,
    });
    if (outlook.length === 0) {
      console.log("FAILED (empty result; see server logs / re-run to inspect)");
      continue;
    }
    const words = wordCount(outlook);
    const inBudget =
      outlook.length >= FIGHT_OUTLOOK_MIN_CHARS &&
      outlook.length <= FIGHT_OUTLOOK_MAX_CHARS;
    console.log(
      `${outlook.length} chars / ${words} words` +
        `${inBudget ? "" : " (OUTSIDE BUDGET)"}`,
    );
    results.push({
      boutId: bout.id,
      redName: bout.fighters.red.name,
      blueName: bout.fighters.blue.name,
      outlook,
    });
  }

  console.log(`\n${results.length} of ${matches.length} matched bouts summarized.`);

  if (flag("write")) {
    writeFileSync(FIXTURE_PATH, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\nWritten ${results.length} outlook(s) to ${FIXTURE_PATH}.`);
  } else {
    console.log("\nRun again with --write to save these into the fixture file.");
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
