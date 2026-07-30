/**
 * The Lab — shared types.
 *
 * The lab exists for one reason: on fight night, when the dashboard shows
 * nothing, you need to know *which* source is silent and *how late* it is.
 * So the lab deliberately shares almost nothing with the app:
 *
 *   - it does not import the collector, the event bus, the lifecycle machine,
 *     the storage layer, or any React,
 *   - it imports only pure URL builders and parsers from `src/sources/*`,
 *   - every probe is one HTTP request, wrapped so a failure is a red row
 *     rather than a dead page.
 *
 * If `npm run dev` is broken, `npm run lab` still answers "is ESPN live yet?".
 *
 * This file is the frozen interface between the lab server and the lab page.
 * Both sides are written against it; neither imports the other.
 */

/** Every probe belongs to exactly one source, so a red group is a dead source. */
export type ProbeGroup =
  | "espn"
  | "cito"
  | "cito-live"
  | "kalshi"
  | "polymarket"
  | "oddsapiio"
  | "theoddsapi"
  | "sherdog"
  | "gemini"
  | "collector";

/**
 * What one probe costs. Rendered as a badge so a quota-limited endpoint is
 * never clicked absentmindedly during a card.
 *   free  — no metered quota (ESPN, Polymarket, Sherdog)
 *   quota — counts against a rate limit or request allowance
 *   paid  — costs real money per call (Gemini)
 */
export type ProbeCost = "free" | "quota" | "paid";

export interface ProbeParam {
  name: string;
  label: string;
  /** Prefilled with the weekend card's real identifiers where known. */
  defaultValue?: string;
  placeholder?: string;
}

export interface ProbeDescriptor {
  id: string;
  group: ProbeGroup;
  label: string;
  /** One line: what this call answers. Shown under the button. */
  description: string;
  cost: ProbeCost;
  params?: ProbeParam[];
  /** Env vars this probe needs; the page greys the button when any is missing. */
  requires?: string[];
}

export interface ProbeResult {
  id: string;
  ok: boolean;
  /** ISO timestamp the request was issued — the anchor for every delta. */
  startedAt: string;
  ms: number;
  httpStatus?: number;
  bytes?: number;
  /** Redacted: api keys are replaced before this ever leaves the server. */
  url?: string;
  /**
   * Human-readable findings, most important first — "14 bouts",
   * "round 1 roundStats: 2 rows", "live worker: DEAD (lag 32h)". This is what
   * you read at 11pm; `raw` is for when the summary surprises you.
   */
  summary: string[];
  /** What the shipped parser made of the payload, when a parser applies. */
  parsed?: unknown;
  /** The untouched response, truncated if enormous. */
  raw?: unknown;
  rawTruncated?: boolean;
  error?: string;
  /** Quota headers the vendor returned, verbatim. */
  quota?: Record<string, string>;
}

/**
 * `marker`      — you pressed a button ("round ended on the broadcast"). The
 *                 only ground truth in the whole system, because it is the
 *                 only observation not mediated by a vendor.
 * `observation` — the watcher noticed a source change state on its own.
 * `probe`       — a manual probe ran.
 * `note`        — lab lifecycle (watcher started/stopped, an error).
 */
export type TimelineKind = "marker" | "observation" | "probe" | "note";

export interface TimelineEntry {
  /** Monotonic, per-process. The page polls with `?since=<seq>`. */
  seq: number;
  at: string;
  kind: TimelineKind;
  /** "user" for markers, otherwise the source id. */
  source: string;
  label: string;
  boutId?: string;
  round?: number;
  /**
   * Milliseconds since the most recent `marker` for the same bout+round.
   * This is the number the whole lab exists to produce: "Cito published
   * round 2 stats 47s after the round ended on my screen."
   */
  deltaMs?: number;
  /** What the marker was measured against, e.g. "round 2 ended (broadcast)". */
  deltaFrom?: string;
  detail?: Record<string, unknown>;
}

export interface WatchTarget {
  /** Stable lab id used to join every vendor observation to the horn marker. */
  boutId?: string;
  round?: number;
  espnEventId?: string;
  espnBoutId?: string;
  citoEventSlug?: string;
  /** Cito bout ids to chase round stats for; empty means "the whole card". */
  citoBoutIds?: string[];
  redFighter?: string;
  blueFighter?: string;
  sherdogUrl?: string;
  espnIntervalMs?: number;
  citoIntervalMs?: number;
  kalshiIntervalMs?: number;
  sherdogIntervalMs?: number;
}

export interface WatchStatus {
  running: boolean;
  startedAt?: string;
  target?: WatchTarget;
  /** Per-poller: how many polls, how many failed, when it last completed. */
  pollers: Array<{
    name: string;
    polls: number;
    failures: number;
    lastAt?: string;
    lastMs?: number;
    lastError?: string;
    nextInMs?: number;
  }>;
}

export interface LabFight {
  id: string;
  espnBoutId?: string;
  cardSection: string;
  cardPosition: string;
  weightClass: string;
  red: {
    name: string;
    slug?: string;
  };
  blue: {
    name: string;
    slug?: string;
  };
}

export interface LabCard {
  eventName: string;
  eventDate: string;
  eventSlug: string;
  pollIntervalMs: number;
  fights: LabFight[];
}

export interface TimelineResponse {
  entries: TimelineEntry[];
  latestSeq: number;
  watch: WatchStatus;
  serverTime: string;
}

/** Formats a delta the way it reads best on the page: "+47.2s", "-1.8s". */
export function formatDelta(deltaMs: number): string {
  const sign = deltaMs < 0 ? "-" : "+";
  const abs = Math.abs(deltaMs);
  if (abs < 1000) return `${sign}${abs}ms`;
  if (abs < 60_000) return `${sign}${(abs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(abs / 60_000);
  const seconds = Math.round((abs % 60_000) / 1000);
  return `${sign}${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** Replaces api keys in a URL or message before it leaves the server. */
export function redactSecrets(text: string): string {
  return text
    .replace(/([?&](?:apiKey|api_key|apikey|key|token)=)[^&\s]+/giu, "$1<redacted>")
    .replace(/(x-api-key["':\s]+)[^\s"',}]+/giu, "$1<redacted>");
}
