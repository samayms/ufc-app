/**
 * Watches for the Sherdog fight-outlook (preview) article to be published.
 * Sleeps until 3 days before the event, then checks twice daily until the
 * article is found or the event has started. Meant to be started once and
 * left running (e.g. in a background terminal) during fight week.
 *
 *   npm run sherdog:outlook:watch
 *   npm run sherdog:outlook:watch -- --event "UFC Belgrade" \
 *     --red "Uroš Medić" --blue "Daniel Rodriguez" --starts-at 2026-08-01T17:00:00Z
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "../server/config.ts";
import { loadLiveEventState } from "../server/liveEventState.ts";
import { discoverSherdogOutlookPreview } from "../server/sherdogOutlookDiscovery.ts";
import {
  OUTLOOK_RETRY_INTERVAL_MS,
  hasEventStarted,
  isOutlookWindowOpen,
  msUntilOutlookWindowOpens,
} from "../server/sherdogOutlookSchedule.ts";

const STATE_PATH = path.resolve("data/sherdog-outlook-state.json");

function usage() {
  return `Usage:
  npm run sherdog:outlook:watch
  npm run sherdog:outlook:watch -- --event <name> --red <fighter> \\
    --blue <fighter> --starts-at <ISO 8601>

Without arguments, the script loads ESPN's nearest upcoming UFC card and its
start time. It sleeps until 3 days before the event, then checks Sherdog's
news feed for the fight-outlook article twice daily until it is found or the
event has started.`;
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
      argument !== "--blue" &&
      argument !== "--starts-at"
    ) {
      throw new TypeError(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1]?.trim();
    if (!value || value.startsWith("--")) {
      throw new TypeError(`${argument} needs a value`);
    }
    values[argument.slice(2).replace(/-([a-z])/gu, (_m, c) => c.toUpperCase())] =
      value;
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
    if (typeof arguments_.startsAt !== "string") {
      throw new TypeError("--starts-at is required alongside --red/--blue");
    }
    return {
      eventName:
        arguments_.event ?? `${arguments_.red} vs. ${arguments_.blue}`,
      redFighter: arguments_.red,
      blueFighter: arguments_.blue,
      startsAt: arguments_.startsAt,
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
    startsAt: state.event.startsAt,
  };
}

async function readState() {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function writeState(state) {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function watch(target, options = {}) {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const config = options.config ?? loadConfig(process.env);
  const log = options.log ?? console.log;
  const discover = options.discover ?? discoverSherdogOutlookPreview;

  const cached = await (options.readState ?? readState)();
  if (cached?.eventName === target.eventName && cached.url) {
    log(`Already found: ${cached.url}`);
    log(`\nSHERDOG_FIGHT_OUTLOOK_URL=${cached.url}`);
    return { url: cached.url, cached: true };
  }

  const waitMs = msUntilOutlookWindowOpens(now(), target.startsAt);
  if (waitMs > 0) {
    log(
      `Outlook discovery window opens in ${Math.round(waitMs / (60 * 60 * 1000))}h. Sleeping until then...`,
    );
    await sleep(waitMs);
  }

  while (true) {
    log(
      `Searching Sherdog for the ${target.eventName} outlook (${target.redFighter} vs. ${target.blueFighter})...`,
    );

    let match;
    try {
      match = await discover(target, {
        permissionScope: config.sherdog.permissionScope,
        baseUrl: config.sherdog.baseUrl,
      });
    } catch (error) {
      if (error instanceof Error && /responded 403/u.test(error.message)) {
        log(
          "Sherdog responded 403. Stopping per policy: do not rotate proxies, identities, or user agents.",
        );
        throw error;
      }
      log(
        `Discovery attempt failed (${error instanceof Error ? error.message : String(error)}); will retry.`,
      );
      match = undefined;
    }

    if (match !== undefined) {
      log(`\n${match.title}`);
      log(match.url);
      log(`\nSHERDOG_FIGHT_OUTLOOK_URL=${match.url}`);
      await (options.writeState ?? writeState)({
        eventName: target.eventName,
        url: match.url,
        foundAt: now().toISOString(),
      });
      return { url: match.url, cached: false };
    }

    if (hasEventStarted(now(), target.startsAt)) {
      log(
        "The event has started and no fight outlook was ever found. Stopping.",
      );
      return { url: undefined, cached: false };
    }

    log(
      `Not published yet. Checking again in ${OUTLOOK_RETRY_INTERVAL_MS / (60 * 60 * 1000)}h.`,
    );
    await sleep(OUTLOOK_RETRY_INTERVAL_MS);
  }
}

async function run() {
  const arguments_ = readArguments(process.argv.slice(2));
  if (arguments_.help) {
    console.log(usage());
    return;
  }

  const target = await targetFromArguments(arguments_);
  const result = await watch(target);
  if (result.url === undefined) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
