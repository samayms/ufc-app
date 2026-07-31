/**
 * Finds the current card's one-page Sherdog play-by-play through Sherdog's
 * official news RSS feed. It prints the env assignment but never edits .env.
 *
 *   npm run sherdog:find
 *   npm run sherdog:find -- --event "UFC Belgrade" \
 *     --red "Uroš Medić" --blue "Daniel Rodriguez"
 */

import { loadConfig } from "../server/config.ts";
import { loadLiveEventState } from "../server/liveEventState.ts";
import { discoverSherdogLiveBlog } from "../server/sherdogDiscovery.ts";

function usage() {
  return `Usage:
  npm run sherdog:find
  npm run sherdog:find -- --event <name> --red <fighter> --blue <fighter>

Without fighter arguments, the script loads ESPN's nearest upcoming UFC card.
It reads Sherdog only when SHERDOG_PERMISSION_SCOPE permits it.`;
}

function readArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      values.help = true;
      continue;
    }
    if (
      argument !== "--event" &&
      argument !== "--red" &&
      argument !== "--blue"
    ) {
      throw new TypeError(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1]?.trim();
    if (!value || value.startsWith("--")) {
      throw new TypeError(`${argument} needs a value`);
    }
    values[argument.slice(2)] = value;
    index += 1;
  }
  return values;
}

function mainEvent(event) {
  return [...event.bouts].sort(
    (left, right) => left.cardPosition - right.cardPosition,
  )[0];
}

async function targetFromArguments(arguments_) {
  const hasRed = typeof arguments_.red === "string";
  const hasBlue = typeof arguments_.blue === "string";
  if (hasRed !== hasBlue) {
    throw new TypeError("--red and --blue must be provided together");
  }
  if (hasRed && hasBlue) {
    return {
      eventName:
        arguments_.event ?? `${arguments_.red} vs. ${arguments_.blue}`,
      redFighter: arguments_.red,
      blueFighter: arguments_.blue,
    };
  }

  const state = await loadLiveEventState({ scorecardAccounts: [] });
  const bout = mainEvent(state.event);
  if (bout === undefined) {
    throw new Error(`ESPN returned no bouts for ${state.event.name}`);
  }
  return {
    eventName: state.event.name,
    redFighter: bout.fighters.red.name,
    blueFighter: bout.fighters.blue.name,
  };
}

async function run() {
  const arguments_ = readArguments(process.argv.slice(2));
  if (arguments_.help) {
    console.log(usage());
    return;
  }

  const config = loadConfig(process.env);
  const target = await targetFromArguments(arguments_);
  console.log(
    `Searching Sherdog for ${target.eventName} (${target.redFighter} vs. ${target.blueFighter})...`,
  );
  const match = await discoverSherdogLiveBlog(target, {
    permissionScope: config.sherdog.permissionScope,
    baseUrl: config.sherdog.baseUrl,
  });
  if (match === undefined) {
    console.error(
      "Sherdog has not published the matching play-by-play in its news feed yet. Re-run this command closer to the event.",
    );
    process.exitCode = 2;
    return;
  }

  console.log(`\n${match.title}`);
  console.log(match.url);
  console.log(`\nSHERDOG_LIVE_BLOG_URL=${match.url}`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
