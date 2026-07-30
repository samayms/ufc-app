/**
 * The Lab's probe registry — one isolated HTTP call per entry.
 *
 * Every probe is deliberately dumb: build a URL, issue one request, report
 * status/latency/bytes, and run the shipped parser over the payload so you can
 * see the gap between "the vendor answered" and "we understood the answer".
 * That gap is where fight-night failures live, and it is invisible in the app.
 *
 * Isolation rules, so a probe can never be the reason another probe looks dead:
 *   - no shared mutable state between probes,
 *   - no collector, event bus, lifecycle machine, or storage imports,
 *   - only pure URL builders and parsers from `src/sources/*`,
 *   - one probe throwing is caught by `runProbe` and reported as `ok:false`.
 *
 * Identifiers for the 2026-08-01 card (UFC Fight Night: Medić vs. Rodriguez)
 * are prefilled as defaults, all verified live on 2026-07-30.
 */

import { readFileSync } from "node:fs";
import {
  buildEspnScoreboardUrl,
  parseEspnScoreboardLifecycle,
} from "../../src/sources/espn.ts";
import {
  buildEspnAthleteUrl,
  buildEspnFightcenterUrl,
  buildEspnScheduleUrl,
  parseEspnAthleteBio,
  parseEspnFightcenterCard,
  parseEspnScheduleEvents,
} from "../../src/sources/espnSchedule.ts";
import {
  buildCitoRoundRowsUrl,
  buildCitoRoundStatsUrl,
  parseCitoRoundStatsResponse,
} from "../../src/sources/cito.ts";
import { buildKalshiUpcomingUrl } from "../../src/sources/upcoming/kalshiUpcoming.ts";
import { buildPolymarketUpcomingUrl } from "../../src/sources/upcoming/polymarketUpcoming.ts";
import {
  buildOddsApiIoEventsUrl,
  buildOddsApiIoOddsUrl,
} from "../../src/sources/upcoming/oddsApiIoUpcoming.ts";
import { buildTheOddsApiUpcomingUrl } from "../../src/sources/upcoming/theOddsApiUpcoming.ts";
import { parseSherdogRoundObservations } from "../../src/sources/sherdog.ts";
import {
  importKalshiPrivateKey,
  signKalshiRequest,
} from "../../src/sources/kalshiAuth.ts";
import type { ProbeDescriptor, ProbeResult } from "./contract.ts";
import { redactSecrets } from "./contract.ts";

/** The weekend card, as each vendor names it. Verified live 2026-07-30. */
export const WEEKEND = {
  espnEventId: "600059339",
  citoEventSlug: "ufc-fight-night-august-01-2026",
  /** Main Card 1 on Saturday's card — a Cito bout id with no stats yet. */
  citoBoutId: "12879",
  /**
   * A completed bout whose round stats ARE populated. Use it to prove the
   * parser works before the card starts, so a silent round on Saturday is
   * unambiguously Cito being late rather than our parse being wrong.
   */
  citoEnrichedBoutId: "9009ec7b91f2be14",
} as const;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RAW_BYTES = 200_000;
const DEFAULT_COLLECTOR_PORT = 8600;

/** Follows `COLLECTOR_PORT`, so probing a second collector needs no code change. */
function collectorOrigin(context: ProbeContext): string {
  const port = Number(context.env.COLLECTOR_PORT?.trim() ?? "");
  return `http://localhost:${Number.isInteger(port) && port > 0 ? port : DEFAULT_COLLECTOR_PORT}`;
}

/** Vendor quota headers worth surfacing verbatim, whatever the vendor calls it. */
const QUOTA_HEADERS = [
  "x-ratelimit-remaining",
  "x-ratelimit-limit",
  "x-ratelimit-reset",
  "x-requests-remaining",
  "x-requests-used",
  "x-requests-last",
  "retry-after",
];

export interface ProbeContext {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  now: () => number;
}

/** What a probe body returns; `runProbe` adds timing and error handling. */
export interface ProbeOutcome {
  ok: boolean;
  httpStatus?: number;
  bytes?: number;
  url?: string;
  summary: string[];
  parsed?: unknown;
  raw?: unknown;
  rawTruncated?: boolean;
  quota?: Record<string, string>;
}

export interface ProbeDefinition {
  descriptor: ProbeDescriptor;
  run(params: Record<string, string>, context: ProbeContext): Promise<ProbeOutcome>;
}

function param(
  params: Record<string, string>,
  name: string,
  fallback = "",
): string {
  const value = params[name]?.trim();
  return value === undefined || value.length === 0 ? fallback : value;
}

