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
import { LabTimeline } from "./timeline.ts";
import { LabWatcher } from "./watcher.ts";
import { findProbe, PROBES, requiredEnvNames, runProbe } from "./probes.ts";
import type { WatchTarget } from "./contract.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 5055;
const MAX_BODY_BYTES = 256 * 1024;

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
    ...(numberField(source, "espnIntervalMs") === undefined
      ? {}
      : { espnIntervalMs: numberField(source, "espnIntervalMs") as number }),
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
