/**
 * The Lab — `npm run lab`, then http://localhost:5055.
 *
 * A deliberately separate process from the collector. It shares no state with
 * it, holds no lifecycle machine, and imports no React, so it stays usable in
 * exactly the situation it exists for: the dashboard is showing nothing and you
 * need to know which source is at fault, and by how many seconds.
 *
 * Two things it does:
 *   1. one button per API call, with status, latency, and the shipped parser's
 *      verdict on the payload,
 *   2. a timeline that stamps every observation with its delay from the moment
 *      you pressed "round ended" on the broadcast.
 *
 * It is read-only against every vendor. The single exception is the Gemini
 * probe, which spends money and is labelled accordingly.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
import citoWeekendBouts from "../../src/fixtures/citoEventBoutsLive.json" with {
  type: "json",
};
import espnWeekendScoreboard from "../../src/fixtures/espnScoreboardWeekend.json" with {
  type: "json",
};
import { matchFighterPair } from "../../src/lib/boutMatch.ts";
import { LabTimeline } from "./timeline.ts";
import { LabWatcher } from "./watcher.ts";
import {
  findProbe,
  PROBES,
  requiredEnvNames,
  runProbe,
  WEEKEND,
} from "./probes.ts";
import type { LabCard, LabFight, WatchTarget } from "./contract.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 5055;
const MAX_BODY_BYTES = 256 * 1024;
const LAB_CITO_INTERVAL_MS = 5_000;
const LAB_ESPN_INTERVAL_MS = 5_000;
const LAB_KALSHI_INTERVAL_MS = 5_000;
const WEEKEND_EVENT_NAME = "UFC Fight Night: Medić vs. Rodriguez";
const WEEKEND_EVENT_DATE = "2026-08-01";

function arrayField(source: unknown, name: string): unknown[] {
  const value = (source as Record<string, unknown> | null)?.[name];
  return Array.isArray(value) ? value : [];
}

function espnFightOptions(source: unknown): Array<{
  id: string;
  firstFighter: string;
  secondFighter: string;
  firstAthleteId: string;
  secondAthleteId: string;
}> {
  const events = arrayField(source, "events");
  return events.flatMap((event) =>
    arrayField(event, "competitions").flatMap((competition) => {
      const id = stringField(competition, "id");
      const athletes = arrayField(competition, "competitors").flatMap(
        (competitor) => {
          const athlete = (competitor as { athlete?: unknown } | null)?.athlete;
          const athleteId = stringField(competitor, "id");
          const name =
            stringField(athlete, "displayName") ??
            stringField(athlete, "fullName");
          return name === undefined || athleteId === undefined
            ? []
            : [{ name, athleteId }];
        },
      );
      const first = athletes[0];
      const second = athletes[1];
      return id === undefined || first === undefined || second === undefined
        ? []
        : [
            {
              id,
              firstFighter: first.name,
              secondFighter: second.name,
              firstAthleteId: first.athleteId,
              secondAthleteId: second.athleteId,
            },
          ];
    }),
  );
}

/**
 * Reduces the captured weekend card to the only choices the operator needs.
 * Vendor ids stay behind the select control instead of becoming form fields.
 */