function positiveInt(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function collectQuota(response: Response): Record<string, string> | undefined {
  const quota: Record<string, string> = {};
  for (const header of QUOTA_HEADERS) {
    const value = response.headers.get(header);
    if (value !== null) quota[header] = value;
  }
  return Object.keys(quota).length === 0 ? undefined : quota;
}

/** `array(12)` / `keys:a,b,c` — enough to spot a shape change at a glance. */
function describeShape(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  return `keys:${Object.keys(value as object).slice(0, 8).join(",")}`;
}

/**
 * One HTTP request, fully instrumented. Returns the decoded body alongside the
 * response so each probe only has to write its own summary.
 */
async function request(
  context: ProbeContext,
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{
  response: Response;
  text: string;
  json: unknown;
  bytes: number;
  quota?: Record<string, string>;
}> {
  const response = await context.fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    response,
    text,
    json,
    bytes: new TextEncoder().encode(text).byteLength,
    ...(collectQuota(response) === undefined
      ? {}
      : { quota: collectQuota(response) as Record<string, string> }),
  };
}

/** Keeps an enormous payload from making the page unusable. */
function boundRaw(json: unknown, text: string, bytes: number): {
  raw?: unknown;
  rawTruncated?: boolean;
} {
  if (bytes <= MAX_RAW_BYTES) {
    return { raw: json === undefined ? text.slice(0, MAX_RAW_BYTES) : json };
  }
  return {
    raw: {
      note: `payload is ${bytes} bytes; showing the first ${MAX_RAW_BYTES} characters`,
      preview: text.slice(0, MAX_RAW_BYTES),
    },
    rawTruncated: true,
  };
}

/**
 * A JSON GET probe: everything except the summary is identical across sources,
 * so each definition only supplies the URL, the headers, and what to say.
 */
function jsonProbe(options: {
  descriptor: ProbeDescriptor;
  url(params: Record<string, string>, context: ProbeContext): string;
  headers?(context: ProbeContext): Record<string, string>;
  summarize(input: {
    json: unknown;
    text: string;
    response: Response;
    params: Record<string, string>;
  }): { summary: string[]; parsed?: unknown };
}): ProbeDefinition {
  return {
    descriptor: options.descriptor,
    async run(params, context) {
      const url = options.url(params, context);
      const headers = options.headers?.(context) ?? {};
      const { response, text, json, bytes, quota } = await request(
        context,
        url,
        Object.keys(headers).length === 0 ? {} : { headers },
      );

      const described = response.ok
        ? options.summarize({ json, text, response, params })
        : {
            summary: [
              `HTTP ${response.status} ${response.statusText}`,
              redactSecrets(text.slice(0, 300).replace(/\s+/gu, " ")),
            ],
          };

      return {
        ok: response.ok,
        httpStatus: response.status,
        bytes,
        url: redactSecrets(url),
        summary: [...described.summary, `shape ${describeShape(json)}`],
        ...(described.parsed === undefined ? {} : { parsed: described.parsed }),
        ...boundRaw(json, text, bytes),
        ...(quota === undefined ? {} : { quota }),
      };
    },
  };
}

function citoBase(context: ProbeContext): string {
  const base = context.env.CITO_API_BASE_URL?.trim() ?? "";
  if (base.length === 0) {
    throw new Error("CITO_API_BASE_URL is not set");
  }
  return base.endsWith("/") ? base : `${base}/`;
}

function citoUrl(context: ProbeContext, path: string): string {
  return new URL(path, citoBase(context)).toString();
}

function citoHeaders(context: ProbeContext): Record<string, string> {
  const key = context.env.CITO_API_KEY?.trim() ?? "";
  if (key.length === 0) throw new Error("CITO_API_KEY is not set");
  return { "x-api-key": key };
}

/** Cito wraps everything in `{ success, data, meta }`. */
function citoData(json: unknown): unknown {
  if (typeof json === "object" && json !== null && "data" in json) {
    return (json as { data: unknown }).data;
  }
  return json;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null) {
    const bouts = (value as { bouts?: unknown }).bouts;
    if (Array.isArray(bouts)) return bouts;
  }
  return [];
}

function field(row: unknown, name: string): unknown {
  return typeof row === "object" && row !== null
    ? (row as Record<string, unknown>)[name]
    : undefined;
}

// ---------------------------------------------------------------------------
// ESPN — lifecycle authority. Free, unauthenticated, no quota.
// ---------------------------------------------------------------------------

const espnScoreboard = jsonProbe({
  descriptor: {
    id: "espn.scoreboard",
    group: "espn",
    label: "Scoreboard (one event)",
    description:
      "The lifecycle authority: per-bout state, period, and clock. This is what decides a round is over.",
    cost: "free",
    params: [
      {
        name: "eventId",
        label: "ESPN event id",
        defaultValue: WEEKEND.espnEventId,
      },
    ],
  },
  url: (params) =>
    buildEspnScoreboardUrl(param(params, "eventId", WEEKEND.espnEventId)),
  summarize: ({ json }) => {
    const entries = parseEspnScoreboardLifecycle(json);
    const live = entries.filter((entry) => entry.state === "in");
    const summary = [
      `${entries.length} bouts parsed, ${live.length} in progress`,
      ...entries
        .filter((entry) => entry.state !== "pre")
        .slice(0, 8)
        .map(
          (entry) =>
            `${entry.externalId}: ${entry.state} period ${entry.period} clock ${entry.clockSeconds ?? "-"}s${entry.completed ? " completed" : ""}`,
        ),
    ];
    if (live.length === 0) summary.push("no bout is live yet");
    return { summary, parsed: entries };
  },
});

const espnSchedule = jsonProbe({
  descriptor: {
    id: "espn.schedule",
    group: "espn",
    label: "Schedule window",
    description: "Which events ESPN knows about, and their start times.",
    cost: "free",
    params: [{ name: "days", label: "Days ahead", defaultValue: "10" }],
  },
  url: (params) => {
    const days = positiveInt(param(params, "days", "10"), 10);
    return buildEspnScheduleUrl(
      new Date(Date.now() - 2 * 86_400_000),
      new Date(Date.now() + days * 86_400_000),
    );
  },
  summarize: ({ json }) => {
    const events = parseEspnScheduleEvents(json, new Date());
    return {
      summary: [
        `${events.length} events`,
        ...events
          .slice(0, 8)
          .map((event) => `${event.startsAt} ${event.name} (${event.eventId})`),
      ],
      parsed: events,
    };
  },
});

const espnFightcenter = jsonProbe({
  descriptor: {
    id: "espn.fightcenter",
    group: "espn",
    label: "Fightcenter card",
    description: "The full card: bouts, fighters, and ESPN's own bout ids.",
    cost: "free",
    params: [
      {
        name: "eventId",
        label: "ESPN event id",
        defaultValue: WEEKEND.espnEventId,
      },
    ],
  },
  url: (params) =>
    buildEspnFightcenterUrl(param(params, "eventId", WEEKEND.espnEventId)),
  summarize: ({ json, params }) => {
    const card = parseEspnFightcenterCard(
      json,
      param(params, "eventId", WEEKEND.espnEventId),
    );
    const sections = card?.sections ?? [];
    const fights = sections.flatMap((section) => section.fights);
    return {
      summary: [
        card === null
          ? "parser returned nothing for this event id"
          : `${card.name} at ${card.venue ?? "?"} — ${sections.length} sections, ${fights.length} fights`,
        ...sections.map(
          (section) => `  ${section.displayName}: ${section.fights.length} fights`,
        ),
      ],
      parsed: card,
    };
  },
});

