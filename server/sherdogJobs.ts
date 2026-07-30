import sherdogFixtureJson from "../src/fixtures/sherdog.json" with { type: "json" };
import type {
  Bout,
  SherdogRoundObservation,
} from "../src/schema.ts";
import {
  parseSherdogRoundObservations,
  SHERDOG_MAX_PAYLOAD_BYTES,
} from "../src/sources/sherdog.ts";
import type {
  CollectorEvent,
  CollectorEventBus,
} from "./eventBus.ts";
import { computeExpertConsensus } from "./expertConsensus.ts";
import {
  createDisabledSummarizer,
  type RoundSummarizer,
} from "./geminiSummarizer.ts";
import { RequestIntervalGuard } from "./quota.ts";
import type { RoundStatsPipeline } from "./roundStats.ts";
import {
  RoundJobScheduler,
  TerminalRoundJobError,
  type RoundJob,
  type RoundJobClock,
} from "./roundJobs.ts";
import type { Storage } from "./storage.ts";
import { NOOP_METRICS, type Metrics } from "./health.ts";
import type { ParserErrorSink } from "./review.ts";

export const SHERDOG_FINAL_JOB_TYPE = "sherdog_final";
export const SHERDOG_OBSERVATIONS_STORAGE_STREAM =
  "sherdog-observations";
export const SHERDOG_ROUND_ATTEMPT_DELAYS_MS = [
  15_000,
  30_000,
  60_000,
] as const;

export function sherdogRoundJobType(attempt: 1 | 2 | 3): string {
  return `sherdog_round_${attempt}`;
}

export interface SherdogFetchResponse {
  status: number;
  html: string;
  sourceUrl: string;
  publishedAt?: string;
}

export interface SherdogFetcher {
  fetchBout(
    boutId: string,
    purpose: "round" | "final",
  ): Promise<SherdogFetchResponse>;
}

export interface LiveSherdogFetcherOptions {
  permissionScope: string;
  resolveBoutUrl: (boutId: string) => string | undefined;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
}

export interface SherdogObservationRevision {
  observation: SherdogRoundObservation;
  revision: number;
  firstObservedAt: string;
  lastObservedAt: string;
}

export interface SherdogRunHealth {
  stopped: boolean;
  checkedAt?: string;
  message?: string;
}

export interface SherdogRoundJobsOptions {
  eventBus: CollectorEventBus;
  scheduler: RoundJobScheduler;
  storage: Storage;
  roundStats: Pick<
    RoundStatsPipeline,
    "getUnifiedRound" | "setSherdogObservation"
  >;
  fetcher: SherdogFetcher;
  getBout(boutId: string): Bout | undefined;
  dataMode: "fixture" | "live";
  permissionScope: string;
  requestIntervalMs: number;
  summarizer?: RoundSummarizer;
  clock?: RoundJobClock;
  requestTimeoutMs?: number;
  quota?: RequestIntervalGuard;
  publishHealth?: (health: {
    source: "sherdog";
    status: "healthy" | "degraded" | "unavailable";
    fresh: boolean;
    checkedAt: string;
    sourceUpdatedAt?: string;
    message?: string;
  }) => Promise<unknown>;
  metrics?: Metrics;
  review?: ParserErrorSink;
}

interface PersistedSherdogObservation {
  version: 1;
  value: SherdogObservationRevision;
}

interface FixturePayload {
  boutEntries: Record<string, { html: string }>;
  sourceUrl: string;
  publishedAt?: string;
}

const fixture = sherdogFixtureJson as FixturePayload;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isObservation(value: unknown): value is SherdogRoundObservation {
  return (
    isRecord(value) &&
    typeof value.boutId === "string" &&
    Number.isSafeInteger(value.round) &&
    typeof value.commentary === "string" &&
    Array.isArray(value.scorerCards) &&
    typeof value.sourceUrl === "string" &&
    typeof value.fetchedAt === "string" &&
    typeof value.parserVersion === "string" &&
    typeof value.payloadHash === "string"
  );
}

function isPersisted(
  value: unknown,
): value is PersistedSherdogObservation {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isRecord(value.value) &&
    isObservation(value.value.observation) &&
    Number.isSafeInteger(value.value.revision) &&
    (value.value.revision as number) >= 1 &&
    typeof value.value.firstObservedAt === "string" &&
    typeof value.value.lastObservedAt === "string"
  );
}

function copyObservation(
  observation: SherdogRoundObservation,
): SherdogRoundObservation {
  return {
    ...observation,
    scorerCards: observation.scorerCards.map((card) => ({ ...card })),
  };
}

