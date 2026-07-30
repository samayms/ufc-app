#!/usr/bin/env node
/**
 * Runs one real round of Sherdog play-by-play through the live Gemini
 * summarizer and prints the result, so the summary can be judged and the
 * prompt tweaked before a card is on.
 *
 * With `--write`, the summary is also injected into the fixture simulator's
 * live bout so it renders in the round-summary box at `npm run dev`.
 *
 *   node --env-file-if-exists=.env scripts/previewRoundSummary.mjs
 *   node --env-file-if-exists=.env scripts/previewRoundSummary.mjs --round 5 --write
 *   node --env-file-if-exists=.env scripts/previewRoundSummary.mjs --show-prompt
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLiveGeminiSummarizer } from "../server/geminiSummarizer.ts";
import {
  ROUND_SUMMARY_LINE_CHARS,
  ROUND_SUMMARY_MAX_CHARS,
  buildRoundSummaryPrompt,
} from "../src/sources/roundSummary.ts";
import { parseSherdogRoundObservations } from "../src/sources/sherdog.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

/** The captured real page; the bout is the one whose rounds we summarize. */
const PAGE = fileURLToPath(
  new URL("../src/fixtures/sherdogLivePage.html", import.meta.url),
);
const SHERDOG_FIXTURE = fileURLToPath(
  new URL("../src/fixtures/sherdog.json", import.meta.url),
);
const SOURCE_URL =
  "https://www.sherdog.com/news/news/UFC-Oklahoma-City-Du-Plessis-vs-Usman-playbyplay-results-round-scoring-201960";

const redName = value("red", "Dricus Du Plessis");
const blueName = value("blue", "Kamaru Usman");
const round = Number(value("round", "5"));

const observations = await parseSherdogRoundObservations({
  boutId: "preview",
  html: readFileSync(PAGE, "utf8"),
  sourceUrl: SOURCE_URL,
  fetchedAt: new Date().toISOString(),
  fighterNames: { red: redName, blue: blueName },
});
const observation = observations.find((entry) => entry.round === round);
if (observation === undefined) {
  console.error(
    `No round ${round} for ${redName} vs ${blueName}. Rounds on the page: ${observations
      .map((entry) => entry.round)
      .join(", ")}`,
  );
  process.exit(1);
}

const summaryInput = {
  round,
  redName,
  blueName,
  commentary: observation.commentary,
  scorerCards: observation.scorerCards,
};

console.log(`${redName} vs ${blueName}, round ${round}`);
console.log(
  `Play-by-play in: ${observation.commentary.length} chars, ` +
    `${observation.scorerCards.length} scorer cards`,
);

if (flag("show-prompt")) {
  console.log("\n----- prompt -----");
  console.log(buildRoundSummaryPrompt(summaryInput));
  console.log("----- end prompt -----\n");
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("\nGEMINI_API_KEY is not set; nothing to call.");
  process.exit(1);
}

const model = process.env.GEMINI_MODEL || undefined;
const summary = await createLiveGeminiSummarizer({
  apiKey,
  ...(model ? { model } : {}),
  timeoutMs: 30_000,
}).summarize(summaryInput);

if (summary.length === 0) {
  console.error(
    "\nThe model returned nothing. The summarizer swallows failures by design, " +
      "so re-run the request directly to see the error:\n" +
      `  curl -sS -X POST "https://generativelanguage.googleapis.com/v1beta/models/${
        model ?? "gemini-3.5-flash-lite"
      }:generateContent" \\\n` +
      '    -H "x-goog-api-key: $GEMINI_API_KEY" -H "content-type: application/json" \\\n' +
      '    -d \'{"contents":[{"parts":[{"text":"hi"}]}]}\'',
  );
  process.exit(1);
}

console.log(
  `\nSummary: ${summary.length}/${ROUND_SUMMARY_MAX_CHARS} chars, ` +
    `about ${Math.ceil(summary.length / ROUND_SUMMARY_LINE_CHARS)} of 5 lines` +
    `${summary.includes("—") || summary.includes("–") ? ", CONTAINS A DASH" : ""}`,
);
console.log("\n" + wrap(summary, ROUND_SUMMARY_LINE_CHARS));

if (flag("write")) {
  const fixture = JSON.parse(readFileSync(SHERDOG_FIXTURE, "utf8"));
  fixture.boutEntries["bout-main"] = {
    html: `<article class="fight-card live-blog">\n  <section class="round">\n    <h3>Round 2</h3>\n    <p>${escapeHtml(
      summary,
    )}</p>\n  </section>\n</article>\n`,
  };
  writeFileSync(SHERDOG_FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(
    "\nWritten into src/fixtures/sherdog.json as bout-main round 2. " +
      "Run `npm run dev` and open the live bout to see it in the box.",
  );
}

/** Mirrors how the clamp breaks lines, so the printed shape matches the box. */
function wrap(text, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.map((entry, index) => `${index + 1} | ${entry}`).join("\n");
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