const espnAthlete = jsonProbe({
  descriptor: {
    id: "espn.athlete",
    group: "espn",
    label: "Athlete bio",
    description: "Reach, stance, record — the Tale-of-the-tape source.",
    cost: "free",
    params: [
      {
        name: "athleteId",
        label: "ESPN athlete id",
        // Uroš Medić, Saturday's main event. Ids come from espn.fightcenter.
        defaultValue: "4685870",
      },
    ],
  },
  url: (params) => buildEspnAthleteUrl(param(params, "athleteId", "4685870")),
  summarize: ({ json, params }) => {
    const athlete = field(json, "athlete") ?? json;
    const bio = parseEspnAthleteBio(json, param(params, "athleteId", "4685870"));
    return {
      summary: [
        `${String(field(athlete, "displayName") ?? "?")} — ${String(field(athlete, "displayWeight") ?? "?")}, ${String(field(athlete, "displayHeight") ?? "?")}, reach ${String(field(athlete, "displayReach") ?? "?")}, stance ${String(field(field(athlete, "stance"), "text") ?? "?")}`,
        `our parser: nickname ${bio.nickname ?? "none"}, ${bio.recentBouts.length} recent bouts`,
        ...bio.recentBouts
          .slice(0, 3)
          .map((bout) => `  ${bout.result ?? "?"} vs ${bout.opponentName}`),
      ],
      parsed: bio,
    };
  },
});

// ---------------------------------------------------------------------------
// Cito — round statistics and its own live pipeline. Metered.
// ---------------------------------------------------------------------------

const citoLiveHealth = jsonProbe({
  descriptor: {
    id: "cito.live.health",
    group: "cito-live",
    label: "Live worker health  ← check this first",
    description:
      "Is Cito's live worker even running? On 2026-07-30 it was not (heartbeat 32h stale), so no live bout data would arrive at all.",
    cost: "quota",
    requires: ["CITO_API_KEY"],
  },
  url: (_params, context) => citoUrl(context, "ufc/live/health"),
  headers: citoHeaders,
  summarize: ({ json }) => {
    const data = citoData(json);
    const alive = field(data, "workerAlive") === true;
    const lag = Number(field(data, "freshestHeartbeatLagSeconds"));
    const summary = [
      alive
        ? "live worker: ALIVE"
        : "live worker: DEAD — no live bout data will arrive",
      Number.isFinite(lag)
        ? `heartbeat lag ${Math.round(lag)}s (${(lag / 3600).toFixed(1)}h)`
        : "heartbeat lag unknown",
    ];
    const reason = field(data, "degradedReason") ?? field(data, "emptyReason");
    if (typeof reason === "string") summary.push(`reason: ${reason}`);
    const events = asArray(field(data, "events"));
    summary.push(`${events.length} tracked events`);
    for (const event of events.slice(0, 4)) {
      summary.push(
        `  ${String(field(event, "eventSlug"))}: ${String(field(event, "status"))}, poll ${String(field(event, "pollIntervalMs"))}ms, lag ${String(field(event, "lagSeconds"))}s`,
      );
    }
    return { summary };
  },
});

const citoLive = jsonProbe({
  descriptor: {
    id: "cito.live",
    group: "cito-live",
    label: "Live overview",
    description:
      "Live bouts, clocks, lagSeconds, and Cito's own recommended poll interval.",
    cost: "quota",
    requires: ["CITO_API_KEY"],
  },
  url: (_params, context) => citoUrl(context, "ufc/live"),
  headers: citoHeaders,
  summarize: ({ json }) => {
    const data = citoData(json);
    const liveBouts = asArray(field(data, "liveBouts"));
    const nextBouts = asArray(field(data, "nextBouts"));
    const summary = [
      `liveBouts: ${liveBouts.length}`,
      `nextBouts: ${nextBouts.length}`,
      `nextArmedBout: ${JSON.stringify(field(data, "nextArmedBout"))}`,
    ];
    for (const bout of liveBouts.slice(0, 6)) {
      summary.push(
        `  ${String(field(bout, "boutId") ?? field(bout, "fmid"))}: round ${String(field(bout, "round") ?? field(bout, "roundNumber"))} clock ${String(field(bout, "clock") ?? field(bout, "roundElapsedTime"))} lag ${String(field(bout, "lagSeconds"))}s`,
      );
    }
    if (liveBouts.length === 0) {
      summary.push("nothing live — expected before the card starts");
    }
    return { summary };
  },
});

const citoLiveEvent = jsonProbe({
  descriptor: {
    id: "cito.live.event",
    group: "cito-live",
    label: "Live supervisor (one event)",
    description:
      "Cito's fight-night tracking row for this card. 404 before the worker adopts the event.",
    cost: "quota",
    requires: ["CITO_API_KEY"],
    params: [
      {
        name: "slug",
        label: "Cito event slug",
        defaultValue: WEEKEND.citoEventSlug,
      },
    ],
  },
  url: (params, context) =>
    citoUrl(
      context,
      `ufc/live/events/${encodeURIComponent(param(params, "slug", WEEKEND.citoEventSlug))}`,
    ),
  headers: citoHeaders,
  summarize: ({ json }) => ({
    summary: [`supervisor row present`],
    parsed: citoData(json),
  }),
});

const citoLiveBoutState = jsonProbe({
  descriptor: {
    id: "cito.live.boutState",
    group: "cito-live",
    label: "Live bout state",
    description: "Compact per-bout live clock — the cheapest live poll Cito offers.",
    cost: "quota",
    requires: ["CITO_API_KEY"],
    params: [
      {
        name: "boutId",
        label: "Cito bout id",
        defaultValue: WEEKEND.citoBoutId,
      },
    ],
  },
  url: (params, context) =>
    citoUrl(
      context,
      `ufc/live/${encodeURIComponent(param(params, "boutId", WEEKEND.citoBoutId))}/state`,
    ),
  headers: citoHeaders,
  summarize: ({ json }) => {
    const data = citoData(json);
    return {
      summary: [
        `status ${String(field(data, "status"))}`,
        `round ${String(field(data, "round") ?? field(data, "roundNumber"))}`,
        `clock ${String(field(data, "clock") ?? field(data, "roundElapsedTime"))}`,
        `lag ${String(field(data, "lagSeconds"))}s`,
      ],
      parsed: data,
    };
  },
});

