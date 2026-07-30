import { createHash } from "node:crypto";

const REQUEST_TIMEOUT_MS = 12_000;

export interface EspnCoreStat {
  name: string;
  displayName: string;
  abbreviation?: string;
  value: number;
  displayValue: string;
}

export interface EspnCoreStatsResponseMeta {
  url: string;
  startedAt: string;
  receivedAt: string;
  durationMs: number;
  status: number;
  bytes: number;
  sha256: string;
  cacheControl?: string;
  age?: string;
  date?: string;
  etag?: string;
  expires?: string;
}

export interface EspnCoreStatsSample {
  athleteId: string;
  split: {
    id?: string;
    name?: string;
    type?: string;
    categories: string[];
  };
  stats: EspnCoreStat[];
  response: EspnCoreStatsResponseMeta;
  /** Untouched ESPN payload so the lab's raw JSON view really is raw. */
  raw: unknown;
}

export interface EspnCoreStatChange {
  name: string;
  displayName: string;
  previous: number;
  current: number;
  delta: number;
  previousDisplayValue: string;
  displayValue: string;
}

interface FetchEspnCoreStatsOptions {
  eventId: string;
  competitionId: string;
  athleteId: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function recordField(
  source: unknown,
  name: string,
): Record<string, unknown> | undefined {
  const value = (source as Record<string, unknown> | null)?.[name];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayField(source: unknown, name: string): unknown[] {
  const value = (source as Record<string, unknown> | null)?.[name];
  return Array.isArray(value) ? value : [];
}

function stringField(source: unknown, name: string): string | undefined {
  const value = (source as Record<string, unknown> | null)?.[name];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberField(source: unknown, name: string): number | undefined {
  const value = (source as Record<string, unknown> | null)?.[name];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function header(
  headers: Headers,
  name: string,
): string | undefined {
  const value = headers.get(name)?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function requiredId(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new TypeError(`${name} is required`);
  return trimmed;
}

export function buildEspnCoreStatsUrl(
  eventId: string,
  competitionId: string,
  athleteId: string,
): string {
  const event = encodeURIComponent(requiredId(eventId, "eventId"));
  const competition = encodeURIComponent(
    requiredId(competitionId, "competitionId"),
  );
  const athlete = encodeURIComponent(requiredId(athleteId, "athleteId"));
  return `https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/${event}/competitions/${competition}/competitors/${athlete}/statistics`;
}

export function parseEspnCoreStats(
  payload: unknown,
  athleteId: string,
  response: EspnCoreStatsResponseMeta,
): EspnCoreStatsSample {
  const splits = recordField(payload, "splits");
  const categories = arrayField(splits, "categories");
  const statsByName = new Map<string, EspnCoreStat>();

  for (const category of categories) {
    for (const rawStat of arrayField(category, "stats")) {
      const name = stringField(rawStat, "name");
      if (name === undefined) continue;
      const value = numberField(rawStat, "value") ?? 0;
      statsByName.set(name, {
        name,
        displayName:
          stringField(rawStat, "displayName") ??
          stringField(rawStat, "shortDisplayName") ??
          name,
        ...(stringField(rawStat, "abbreviation") === undefined
          ? {}
          : { abbreviation: stringField(rawStat, "abbreviation") as string }),
        value,
        displayValue: stringField(rawStat, "displayValue") ?? String(value),
      });
    }
  }

  return {
    athleteId: requiredId(athleteId, "athleteId"),
    split: {
      ...(stringField(splits, "id") === undefined
        ? {}
        : { id: stringField(splits, "id") as string }),
      ...(stringField(splits, "name") === undefined
        ? {}
        : { name: stringField(splits, "name") as string }),
      ...(stringField(splits, "type") === undefined
        ? {}
        : { type: stringField(splits, "type") as string }),
      categories: categories.flatMap((category) => {
        const name = stringField(category, "name");
        return name === undefined ? [] : [name];
      }),
    },
    stats: [...statsByName.values()],
    response,
    raw: payload,
  };
}

export async function fetchEspnCoreStats(
  options: FetchEspnCoreStatsOptions,
): Promise<EspnCoreStatsSample> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const url = buildEspnCoreStatsUrl(
    options.eventId,
    options.competitionId,
    options.athleteId,
  );
  const startedAtMs = now();
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  const receivedAtMs = now();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${text.slice(0, 160)}`);
  }

  const responseMeta: EspnCoreStatsResponseMeta = {
    url,
    startedAt: new Date(startedAtMs).toISOString(),
    receivedAt: new Date(receivedAtMs).toISOString(),
    durationMs: Math.max(0, receivedAtMs - startedAtMs),
    status: response.status,
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
    ...(header(response.headers, "cache-control") === undefined
      ? {}
      : { cacheControl: header(response.headers, "cache-control") as string }),
    ...(header(response.headers, "age") === undefined
      ? {}
      : { age: header(response.headers, "age") as string }),
    ...(header(response.headers, "date") === undefined
      ? {}
      : { date: header(response.headers, "date") as string }),
    ...(header(response.headers, "etag") === undefined
      ? {}
      : { etag: header(response.headers, "etag") as string }),
    ...(header(response.headers, "expires") === undefined
      ? {}
      : { expires: header(response.headers, "expires") as string }),
  };

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("ESPN core statistics response was not valid JSON");
  }
  return parseEspnCoreStats(payload, options.athleteId, responseMeta);
}

export function diffEspnCoreStats(
  previous: EspnCoreStatsSample | undefined,
  current: EspnCoreStatsSample,
): EspnCoreStatChange[] {
  if (previous === undefined) return [];
  const previousByName = new Map(
    previous.stats.map((stat) => [stat.name, stat] as const),
  );
  return current.stats.flatMap((stat) => {
    const prior = previousByName.get(stat.name);
    if (
      prior === undefined ||
      (prior.value === stat.value &&
        prior.displayValue === stat.displayValue)
    ) {
      return [];
    }
    return [
      {
        name: stat.name,
        displayName: stat.displayName,
        previous: prior.value,
        current: stat.value,
        delta: stat.value - prior.value,
        previousDisplayValue: prior.displayValue,
        displayValue: stat.displayValue,
      },
    ];
  });
}

export function hasNonzeroEspnCoreStats(
  sample: EspnCoreStatsSample,
): boolean {
  return sample.stats.some((stat) => stat.value !== 0);
}