export function buildLabCard(
  source: unknown,
  espnSource: unknown = espnWeekendScoreboard,
): LabCard {
  const rows = arrayField(source, "data");
  const espnFights = espnFightOptions(espnSource);
  const fights = rows
    .map((row): (LabFight & { order: number }) | null => {
      const id = stringField(row, "id");
      if (id === undefined) return null;

      const fighters = arrayField(row, "fighters");
      const red = fighters.find(
        (fighter) => stringField(fighter, "corner") === "red",
      );
      const blue = fighters.find(
        (fighter) => stringField(fighter, "corner") === "blue",
      );
      const redName = stringField(red, "fighterName");
      const blueName = stringField(blue, "fighterName");
      if (redName === undefined || blueName === undefined) return null;

      const redSlug = stringField(red, "fighterSlug");
      const blueSlug = stringField(blue, "fighterSlug");
      const espnMatch = espnFights
        .map((fight) => ({
          fight,
          match: matchFighterPair(
            { redFighter: redName, blueFighter: blueName },
            {
              redFighter: fight.firstFighter,
              blueFighter: fight.secondFighter,
            },
          ),
        }))
        .sort((left, right) => right.match.confidence - left.match.confidence)[0];
      const matchedEspn =
        espnMatch !== undefined && espnMatch.match.confidence >= 0.85
          ? espnMatch
          : undefined;
      const redEspnAthleteId =
        matchedEspn === undefined
          ? undefined
          : matchedEspn.match.cornersReversed
            ? matchedEspn.fight.secondAthleteId
            : matchedEspn.fight.firstAthleteId;
      const blueEspnAthleteId =
        matchedEspn === undefined
          ? undefined
          : matchedEspn.match.cornersReversed
            ? matchedEspn.fight.firstAthleteId
            : matchedEspn.fight.secondAthleteId;
      return {
        id,
        ...(matchedEspn === undefined
          ? {}
          : { espnBoutId: matchedEspn.fight.id }),
        cardSection: stringField(row, "cardSection") ?? "Card",
        cardPosition: stringField(row, "cardPosition") ?? "",
        weightClass: (stringField(row, "weightClass") ?? "Bout").replace(
          /\s+Bout$/u,
          "",
        ),
        red: {
          name: redName,
          ...(redSlug === undefined ? {} : { slug: redSlug }),
          ...(redEspnAthleteId === undefined
            ? {}
            : { espnAthleteId: redEspnAthleteId }),
        },
        blue: {
          name: blueName,
          ...(blueSlug === undefined ? {} : { slug: blueSlug }),
          ...(blueEspnAthleteId === undefined
            ? {}
            : { espnAthleteId: blueEspnAthleteId }),
        },
        order: numberField(row, "boutOrder") ?? Number.MAX_SAFE_INTEGER,
      };
    })
    .filter((fight): fight is LabFight & { order: number } => fight !== null)
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...fight }) => fight);

  const firstBout = rows[0];
  return {
    eventName: WEEKEND_EVENT_NAME,
    eventDate: WEEKEND_EVENT_DATE,
    eventSlug: stringField(firstBout, "eventSlug") ?? WEEKEND.citoEventSlug,
    pollIntervalMs: LAB_CITO_INTERVAL_MS,
    fights,
  };
}

const LAB_CARD = buildLabCard(citoWeekendBouts);