const citoRoundStats = jsonProbe({
  descriptor: {
    id: "cito.round.stats",
    group: "cito",
    label: "Round stats  ← the one that matters",
    description:
      "Per-round striking/grappling for one bout, and what our parser makes of it. `availability` says whether Cito has enriched the round yet.",
    cost: "quota",
    requires: ["CITO_API_KEY"],
    params: [
      {
        name: "boutId",
        label: "Cito bout id",
        defaultValue: WEEKEND.citoBoutId,
      },
      { name: "round", label: "Round", defaultValue: "1" },
    ],
  },
  url: (params, context) =>
    buildCitoRoundStatsUrl(
      citoBase(context),
      param(params, "boutId", WEEKEND.citoBoutId),
      positiveInt(param(params, "round", "1"), 1),
    ),
  headers: citoHeaders,
  summarize: ({ json, params }) => {
    const round = positiveInt(param(params, "round", "1"), 1);
    const data = citoData(json);
    const roundStats = asArray(field(data, "roundStats"));
    const boutStats = asArray(field(data, "boutStats"));
    const availability = field(data, "availability");
    const parsed = parseCitoRoundStatsResponse(json, round);
    const summary = [
      `availability: ${String(availability)}`,
      `roundStats rows: ${roundStats.length} (boutStats rows: ${boutStats.length})`,
      ...roundStats
        .slice(0, 4)
        .map(
          (row) =>
            `  ${String(field(row, "fighterSlug"))} r${String(field(row, "round"))}: sig ${String(field(row, "significantStrikes"))}, td ${String(field(row, "takedowns"))}, ctrl ${String(field(row, "controlTime"))}`,
        ),
      parsed === null
        ? "our parser: NOTHING (round absent as far as the app is concerned)"
        : `our parser: round ${parsed.round}, red ${parsed.fighterA === undefined ? "absent" : "present"}, blue ${parsed.fighterB === undefined ? "absent" : "present"}`,
    ];
    if (roundStats.length === 0) {
      summary.push("Cito has not published this round yet — retry later");
    }
    return { summary, parsed };
  },
});

const citoRoundRows = jsonProbe({
  descriptor: {
    id: "cito.round.rows",
    group: "cito",
    label: "Round rows (subset of round stats)",
    description:
      "The /rounds endpoint. Proven on 2026-07-30 to be a strict subset of /stats, so the live path no longer spends a request on it.",
    cost: "quota",
    requires: ["CITO_API_KEY"],
    params: [
      {
        name: "boutId",
        label: "Cito bout id",
        defaultValue: WEEKEND.citoBoutId,
      },
      { name: "round", label: "Round", defaultValue: "1" },
    ],
  },
  url: (params, context) =>
    buildCitoRoundRowsUrl(
      citoBase(context),
      param(params, "boutId", WEEKEND.citoBoutId),
      positiveInt(param(params, "round", "1"), 1),
    ),
  headers: citoHeaders,
  summarize: ({ json, params }) => {
    const rows = asArray(citoData(json));
    const parsed = parseCitoRoundStatsResponse(
      json,
      positiveInt(param(params, "round", "1"), 1),
    );
    return {
      summary: [
        `${rows.length} rows`,
        ...rows
          .slice(0, 4)
          .map(
            (row) =>
              `  ${String(field(row, "fighterSlug"))}: sig ${String(field(row, "significantStrikes"))}`,
          ),
        parsed === null ? "our parser: NOTHING" : "our parser: parsed",
      ],
      parsed,
    };
  },
});

const citoEventBouts = jsonProbe({
  descriptor: {
    id: "cito.event.bouts",
    group: "cito",
    label: "Card bouts (find the bout ids)",
    description:
      "Every bout on the card with its Cito bout id, status, and corners. Start here to get the ids the other probes need.",
    cost: "quota",
    requires: ["CITO_API_KEY"],
    params: [
      {
        name: "slug",
        label: "Cito event slug",
        defaultValue: WEEKEND.citoEventSlug,
      },
    ],
  },
  url: (params, context) =>
    citoUrl(
      context,
      `ufc/events/${encodeURIComponent(param(params, "slug", WEEKEND.citoEventSlug))}/bouts`,
    ),
  headers: citoHeaders,
  summarize: ({ json }) => {
    const bouts = asArray(citoData(json));
    return {
      summary: [
        `${bouts.length} bouts`,
        ...bouts.map((bout) => {
          const fighters = asArray(field(bout, "fighters"))
            .map(
              (fighter) =>
                `${String(field(fighter, "corner"))}=${String(field(fighter, "fighterName"))}`,
            )
            .join(" ");
          return `  ${String(field(bout, "id"))} ${String(field(bout, "cardPosition"))} [${String(field(bout, "status"))}] hasStats=${String(field(bout, "hasStats"))} ${fighters}`;
        }),
      ],
      parsed: bouts.map((bout) => ({
        id: field(bout, "id"),
        cardPosition: field(bout, "cardPosition"),
        status: field(bout, "status"),
        hasStats: field(bout, "hasStats"),
        fighters: asArray(field(bout, "fighters")).map((fighter) => ({
          corner: field(fighter, "corner"),
          fighterSlug: field(fighter, "fighterSlug"),
          fighterName: field(fighter, "fighterName"),
        })),
      })),
    };
  },
});