function copyRevision(
  value: SherdogObservationRevision,
): SherdogObservationRevision {
  return {
    ...value,
    observation: copyObservation(value.observation),
  };
}

function permissionAllowsLiveRead(scope: string): boolean {
  const permissions = new Set(
    scope
      .toLocaleLowerCase("en")
      .split(/[\s,]+/)
      .filter(Boolean),
  );
  return (
    permissions.has("live-blog-read") ||
    permissions.has("sherdog-read") ||
    permissions.has("all")
  );
}

async function readWithByteLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("Sherdog response exceeded the maximum response size");
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;

    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Sherdog response exceeded the maximum response size");
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function resolveSherdogRequestUrl(
  baseUrl: string,
  boutUrl: string,
): string {
  const parsed = new URL(boutUrl, baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("Sherdog bout URL must use HTTP or HTTPS");
  }
  return parsed.toString();
}

export function createLiveSherdogFetcher(
  options: LiveSherdogFetcherOptions,
): SherdogFetcher {
  if (!permissionAllowsLiveRead(options.permissionScope)) {
    throw new TerminalRoundJobError(
      "Sherdog permission scope does not allow live-blog reads",
    );
  }

  const baseUrl = options.baseUrl ?? "https://www.sherdog.com";
  const parsedBaseUrl = new URL(baseUrl);
  if (
    parsedBaseUrl.protocol !== "http:" &&
    parsedBaseUrl.protocol !== "https:"
  ) {
    throw new TypeError("Sherdog base URL must use HTTP or HTTPS");
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Sherdog request timeout must be positive");
  }
  const maxBytes = options.maxBytes ?? SHERDOG_MAX_PAYLOAD_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new TypeError("Sherdog maximum response size must be positive");
  }
  const userAgent =
    options.userAgent ??
    "UFC Live Dashboard/1.0 (personal non-commercial dashboard)";
  if (userAgent.trim().length === 0) {
    throw new TypeError("Sherdog User-Agent must not be empty");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    async fetchBout(boutId) {
      const boutUrl = options.resolveBoutUrl(boutId)?.trim();
      if (boutUrl === undefined || boutUrl.length === 0) {
        throw new TerminalRoundJobError(
          `Sherdog bout ${boutId} has no mapped live-blog URL`,
        );
      }
      const requestedUrl = resolveSherdogRequestUrl(baseUrl, boutUrl);
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const request = (async (): Promise<SherdogFetchResponse> => {
        const response = await fetchImpl(requestedUrl, {
          signal: controller.signal,
          headers: { "User-Agent": userAgent },
        });
        const html = await readWithByteLimit(response, maxBytes);
        return {
          status: response.status,
          html,
          sourceUrl: requestedUrl,
        };
      })();

      try {
        return await Promise.race([
          request,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new Error("Sherdog request timed out"));
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createFixtureSherdogFetcher(): SherdogFetcher {
  return {
    async fetchBout(boutId) {
      const entry = fixture.boutEntries[boutId];
      return entry === undefined
        ? {
            status: 404,
            html: "",
            sourceUrl: fixture.sourceUrl,
          }
        : {
            status: 200,
            html: entry.html,
            sourceUrl: fixture.sourceUrl,
            ...(fixture.publishedAt === undefined
              ? {}
              : { publishedAt: fixture.publishedAt }),
          };
    },
  };
}

export class SherdogRoundJobs {
  readonly quota: RequestIntervalGuard;

  private readonly eventBus: CollectorEventBus;

  private readonly scheduler: RoundJobScheduler;

  private readonly storage: Storage;

  private readonly roundStats: SherdogRoundJobsOptions["roundStats"];

  private readonly fetcher: SherdogFetcher;

  private readonly getBout: SherdogRoundJobsOptions["getBout"];

  private readonly dataMode: SherdogRoundJobsOptions["dataMode"];

  private readonly permissionScope: string;

  private readonly summarizer: RoundSummarizer;

  private readonly clock: RoundJobClock;

  private readonly requestTimeoutMs: number;

  private readonly publishHealth: SherdogRoundJobsOptions["publishHealth"];

  private readonly metrics: Metrics;

  private readonly review: ParserErrorSink | undefined;

  private readonly current = new Map<string, SherdogObservationRevision>();

  private readonly histories = new Map<
    string,
    SherdogObservationRevision[]
  >();

  private readonly unsubscribers: Array<() => void> = [];

  private eventQueue: Promise<void> = Promise.resolve();

  private restorePromise: Promise<void> | undefined;

  private stopped = false;

  private stoppedAt: string | undefined;

  private stoppedMessage: string | undefined;

  constructor(options: SherdogRoundJobsOptions) {
    if (
      !Number.isFinite(options.requestIntervalMs) ||
      options.requestIntervalMs < 0
    ) {
      throw new TypeError("Sherdog request interval must be non-negative");
    }
    this.eventBus = options.eventBus;
    this.scheduler = options.scheduler;
    this.storage = options.storage;
    this.roundStats = options.roundStats;
    this.fetcher = options.fetcher;
    this.getBout = options.getBout;
    this.dataMode = options.dataMode;
    this.permissionScope = options.permissionScope;
    this.summarizer = options.summarizer ?? createDisabledSummarizer();
    this.clock = options.clock ?? { now: () => Date.now() };
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.publishHealth = options.publishHealth;
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.review = options.review;
    this.quota =
      options.quota ??
      new RequestIntervalGuard({
        storage: options.storage,
        intervalsMs: { sherdog: options.requestIntervalMs },
        clock: this.clock,
        metrics: this.metrics,
      });

    for (const attempt of [1, 2, 3] as const) {
      this.scheduler.registerHandler(
        sherdogRoundJobType(attempt),
        (job) => this.runRound(job),
      );
    }
    this.scheduler.registerHandler(
      SHERDOG_FINAL_JOB_TYPE,
      (job) => this.runFinal(job),
    );
    this.unsubscribers.push(
      this.eventBus.subscribe("PROVISIONAL_ROUND_ENDED", (event) => {
        this.enqueueEvent(() => this.scheduleRound(event));
      }),
      this.eventBus.subscribe("ROUND_ENDED", (event) => {
        this.enqueueEvent(() => this.scheduleRound(event));
      }),
      this.eventBus.subscribe("FIGHT_ENDED", (event) => {
        this.enqueueEvent(() => this.scheduleFinal(event));
      }),
    );
  }

  static async create(
    options: SherdogRoundJobsOptions,
  ): Promise<SherdogRoundJobs> {
    const jobs = new SherdogRoundJobs(options);
    await jobs.restore();
    return jobs;
  }

  async restore(): Promise<void> {
    this.restorePromise ??= this.restoreFromStorage();
    await this.restorePromise;
  }

  getObservation(
    boutId: string,
    round: number,
  ): SherdogObservationRevision | undefined {
    const value = this.current.get(`${boutId}:${round}`);
    return value === undefined ? undefined : copyRevision(value);
  }

  getRevisionHistory(
    boutId: string,
    round: number,
  ): readonly SherdogObservationRevision[] {
    return (this.histories.get(`${boutId}:${round}`) ?? []).map(
      copyRevision,
    );
  }

  getHealth(): SherdogRunHealth {
    return {
      stopped: this.stopped,
      ...(this.stoppedAt === undefined
        ? {}
        : { checkedAt: this.stoppedAt }),
      ...(this.stoppedMessage === undefined
        ? {}
        : { message: this.stoppedMessage }),
    };
  }

  async idle(): Promise<void> {
    await this.eventQueue;
    await this.scheduler.idle();
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    await this.eventQueue;
  }

  private enqueueEvent(operation: () => Promise<void>): void {
    this.eventQueue = this.eventQueue
      .then(operation)
      .catch(() => undefined);
  }

  private async restoreFromStorage(): Promise<void> {
    const records = await this.storage.read<unknown>(
      SHERDOG_OBSERVATIONS_STORAGE_STREAM,
    );
    this.current.clear();
    this.histories.clear();
    for (const record of records) {
      if (!isPersisted(record)) continue;
      const value = copyRevision(record.value);
      const key = `${value.observation.boutId}:${value.observation.round}`;
      this.current.set(key, value);
      const history = this.histories.get(key) ?? [];
      if (
        !history.some(
          (entry) =>
            entry.revision === value.revision &&
            entry.observation.payloadHash ===
              value.observation.payloadHash,
        )
      ) {
        history.push(value);
        history.sort((left, right) => left.revision - right.revision);
        this.histories.set(key, history);
      }
    }
    await this.quota.restore();
  }

  private async scheduleRound(
    event: Extract<
      CollectorEvent,
      { type: "PROVISIONAL_ROUND_ENDED" | "ROUND_ENDED" }
    >,
  ): Promise<void> {
    const now = this.clock.now();
    for (const [index, delayMs] of SHERDOG_ROUND_ATTEMPT_DELAYS_MS.entries()) {
      await this.scheduler.schedule({
        boutId: event.boutId,
        round: event.round,
        jobType: sherdogRoundJobType((index + 1) as 1 | 2 | 3),
        dueAt: now + delayMs,
        retryPolicy: { delayMs: 0, maxAttempts: 1 },
      });
    }
  }

  private async scheduleFinal(
    event: Extract<CollectorEvent, { type: "FIGHT_ENDED" }>,
  ): Promise<void> {
    await this.scheduler.schedule({
      boutId: event.boutId,
      round: event.round,
      jobType: SHERDOG_FINAL_JOB_TYPE,
      dueAt: this.clock.now(),
      retryPolicy: { delayMs: 0, maxAttempts: 1 },
    });
  }

  private async runRound(job: RoundJob): Promise<void> {
    const observations = await this.fetchAndParse(job.boutId, "round");
    if (observations.length === 0) {
      await this.review?.recordParserError({
        source: "sherdog",
        context: `round:${job.boutId}:${job.round}`,
        error: "parser found no round headings",
        localTimestamp: new Date(this.clock.now()).toISOString(),
      });
      throw new TerminalRoundJobError(
        `Sherdog parser found no round headings for ${job.boutId}`,
      );
    }
    const observation = observations.find(
      (candidate) => candidate.round === job.round,
    );
    if (observation === undefined) {
      throw new Error(
        `Sherdog round ${job.round} is absent for ${job.boutId}`,
      );
    }
    await this.observe(observation);
  }

  private async runFinal(job: RoundJob): Promise<void> {
    const observations = await this.fetchAndParse(job.boutId, "final");
    if (observations.length === 0) {
      await this.review?.recordParserError({
        source: "sherdog",
        context: `final:${job.boutId}`,
        error: "final parser found no rounds",
        localTimestamp: new Date(this.clock.now()).toISOString(),
      });
      throw new TerminalRoundJobError(
        `Sherdog final parser found no rounds for ${job.boutId}`,
      );
    }
    for (const observation of observations) {
      if (observation.round <= job.round) {
        await this.observe(observation);
      }
    }
  }

  private async fetchAndParse(
    boutId: string,
    purpose: "round" | "final",
  ): Promise<SherdogRoundObservation[]> {
    await this.restore();
    if (this.stopped) return [];
    if (
      this.dataMode === "live" &&
      !permissionAllowsLiveRead(this.permissionScope)
    ) {
      throw new TerminalRoundJobError(
        "Sherdog permission scope does not allow live-blog reads",
      );
    }
    if (!(await this.quota.tryAcquire("sherdog"))) {
      throw new TerminalRoundJobError(
        "Sherdog request interval has not elapsed; request was not attempted",
      );
    }

    let response: SherdogFetchResponse;
    try {
      response = await this.withTimeout(
        this.fetcher.fetchBout(boutId, purpose),
      );
    } catch (error) {
      throw new TerminalRoundJobError(
        `Sherdog request failed: ${errorText(error)}`,
      );
    }
    const fetchedAt = new Date(this.clock.now()).toISOString();
    if (response.status === 403) {
      await this.stopForForbidden(fetchedAt);
      throw new TerminalRoundJobError(
        "Sherdog returned HTTP 403; requests stopped for this run",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new TerminalRoundJobError(
        `Sherdog request returned HTTP ${response.status}`,
      );
    }
    if (
      new TextEncoder().encode(response.html).byteLength >
      SHERDOG_MAX_PAYLOAD_BYTES
    ) {
      throw new TerminalRoundJobError(
        "Sherdog response exceeded the maximum response size",
      );
    }

    // A live play-by-play page carries the whole card, so the parser needs the
    // fighters to pick this bout's rounds out of it.
    const bout = this.getBout(boutId);
    try {
      return await parseSherdogRoundObservations({
        boutId,
        html: response.html,
        sourceUrl: response.sourceUrl,
        fetchedAt,
        ...(response.publishedAt === undefined
          ? {}
          : { publishedAt: response.publishedAt }),
        ...(bout === undefined
          ? {}
          : {
              fighterNames: {
                red: bout.fighters.red.name,
                blue: bout.fighters.blue.name,
              },
            }),
      });
    } catch (error) {
      await this.review?.recordParserError({
        source: "sherdog",
        context: `${purpose}:${boutId}`,
        error,
        ...(response.publishedAt === undefined
          ? {}
          : { sourceTimestamp: response.publishedAt }),
        localTimestamp: fetchedAt,
      });
      throw new TerminalRoundJobError(
        `Sherdog parser failed: ${errorText(error)}`,
      );
    }
  }

  /**
   * Adds the model's condensation of the round, reusing the previous one when
   * the payload is unchanged so the three-attempt ladder does not pay for the
   * same page three times. Summaries are decorative: any failure leaves the
   * observation and its raw commentary exactly as parsed.
   */
  private async summarize(
    observation: SherdogRoundObservation,
    previous: SherdogObservationRevision | undefined,
  ): Promise<SherdogRoundObservation> {
    if (
      previous !== undefined &&
      previous.observation.payloadHash === observation.payloadHash
    ) {
      return previous.observation.aiSummary === undefined
        ? observation
        : { ...observation, aiSummary: previous.observation.aiSummary };
    }

    const bout = this.getBout(observation.boutId);
    if (bout === undefined) return observation;

    try {
      const aiSummary = await this.summarizer.summarize({
        round: observation.round,
        redName: bout.fighters.red.name,
        blueName: bout.fighters.blue.name,
        commentary: observation.commentary,
        scorerCards: observation.scorerCards,
      });
      return aiSummary.length === 0
        ? observation
        : { ...observation, aiSummary };
    } catch {
      return observation;
    }
  }

  private async observe(
    rawObservation: SherdogRoundObservation,
  ): Promise<void> {
    const key = `${rawObservation.boutId}:${rawObservation.round}`;
    const previous = this.current.get(key);
    const observation = await this.summarize(rawObservation, previous);
    const next: SherdogObservationRevision = {
      observation: copyObservation(observation),
      revision:
        previous === undefined
          ? 1
          : previous.observation.payloadHash === observation.payloadHash
            ? previous.revision
            : previous.revision + 1,
      firstObservedAt:
        previous?.firstObservedAt ?? observation.fetchedAt,
      lastObservedAt: observation.fetchedAt,
    };
    this.metrics.recordPayload(
      "sherdog",
      observation.publishedAt,
      observation.fetchedAt,
    );
    if (observation.publishedAt !== undefined) {
      this.metrics.set(
        "sherdog_publication_delay_ms",
        "sherdog",
        Math.max(
          0,
          Date.parse(observation.fetchedAt) -
            Date.parse(observation.publishedAt),
        ),
        {
          sourceTimestamp: observation.publishedAt,
          localTimestamp: observation.fetchedAt,
        },
      );
    }
    if (
      previous !== undefined &&
      previous.observation.payloadHash !== observation.payloadHash
    ) {
      this.metrics.increment("revisions_total", "sherdog", 1, {
        ...(observation.publishedAt === undefined
          ? {}
          : { sourceTimestamp: observation.publishedAt }),
        localTimestamp: observation.fetchedAt,
      });
    }
    await this.storage.append(SHERDOG_OBSERVATIONS_STORAGE_STREAM, {
      version: 1,
      value: next,
    } satisfies PersistedSherdogObservation);
    this.current.set(key, next);
    if (
      previous === undefined ||
      previous.observation.payloadHash !== observation.payloadHash
    ) {
      const history = this.histories.get(key) ?? [];
      history.push(next);
      this.histories.set(key, history);
    }

    const bout = this.getBout(observation.boutId);
    if (bout === undefined) return;
    const existing = this.roundStats.getUnifiedRound(
      observation.boutId,
      observation.round,
    );
    await this.roundStats.setSherdogObservation(
      observation,
      computeExpertConsensus(
        bout,
        observation,
        existing?.xScores ?? [],
      ),
    );
    await this.publishHealth?.({
      source: "sherdog",
      status: "healthy",
      fresh: true,
      checkedAt: observation.fetchedAt,
      ...(observation.publishedAt === undefined
        ? {}
        : { sourceUpdatedAt: observation.publishedAt }),
    }).catch(() => undefined);
  }

  private async stopForForbidden(checkedAt: string): Promise<void> {
    this.stopped = true;
    this.stoppedAt = checkedAt;
    this.stoppedMessage =
      "HTTP 403: Sherdog requests stopped for this collector run";
    await this.publishHealth?.({
      source: "sherdog",
      status: "unavailable",
      fresh: false,
      checkedAt,
      message: this.stoppedMessage,
    }).catch(() => undefined);
  }

  private async withTimeout<Result>(
    request: Promise<Result>,
  ): Promise<Result> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        request,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("request timed out")),
            this.requestTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