/** The page is read from disk per request so an edit needs no restart. */
function readPage(): string {
  return readFileSync(join(HERE, "page.html"), "utf8");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (bytes === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function stringField(source: unknown, name: string): string | undefined {
  const value = (source as Record<string, unknown> | null)?.[name];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberField(source: unknown, name: string): number | undefined {
  const value = (source as Record<string, unknown> | null)?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Only string params survive; the probes treat everything as text anyway. */
function paramsField(source: unknown): Record<string, string> {
  const raw = (source as { params?: unknown } | null)?.params;
  if (typeof raw !== "object" || raw === null) return {};
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") params[key] = value;
  }
  return params;
}

function watchTargetField(source: unknown): WatchTarget {
  const boutIds = (source as { citoBoutIds?: unknown } | null)?.citoBoutIds;
  return {
    ...(stringField(source, "espnEventId") === undefined
      ? {}
      : { espnEventId: stringField(source, "espnEventId") as string }),
    ...(stringField(source, "espnBoutId") === undefined
      ? {}
      : { espnBoutId: stringField(source, "espnBoutId") as string }),
    ...(stringField(source, "espnRedAthleteId") === undefined
      ? {}
      : {
          espnRedAthleteId: stringField(source, "espnRedAthleteId") as string,
        }),
    ...(stringField(source, "espnBlueAthleteId") === undefined
      ? {}
      : {
          espnBlueAthleteId: stringField(source, "espnBlueAthleteId") as string,
        }),
    ...(stringField(source, "citoEventSlug") === undefined
      ? {}
      : { citoEventSlug: stringField(source, "citoEventSlug") as string }),
    ...(Array.isArray(boutIds)
      ? {
          citoBoutIds: boutIds
            .filter((id): id is string => typeof id === "string")
            .map((id) => id.trim())
            .filter((id) => id.length > 0),
        }
      : {}),
    ...(stringField(source, "sherdogUrl") === undefined
      ? {}
      : { sherdogUrl: stringField(source, "sherdogUrl") as string }),
    ...((source as { continuousEspn?: unknown } | null)?.continuousEspn === true
      ? { continuousEspn: true }
      : {}),
    ...(numberField(source, "espnIntervalMs") === undefined
      ? {}
      : { espnIntervalMs: numberField(source, "espnIntervalMs") as number }),
    ...(numberField(source, "espnStatsIntervalMs") === undefined
      ? {}
      : {
          espnStatsIntervalMs: numberField(
            source,
            "espnStatsIntervalMs",
          ) as number,
        }),
    ...(numberField(source, "citoIntervalMs") === undefined
      ? {}
      : { citoIntervalMs: numberField(source, "citoIntervalMs") as number }),
    ...(numberField(source, "sherdogIntervalMs") === undefined
      ? {}
      : {
          sherdogIntervalMs: numberField(source, "sherdogIntervalMs") as number,
        }),
  };
}

export interface LabServerOptions {
  port?: number;
  host?: string;
  env?: Record<string, string | undefined>;
  /** JSONL log of every timeline entry. Set to null to keep it in memory only. */
  timelineFile?: string | null;
}

export function createLabServer(options: LabServerOptions = {}) {
  const env = options.env ?? process.env;
  const timelineFile =
    options.timelineFile === undefined
      ? join(process.cwd(), "data", "lab-timeline.jsonl")
      : options.timelineFile;

  if (timelineFile !== null) {
    mkdirSync(dirname(timelineFile), { recursive: true });
  }

  const timeline = new LabTimeline({
    ...(timelineFile === null
      ? {}
      : { appendFile: (line: string) => appendFileSync(timelineFile, line) }),
  });
  const watcher = new LabWatcher({ timeline, env });
  const startedAt = new Date().toISOString();

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // A handler failing must never take the lab down mid-card.
      if (!response.headersSent) sendJson(response, 500, { error: message });
      else response.end();
    });
  });

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";

    if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const page = readPage();
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(page),
        "cache-control": "no-store",
      });
      response.end(page);
      return;
    }

    if (method === "GET" && url.pathname === "/lab/health") {
      sendJson(response, 200, {
        ok: true,
        startedAt,
        entries: timeline.size,
        ...(timelineFile === null ? {} : { timelineFile }),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/lab/card") {
      sendJson(response, 200, {
        ...LAB_CARD,
        citoReady:
          (env.CITO_API_KEY?.trim() ?? "").length > 0 &&
          (env.CITO_API_BASE_URL?.trim() ?? "").length > 0,
      });
      return;
    }

    if (method === "GET" && url.pathname === "/lab/probes") {
      const present: Record<string, boolean> = {};
      for (const name of requiredEnvNames()) {
        present[name] = (env[name]?.trim() ?? "").length > 0;
      }
      sendJson(response, 200, {
        probes: PROBES.map((probe) => probe.descriptor),
        env: present,
      });
      return;
    }

    if (method === "POST" && url.pathname === "/lab/probe") {
      const body = await readBody(request);
      const id = stringField(body, "id");
      if (id === undefined) {
        sendJson(response, 400, { error: "id is required" });
        return;
      }
      const definition = findProbe(id);
      if (definition === undefined) {
        sendJson(response, 404, { error: `no probe named ${id}` });
        return;
      }

      const result = await runProbe(definition, paramsField(body), {
        env,
        fetchImpl: globalThis.fetch,
        now: () => Date.now(),
      });

      // Probe runs land on the timeline too: on fight night, "I pressed this
      // and it was empty at 22:14:03" is itself a measurement.
      timeline.record({
        kind: "probe",
        source: definition.descriptor.group,
        at: result.startedAt,
        label: `${id}: ${result.ok ? "ok" : "FAIL"} ${result.httpStatus ?? "-"} in ${result.ms}ms — ${result.summary[0] ?? ""}`,
        ...(numberField(paramsField(body), "round") === undefined
          ? {}
          : { round: Number(paramsField(body).round) }),
        ...(paramsField(body).boutId === undefined
          ? {}
          : { boutId: paramsField(body).boutId }),
      });

      // 200 even for a failed probe: the failure is the payload, not an error.
      sendJson(response, 200, result);
      return;
    }

    if (method === "GET" && url.pathname === "/lab/timeline") {
      const since = Number(url.searchParams.get("since") ?? "0");
      sendJson(response, 200, {
        entries: timeline.since(Number.isFinite(since) ? since : 0),
        latestSeq: timeline.latestSeq,
        watch: watcher.status(),
        serverTime: new Date().toISOString(),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/lab/marker") {
      const body = await readBody(request);
      const label = stringField(body, "label") ?? "marker";
      const round = numberField(body, "round");
      const boutId = stringField(body, "boutId");
      const entry = timeline.record({
        kind: "marker",
        source: "user",
        label,
        ...(round === undefined ? {} : { round }),
        ...(boutId === undefined ? {} : { boutId }),
      });

      // Only a round *ending* starts the chase. "Fight started" must not spend
      // quota asking for stats of a round that has not been fought yet.
      if (round !== undefined && /ended|over|finish/iu.test(label)) {
        watcher.markRoundEnded(round, boutId);
      }
      sendJson(response, 200, entry);
      return;
    }

    if (method === "POST" && url.pathname === "/lab/round/end") {
      const body = await readBody(request);
      const boutId = stringField(body, "boutId");
      const round = numberField(body, "round");
      const fight = LAB_CARD.fights.find((candidate) => candidate.id === boutId);
      if (boutId === undefined || fight === undefined) {
        sendJson(response, 400, {
          error: "Select a fight from this weekend's card",
        });
        return;
      }
      if (
        round === undefined ||
        !Number.isSafeInteger(round) ||
        round < 1 ||
        round > 5
      ) {
        sendJson(response, 400, { error: "Round must be between 1 and 5" });
        return;
      }

      watcher.stop();
      const entry = timeline.record({
        kind: "marker",
        source: "user",
        label: "round ended (broadcast)",
        boutId,
        round,
      });
      watcher.start({
        boutId,
        round,
        espnEventId: WEEKEND.espnEventId,
        ...(fight.espnBoutId === undefined
          ? {}
          : { espnBoutId: fight.espnBoutId }),
        ...(fight.red.espnAthleteId === undefined
          ? {}
          : { espnRedAthleteId: fight.red.espnAthleteId }),
        ...(fight.blue.espnAthleteId === undefined
          ? {}
          : { espnBlueAthleteId: fight.blue.espnAthleteId }),
        continuousEspn: true,
        espnIntervalMs: LAB_ESPN_INTERVAL_MS,
        espnStatsIntervalMs: LAB_ESPN_INTERVAL_MS,
        citoBoutIds: [boutId],
        citoIntervalMs: LAB_CITO_INTERVAL_MS,
        redFighter: fight.red.name,
        blueFighter: fight.blue.name,
        kalshiIntervalMs: LAB_KALSHI_INTERVAL_MS,
      });
      sendJson(response, 200, { entry, watch: watcher.status() });
      return;
    }

    if (method === "POST" && url.pathname === "/lab/fight/start") {
      const body = await readBody(request);
      const boutId = stringField(body, "boutId");
      const fight = LAB_CARD.fights.find((candidate) => candidate.id === boutId);
      if (boutId === undefined || fight === undefined) {
        sendJson(response, 400, {
          error: "Select a fight from this weekend's card",
        });
        return;
      }
      if (fight.espnBoutId === undefined) {
        sendJson(response, 400, {
          error: "The selected fight has no matching ESPN bout id",
        });
        return;
      }

      watcher.stop();
      const entry = timeline.record({
        kind: "marker",
        source: "user",
        label: "fight started (broadcast)",
        boutId,
      });
      watcher.start({
        boutId,
        espnEventId: WEEKEND.espnEventId,
        espnBoutId: fight.espnBoutId,
        ...(fight.red.espnAthleteId === undefined
          ? {}
          : { espnRedAthleteId: fight.red.espnAthleteId }),
        ...(fight.blue.espnAthleteId === undefined
          ? {}
          : { espnBlueAthleteId: fight.blue.espnAthleteId }),
        continuousEspn: true,
        espnIntervalMs: LAB_ESPN_INTERVAL_MS,
        espnStatsIntervalMs: LAB_ESPN_INTERVAL_MS,
      });
      sendJson(response, 200, { entry, watch: watcher.status() });
      return;
    }

    if (method === "POST" && url.pathname === "/lab/watch/start") {
      const body = await readBody(request);
      sendJson(response, 200, watcher.start(watchTargetField(body)));
      return;
    }

    if (method === "POST" && url.pathname === "/lab/watch/stop") {
      sendJson(response, 200, watcher.stop());
      return;
    }

    sendJson(response, 404, { error: `no route for ${method} ${url.pathname}` });
  }

  return {
    server,
    timeline,
    watcher,
    listen(port = options.port ?? DEFAULT_PORT, host = options.host ?? "127.0.0.1") {
      return new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.once("listening", () => {
          const address = server.address();
          resolve(typeof address === "object" && address !== null ? address.port : port);
        });
        server.listen(port, host);
      });
    },
    close() {
      watcher.stop();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  const port = Number(process.env.LAB_PORT ?? DEFAULT_PORT);
  const lab = createLabServer({ port: Number.isFinite(port) ? port : DEFAULT_PORT });
  const bound = await lab.listen();
  process.stdout.write(
    [
      `lab listening on http://localhost:${bound}`,
      `${PROBES.length} probes; timeline -> data/lab-timeline.jsonl`,
      "",
    ].join("\n"),
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void lab.close().then(() => process.exit(0));
    });
  }
}