const citoEventStats = jsonProbe({
  descriptor: {
    id: "cito.event.stats",
    group: "cito",
    label: "Whole-card round stats (one request)",
    description:
      "Round N for every bout on the card in a single request — one quota unit instead of one per bout.",
    cost: "quota",
    requires: ["CITO_API_KEY"],
    params: [
      {
        name: "slug",
        label: "Cito event slug",
        defaultValue: WEEKEND.citoEventSlug,
      },
      { name: "round", label: "Round", defaultValue: "1" },
    ],
  },
  url: (params, context) =>
    citoUrl(
      context,
      `ufc/events/${encodeURIComponent(param(params, "slug", WEEKEND.citoEventSlug))}/stats?round=${positiveInt(param(params, "round", "1"), 1)}`,
    ),
  headers: citoHeaders,
  summarize: ({ json }) => {
    const rows = asArray(citoData(json));
    const withRows = rows.filter(
      (entry) =>
        asArray(field(entry, "roundStats")).length > 0 ||
        asArray(field(field(entry, "stats"), "roundStats")).length > 0,
    );
    return {
      summary: [
        `${rows.length} bouts, ${withRows.length} with round stats for this round`,
        ...rows
          .slice(0, 14)
          .map((entry) => {
            const boutId = field(entry, "boutId") ?? field(field(entry, "bout"), "id");
            const stats =
              asArray(field(entry, "roundStats")).length ||
              asArray(field(field(entry, "stats"), "roundStats")).length;
            return `  ${String(boutId)}: ${stats} rows`;
          }),
      ],
      parsed: rows,
    };
  },
});

const citoBout = jsonProbe({
  descriptor: {
    id: "cito.bout",
    group: "cito",
    label: "One bout (corners)",
    description:
      "Where red/blue corners come from. Round-stat rows carry only a fighter slug, so this join is what stops the two fighters' stats being swapped.",
    cost: "quota",
    requires: ["CITO_API_KEY"],
    params: [
      {
        name: "boutId",
        label: "Cito bout id",
        defaultValue: WEEKEND.citoBoutId,
      },
    ],
  },
  url: (params, context) =>
    citoUrl(
      context,
      `ufc/bouts/${encodeURIComponent(param(params, "boutId", WEEKEND.citoBoutId))}`,
    ),
  headers: citoHeaders,
  summarize: ({ json }) => {
    const data = citoData(json);
    const fighters = asArray(field(data, "fighters"));
    return {
      summary: [
        `${String(field(data, "cardPosition"))} — ${String(field(data, "weightClass"))}, status ${String(field(data, "status"))}`,
        ...fighters.map(
          (fighter) =>
            `  ${String(field(fighter, "corner"))}: ${String(field(fighter, "fighterName"))} (${String(field(fighter, "fighterSlug"))})`,
        ),
        `dataAvailability.roundStats: ${String(field(field(data, "dataAvailability"), "roundStats"))}`,
      ],
      parsed: data,
    };
  },
});

const citoEventOdds = jsonProbe({
  descriptor: {
    id: "cito.event.odds",
    group: "cito",
    label: "Card odds",
    description: "Cito's own odds for the card, grouped by fight and bookmaker.",
    cost: "quota",
    requires: ["CITO_API_KEY"],
    params: [
      {
        name: "slug",
        label: "Cito event slug",
        defaultValue: WEEKEND.citoEventSlug,
      },
    ],
  },
  url: (params, context) =>
    citoUrl(
      context,
      `ufc/events/${encodeURIComponent(param(params, "slug", WEEKEND.citoEventSlug))}/odds`,
    ),
  headers: citoHeaders,
  summarize: ({ json }) => {
    const data = citoData(json);
    const odds = asArray(field(data, "odds"));
    const books = new Set(
      odds.flatMap((entry) =>
        asArray(field(entry, "bookmakers")).map((book) =>
          String(field(book, "name") ?? field(book, "key")),
        ),
      ),
    );
    return {
      summary: [
        `${odds.length} priced fights`,
        books.size === 0
          ? "no bookmakers named in the payload"
          : `books: ${[...books].slice(0, 10).join(", ")}`,
      ],
      parsed: data,
    };
  },
});

// ---------------------------------------------------------------------------
// Sportsbooks and prediction markets.
// ---------------------------------------------------------------------------

const kalshiEvents = jsonProbe({
  descriptor: {
    id: "kalshi.events",
    group: "kalshi",
    label: "UFC events (public)",
    description:
      "Which bouts have a Kalshi market, and whether the book is two-sided. Needs no credentials.",
    cost: "free",
  },
  url: () => buildKalshiUpcomingUrl(50),
  summarize: ({ json }) => {
    const events = asArray(field(json, "events"));
    const summary = [`${events.length} open events`];
    for (const event of events.slice(0, 14)) {
      const markets = asArray(field(event, "markets"));
      // Prices are decimal-dollar strings (`"0.8500"`), not integer cents —
      // the same field names the shipped transport reads.
      const twoSided = markets.filter(
        (market) =>
          Number(field(market, "yes_bid_dollars")) > 0 &&
          Number(field(market, "yes_ask_dollars")) > 0,
      ).length;
      const liquidity = markets.reduce<number>(
        (total, market) => total + Number(field(market, "liquidity_dollars") ?? 0),
        0,
      );
      summary.push(
        `  ${String(field(event, "event_ticker"))}: ${markets.length} markets, ${twoSided} two-sided, $${liquidity.toFixed(0)} liquidity`,
      );
    }
    return { summary };
  },
});

const kalshiSigned: ProbeDefinition = {
  descriptor: {
    id: "kalshi.signed",
    group: "kalshi",
    label: "Signed request (auth check)",
    description:
      "Signs a real request with the private key. This is the only probe that proves the credentials and the RSA-PSS signing actually work.",
    cost: "free",
    requires: ["KALSHI_API_KEY_ID", "KALSHI_PRIVATE_KEY_PATH"],
  },
  async run(_params, context) {
    const keyPath = context.env.KALSHI_PRIVATE_KEY_PATH?.trim() ?? "";
    const keyId = context.env.KALSHI_API_KEY_ID?.trim() ?? "";
    if (keyPath.length === 0 || keyId.length === 0) {
      throw new Error("KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PATH must be set");
    }

    const pem = readFileSync(keyPath, "utf8");
    const armor = pem.match(/-----BEGIN ([A-Z ]+)-----/u)?.[1] ?? "none";
    const privateKey = await importKalshiPrivateKey(pem);
    const path = "/trade-api/v2/portfolio/balance";
    const headers = await signKalshiRequest(privateKey, keyId, "GET", path);
    const { response, text, json, bytes, quota } = await request(
      context,
      `https://api.elections.kalshi.com${path}`,
      { headers: { ...headers } },
    );

    return {
      ok: response.ok,
      httpStatus: response.status,
      bytes,
      url: `https://api.elections.kalshi.com${path}`,
      summary: [
        `key armor: ${armor}`,
        response.ok
          ? "signature accepted — authenticated Kalshi calls work"
          : `signature rejected: ${redactSecrets(text.slice(0, 200))}`,
      ],
      ...boundRaw(json, text, bytes),
      ...(quota === undefined ? {} : { quota }),
    };
  },
};

const polymarketEvents = jsonProbe({
  descriptor: {
    id: "polymarket.events",
    group: "polymarket",
    label: "UFC events",
    description: "Open UFC markets and their outcome token ids.",
    cost: "free",
  },
  url: () => buildPolymarketUpcomingUrl(30),
  summarize: ({ json }) => {
    const events = Array.isArray(json) ? json : [];
    return {
      summary: [
        `${events.length} events`,
        ...events
          .slice(0, 8)
          .map(
            (event) =>
              `  ${String(field(event, "slug"))} (${asArray(field(event, "markets")).length} markets)`,
          ),
      ],
    };
  },
});

const oddsApiIoEvents = jsonProbe({
  descriptor: {
    id: "oddsapiio.events",
    group: "oddsapiio",
    label: "MMA events",
    description:
      "One vendor event per fight, no card-level id — grouping is derived from the league name.",
    cost: "quota",
    requires: ["ODDS_API_IO_KEY"],
  },
  url: (_params, context) =>
    buildOddsApiIoEventsUrl(context.env.ODDS_API_IO_KEY?.trim() ?? ""),
  summarize: ({ json }) => {
    const events = Array.isArray(json) ? json : [];
    const ufc = events.filter((event) =>
      String(field(field(event, "league"), "name") ?? "")
        .toUpperCase()
        .includes("UFC"),
    );
    return {
      summary: [
        `${events.length} MMA events, ${ufc.length} look like UFC`,
        ...ufc
          .slice(0, 8)
          .map(
            (event) =>
              `  ${String(field(event, "id"))} ${String(field(event, "date"))} ${String(field(event, "home"))} vs ${String(field(event, "away"))} [${String(field(event, "status"))}]`,
          ),
      ],
      parsed: ufc,
    };
  },
});

const oddsApiIoOdds = jsonProbe({
  descriptor: {
    id: "oddsapiio.odds",
    group: "oddsapiio",
    label: "Odds for one event",
    description:
      "Which bookmakers this vendor really has for UFC, and whether prices move during a round.",
    cost: "quota",
    requires: ["ODDS_API_IO_KEY"],
    params: [
      { name: "eventId", label: "Vendor event id", placeholder: "72638588" },
      {
        name: "bookmakers",
        label: "Bookmakers",
        defaultValue: "Bet365,DraftKings",
      },
    ],
  },
  url: (params, context) => {
    if (param(params, "eventId").length === 0) {
      throw new Error(
        "no eventId: run the MMA events probe first and paste one of its ids",
      );
    }
    return buildOddsApiIoOddsUrl(
      context.env.ODDS_API_IO_KEY?.trim() ?? "",
      param(params, "eventId"),
      param(params, "bookmakers", "Bet365,DraftKings")
        .split(",")
        .map((book) => book.trim())
        .filter((book) => book.length > 0),
    );
  },
  summarize: ({ json }) => {
    const bookmakers = field(json, "bookmakers");
    const names =
      typeof bookmakers === "object" && bookmakers !== null
        ? Object.keys(bookmakers as object)
        : [];
    return {
      summary: [
        `bookmakers present: ${names.length === 0 ? "none" : names.join(", ")}`,
      ],
      parsed: json,
    };
  },
});

const theOddsApiH2h = jsonProbe({
  descriptor: {
    id: "theoddsapi.h2h",
    group: "theoddsapi",
    label: "MMA h2h snapshot",
    description:
      "One snapshot of moneyline prices across US books. Watch x-requests-remaining — the allowance is finite.",
    cost: "quota",
    requires: ["THE_ODDS_API_KEY"],
    params: [{ name: "regions", label: "Regions", defaultValue: "us" }],
  },
  url: (params, context) =>
    buildTheOddsApiUpcomingUrl(
      context.env.THE_ODDS_API_KEY?.trim() ?? "",
      param(params, "regions", "us"),
    ),
  summarize: ({ json, response }) => {
    const events = Array.isArray(json) ? json : [];
    return {
      summary: [
        `${events.length} events`,
        `requests remaining: ${response.headers.get("x-requests-remaining") ?? "unknown"}`,
        ...events
          .slice(0, 6)
          .map(
            (event) =>
              `  ${String(field(event, "commence_time"))} ${String(field(event, "home_team"))} vs ${String(field(event, "away_team"))} (${asArray(field(event, "bookmakers")).length} books)`,
          ),
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// Sherdog (HTML) and Gemini (paid).
// ---------------------------------------------------------------------------

const sherdogPage: ProbeDefinition = {
  descriptor: {
    id: "sherdog.page",
    group: "sherdog",
    label: "Live blog page",
    description:
      "Fetches the card's play-by-play page and runs the real parser over it. One page carries every bout, so the fighter names are what scope it.",
    cost: "free",
    requires: ["SHERDOG_PERMISSION_SCOPE"],
    params: [
      {
        name: "url",
        label: "Live blog URL",
        placeholder:
          "https://www.sherdog.com/news/news/<slug>-playbyplay-results-round-scoring-<id>",
      },
      { name: "red", label: "Red fighter", placeholder: "Bojan Medić" },
      { name: "blue", label: "Blue fighter", placeholder: "Daniel Rodriguez" },
      { name: "round", label: "Round", defaultValue: "1" },
    ],
  },
  async run(params, context) {
    if ((context.env.SHERDOG_PERMISSION_SCOPE?.trim() ?? "").length === 0) {
      throw new Error(
        "SHERDOG_PERMISSION_SCOPE is not set — the live transport is permission-gated by design",
      );
    }
    const url =
      param(params, "url") ||
      context.env.SHERDOG_LIVE_BLOG_URL?.trim() ||
      "";
    if (url.length === 0) {
      throw new Error("no live blog URL: pass one, or set SHERDOG_LIVE_BLOG_URL");
    }

    const started = context.now();
    const response = await context.fetchImpl(url, {
      headers: { "user-agent": "ufc-live-dashboard/0.1 (personal use)" },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    const html = await response.text();
    const bytes = new TextEncoder().encode(html).byteLength;
    if (!response.ok) {
      return {
        ok: false,
        httpStatus: response.status,
        bytes,
        url,
        summary: [
          `HTTP ${response.status} — on 403 the collector stops by design; do not work around it`,
        ],
      };
    }

    const red = param(params, "red");
    const blue = param(params, "blue");
    const round = positiveInt(param(params, "round", "1"), 1);
    const observations = await parseSherdogRoundObservations({
      boutId: "lab-probe",
      html,
      sourceUrl: url,
      fetchedAt: new Date(started).toISOString(),
      ...(red.length > 0 && blue.length > 0
        ? { fighterNames: { red, blue } }
        : {}),
    });
    const forRound = observations.filter(
      (observation) => observation.round === round,
    );

    return {
      ok: true,
      httpStatus: response.status,
      bytes,
      url,
      summary: [
        `${bytes} bytes of HTML`,
        `${observations.length} observations parsed, ${forRound.length} for round ${round}`,
        ...forRound
          .slice(0, 3)
          .map(
            (observation) =>
              `  r${observation.round}: ${observation.scorerCards.length} scorer cards, ${observation.commentary.length} chars of prose`,
          ),
        forRound.length === 0
          ? `round ${round} is not on the page yet`
          : `round ${round} is published`,
      ],
      parsed: forRound,
    };
  },
};

const geminiSummary: ProbeDefinition = {
  descriptor: {
    id: "gemini.summary",
    group: "gemini",
    label: "Round summary (COSTS MONEY)",
    description:
      "Sends commentary to Gemini and returns the enforced summary. One paid call per press.",
    cost: "paid",
    requires: ["GEMINI_API_KEY"],
    params: [
      {
        name: "commentary",
        label: "Commentary to summarize",
        placeholder: "Paste round commentary here",
      },
      { name: "model", label: "Model", defaultValue: "gemini-3.5-flash-lite" },
    ],
  },
  async run(params, context) {
    const apiKey = context.env.GEMINI_API_KEY?.trim() ?? "";
    if (apiKey.length === 0) throw new Error("GEMINI_API_KEY is not set");
    const commentary = param(params, "commentary");
    if (commentary.length === 0) {
      throw new Error("nothing to summarize: paste some commentary first");
    }
    const model = param(params, "model", "gemini-3.5-flash-lite");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const { response, text, json, bytes } = await request(
      context,
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: commentary }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 512 },
        }),
      },
      20_000,
    );

    const candidate = (json as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    })?.candidates?.[0];
    const output = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("");

    return {
      ok: response.ok && output.length > 0,
      httpStatus: response.status,
      bytes,
      url,
      summary: response.ok
        ? [`model ${model}`, `${output.length} chars returned`, output.slice(0, 400)]
        : [`HTTP ${response.status}`, redactSecrets(text.slice(0, 300))],
      ...boundRaw(json, text, bytes),
    };
  },
};

// ---------------------------------------------------------------------------
// The collector itself — is the app's own backend up, and what does it think?
// ---------------------------------------------------------------------------

function collectorProbe(
  id: string,
  label: string,
  description: string,
  path: string,
  summarize: (json: unknown) => string[],
): ProbeDefinition {
  const probe = jsonProbe({
    descriptor: { id, group: "collector", label, description, cost: "free" },
    url: (_params, context) => `${collectorOrigin(context)}${path}`,
    summarize: ({ json }) => ({ summary: summarize(json), parsed: json }),
  });

  return {
    descriptor: probe.descriptor,
    async run(params, context) {
      try {
        return await probe.run(params, context);
      } catch (error) {
        // A refused connection means the collector is not running, which is a
        // different fact from a collector that answers badly — and it is the
        // first thing to establish when the dashboard is blank.
        const message = error instanceof Error ? error.message : String(error);
        if (/fetch failed|ECONNREFUSED/iu.test(message)) {
          return {
            ok: false,
            url: `${collectorOrigin(context)}${path}`,
            summary: [
              `no collector answering on ${collectorOrigin(context)} — start it with \`npm run collector:live\``,
            ],
            error: message,
          };
        }
        throw error;
      }
    },
  };
}

const collectorHealth = collectorProbe(
  "collector.health",
  "Health",
  "Per-source freshness as the collector sees it. If this 500s or refuses the connection, the collector is your problem, not a vendor.",
  "/api/health",
  (json) => {
    const health = field(json, "health");
    const rows =
      typeof health === "object" && health !== null
        ? Object.entries(health as Record<string, unknown>)
        : [];
    const alerts = asArray(field(json, "alerts"));
    return [
      `${rows.length} sources, ${rows.filter(([, value]) => field(value, "fresh") !== true).length} not fresh`,
      ...rows.map(
        ([name, value]) =>
          `  ${name}: ${String(field(value, "status"))}${field(value, "fresh") === true ? "" : " STALE"} — updated ${String(field(value, "sourceUpdatedAt") ?? "never")}`,
      ),
      `${alerts.length} alerts`,
      ...alerts
        .slice(0, 4)
        .map((alert) => `  ${String(field(alert, "message") ?? JSON.stringify(alert))}`),
    ];
  },
);

const collectorMetrics = collectorProbe(
  "collector.metrics",
  "Metrics",
  "Request counts, quota spend, and error tallies for the whole run.",
  "/api/metrics",
  (json) => {
    const sources = field(json, "sources");
    const rows =
      typeof sources === "object" && sources !== null
        ? Object.entries(sources as Record<string, unknown>)
        : [];
    return [
      `generated ${String(field(json, "generatedAt") ?? "?")}`,
      ...rows.map(([name, value]) => {
        // Each source reports a free-form `values` bag — payload age, mapping
        // confidence, request and error counters — so print whatever is there
        // rather than guessing at names that change per source.
        const values = field(value, "values");
        const pairs =
          typeof values === "object" && values !== null
            ? Object.entries(values as Record<string, unknown>)
                .map(([metric, reading]) => `${metric}=${String(reading)}`)
                .join(" ")
            : "no values";
        return `  ${name}: ${pairs} (local ${String(field(value, "localTimestamp") ?? "?")})`;
      }),
    ];
  },
);

const collectorBootstrap = collectorProbe(
  "collector.bootstrap",
  "Bootstrap state",
  "The exact dashboard state the SPA would render. Compare it against the probes above to see whether the data or the UI is at fault.",
  "/api/bootstrap",
  (json) => {
    const state = field(json, "state");
    // `boutViews` is a Record keyed by bout id, not an array.
    const boutViewsRaw = field(state, "boutViews");
    const boutViews =
      typeof boutViewsRaw === "object" && boutViewsRaw !== null
        ? Object.values(boutViewsRaw as Record<string, unknown>)
        : [];
    const event = field(state, "event");
    const mappings = asArray(field(json, "boutMappings"));
    // Which vendors each bout can actually be looked up by. A bout with only
    // an `espn` ref cannot have its Cito round stats fetched at all, which is
    // invisible everywhere else — it looks exactly like Cito being slow.
    const refCounts = new Map<string, number>();
    for (const mapping of mappings) {
      for (const ref of asArray(field(mapping, "externalRefs"))) {
        const source = String(field(ref, "source"));
        refCounts.set(source, (refCounts.get(source) ?? 0) + 1);
      }
    }
    return [
      `event: ${String(field(event, "name") ?? "none")}`,
      `${boutViews.length} bout views, ${asArray(field(json, "unifiedRounds")).length} unified rounds`,
      `${mappings.length} bout mappings; refs per source: ${[...refCounts]
        .map(([source, count]) => `${source}=${count}`)
        .join(", ")}`,
      refCounts.get("cito") === undefined
        ? "no bout carries a cito ref — round stats cannot be fetched"
        : `cito refs on ${refCounts.get("cito")}/${mappings.length} bouts`,
      ...boutViews.slice(0, 14).map((view) => {
        const bout = field(view, "bout");
        const roundsBySource = field(view, "rounds");
        const sources =
          typeof roundsBySource === "object" && roundsBySource !== null
            ? Object.keys(roundsBySource as object)
            : [];
        const markets =
          typeof field(view, "latestOdds") === "object" &&
          field(view, "latestOdds") !== null
            ? Object.keys(field(view, "latestOdds") as object)
            : [];
        return `  ${String(field(bout, "id"))} ${String(field(bout, "status") ?? "?")}: rounds from [${sources.join(",") || "none"}], odds from [${markets.join(",") || "none"}]`;
      }),
    ];
  },
);

const collectorUpcomingOdds = collectorProbe(
  "collector.upcomingOdds",
  "Upcoming odds document",
  "What the twice-daily sync last persisted.",
  "/api/upcoming-odds",
  (json) => {
    const document = field(json, "document") ?? json;
    const events = asArray(field(document, "events"));
    return [
      `generated ${String(field(document, "generatedAt") ?? "?")}`,
      `${events.length} events`,
      ...events
        .slice(0, 6)
        .map(
          (event) =>
            `  ${String(field(event, "name") ?? field(event, "eventId"))}: ${asArray(field(event, "bouts")).length} bouts`,
        ),
    ];
  },
);

export const PROBES: readonly ProbeDefinition[] = [
  espnScoreboard,
  espnSchedule,
  espnFightcenter,
  espnAthlete,
  citoLiveHealth,
  citoLive,
  citoLiveEvent,
  citoLiveBoutState,
  citoEventBouts,
  citoBout,
  citoRoundStats,
  citoRoundRows,
  citoEventStats,
  citoEventOdds,
  kalshiEvents,
  kalshiSigned,
  polymarketEvents,
  oddsApiIoEvents,
  oddsApiIoOdds,
  theOddsApiH2h,
  sherdogPage,
  geminiSummary,
  collectorHealth,
  collectorMetrics,
  collectorBootstrap,
  collectorUpcomingOdds,
];

export function findProbe(id: string): ProbeDefinition | undefined {
  return PROBES.find((probe) => probe.descriptor.id === id);
}

/** Every env var any probe declares, so the page can grey out what cannot run. */
export function requiredEnvNames(): string[] {
  return [
    ...new Set(PROBES.flatMap((probe) => probe.descriptor.requires ?? [])),
  ].sort();
}

/**
 * Runs one probe. Never throws: a probe that blows up is a red row with a
 * message, because a lab that crashes when a source misbehaves is useless
 * exactly when you need it.
 */
export async function runProbe(
  definition: ProbeDefinition,
  params: Record<string, string>,
  context: ProbeContext,
): Promise<ProbeResult> {
  const startedAtMs = context.now();
  const startedAt = new Date(startedAtMs).toISOString();
  try {
    const outcome = await definition.run(params, context);
    return {
      id: definition.descriptor.id,
      startedAt,
      ms: context.now() - startedAtMs,
      ...outcome,
      summary: outcome.summary.length === 0 ? ["(no summary)"] : outcome.summary,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    return {
      id: definition.descriptor.id,
      ok: false,
      startedAt,
      ms: context.now() - startedAtMs,
      summary: [`threw: ${redactSecrets(message)}`],
      error: redactSecrets(message),
    };
  }
}
