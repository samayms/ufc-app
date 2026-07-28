import type { Storage } from "./storage.ts";
import { NOOP_METRICS, type Metrics } from "./health.ts";

export const DEFAULT_ROUND_JOBS_STORAGE_STREAM = "round-jobs";
export const DEFAULT_ROUND_JOB_DEAD_LETTER_STREAM =
  "round-job-dead-letters";

export type RoundJobStatus = "pending" | "completed" | "failed";

export interface RoundJobRetryPolicy {
  delayMs: number;
  maxAttempts: number;
}

export interface RoundJob {
  version: 1;
  key: string;
  boutId: string;
  round: number;
  jobType: string;
  status: RoundJobStatus;
  dueAt: number;
  attemptCount: number;
  retryPolicy: RoundJobRetryPolicy;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  failedAt?: number;
  lastError?: string;
}

export interface RoundJobDeadLetter {
  version: 1;
  job: RoundJob;
  deadLetteredAt: number;
  error: string;
}

export interface RoundJobClock {
  now(): number;
}

export interface RoundJobTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type RoundJobHandler = (job: RoundJob) => Promise<void>;

export interface RoundJobSchedulerOptions {
  storage: Storage;
  clock?: RoundJobClock;
  timer?: RoundJobTimer;
  storageStream?: string;
  deadLetterStream?: string;
  handlers?: Readonly<Record<string, RoundJobHandler>>;
  metrics?: Metrics;
}

export interface ScheduleRoundJob {
  boutId: string;
  round: number;
  jobType: string;
  dueAt: number;
  retryPolicy: RoundJobRetryPolicy;
}

export class TerminalRoundJobError extends Error {
  override readonly name = "TerminalRoundJobError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRetryPolicy(value: unknown): value is RoundJobRetryPolicy {
  return (
    isRecord(value) &&
    typeof value.delayMs === "number" &&
    Number.isFinite(value.delayMs) &&
    value.delayMs >= 0 &&
    typeof value.maxAttempts === "number" &&
    Number.isSafeInteger(value.maxAttempts) &&
    value.maxAttempts >= 1
  );
}

function isRoundJob(value: unknown): value is RoundJob {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.key === "string" &&
    typeof value.boutId === "string" &&
    typeof value.round === "number" &&
    Number.isSafeInteger(value.round) &&
    value.round >= 1 &&
    typeof value.jobType === "string" &&
    (value.status === "pending" ||
      value.status === "completed" ||
      value.status === "failed") &&
    typeof value.dueAt === "number" &&
    Number.isFinite(value.dueAt) &&
    typeof value.attemptCount === "number" &&
    Number.isSafeInteger(value.attemptCount) &&
    value.attemptCount >= 0 &&
    isRetryPolicy(value.retryPolicy) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt) &&
    value.key === `${value.boutId}:${value.round}:${value.jobType}`
  );
}

function copyJob(job: RoundJob): RoundJob {
  return {
    ...job,
    retryPolicy: { ...job.retryPolicy },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateSchedule(job: ScheduleRoundJob): void {
  if (job.boutId.trim().length === 0) {
    throw new TypeError("round job boutId must not be empty");
  }
  if (!Number.isSafeInteger(job.round) || job.round < 1) {
    throw new TypeError("round job round must be a positive integer");
  }
  if (
    job.jobType.trim().length === 0 ||
    job.jobType.includes(":")
  ) {
    throw new TypeError(
      "round job jobType must not be empty or contain a colon",
    );
  }
  if (!Number.isFinite(job.dueAt)) {
    throw new TypeError("round job dueAt must be finite");
  }
  if (!isRetryPolicy(job.retryPolicy)) {
    throw new TypeError(
      "round job retry policy requires a non-negative delay and positive maxAttempts",
    );
  }
}

export function roundJobKey(
  boutId: string,
  round: number,
  jobType: string,
): string {
  return `${boutId}:${round}:${jobType}`;
}

export function roundJobSource(jobType: string): string {
  if (jobType.startsWith("cito_")) return "cito";
  if (jobType.startsWith("sherdog_")) return "sherdog";
  if (jobType.startsWith("x_")) return "x";
  if (jobType.startsWith("the_odds_api_")) return "the-odds-api";
  return jobType;
}

export class RoundJobScheduler {
  private readonly storage: Storage;

  private readonly clock: RoundJobClock;

  private readonly timer: RoundJobTimer;

  private readonly storageStream: string;

  private readonly deadLetterStream: string;

  private readonly metrics: Metrics;

  private readonly handlers = new Map<string, RoundJobHandler>();

  private readonly jobs = new Map<string, RoundJob>();

  private readonly timers = new Map<string, unknown>();

  private readonly active = new Set<Promise<void>>();

  private restorePromise: Promise<void> | undefined;

  private metadataQueue: Promise<void> = Promise.resolve();

  private closed = false;

  constructor(options: RoundJobSchedulerOptions) {
    this.storage = options.storage;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.timer =
      options.timer ??
      ({
        setTimeout: (callback, delayMs) =>
          globalThis.setTimeout(callback, delayMs),
        clearTimeout: (handle) =>
          globalThis.clearTimeout(
            handle as ReturnType<typeof globalThis.setTimeout>,
          ),
      } satisfies RoundJobTimer);
    this.storageStream =
      options.storageStream ?? DEFAULT_ROUND_JOBS_STORAGE_STREAM;
    this.deadLetterStream =
      options.deadLetterStream ??
      DEFAULT_ROUND_JOB_DEAD_LETTER_STREAM;
    this.metrics = options.metrics ?? NOOP_METRICS;

    for (const [jobType, handler] of Object.entries(
      options.handlers ?? {},
    )) {
      this.registerHandler(jobType, handler);
    }
  }

  static async create(
    options: RoundJobSchedulerOptions,
  ): Promise<RoundJobScheduler> {
    const scheduler = new RoundJobScheduler(options);
    await scheduler.restore();
    return scheduler;
  }

  registerHandler(jobType: string, handler: RoundJobHandler): void {
    if (jobType.trim().length === 0 || jobType.includes(":")) {
      throw new TypeError(
        "round job handler type must not be empty or contain a colon",
      );
    }
    if (this.handlers.has(jobType)) {
      throw new Error(`A handler is already registered for "${jobType}"`);
    }

    this.handlers.set(jobType, handler);
    for (const job of this.jobs.values()) {
      if (job.jobType === jobType && job.status === "pending") {
        this.arm(job);
      }
    }
  }

  async restore(): Promise<void> {
    this.restorePromise ??= this.restoreFromStorage();
    await this.restorePromise;
  }

  schedule(input: ScheduleRoundJob): Promise<boolean> {
    validateSchedule(input);

    return this.enqueueMetadata(async () => {
      await this.restore();
      const key = roundJobKey(
        input.boutId,
        input.round,
        input.jobType,
      );
      if (this.jobs.has(key)) return false;

      const now = this.now();
      const job: RoundJob = {
        version: 1,
        key,
        boutId: input.boutId,
        round: input.round,
        jobType: input.jobType,
        status: "pending",
        dueAt: input.dueAt,
        attemptCount: 0,
        retryPolicy: { ...input.retryPolicy },
        createdAt: now,
        updatedAt: now,
      };
      await this.storage.append(this.storageStream, job);
      this.jobs.set(key, job);
      this.arm(job);
      return true;
    });
  }

  getJob(key: string): RoundJob | undefined {
    const job = this.jobs.get(key);
    return job === undefined ? undefined : copyJob(job);
  }

  getJobs(): readonly RoundJob[] {
    return [...this.jobs.values()]
      .map(copyJob)
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  async idle(): Promise<void> {
    while (true) {
      await this.metadataQueue;
      const active = [...this.active];
      if (active.length === 0) return;
      await Promise.allSettled(active);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const handle of this.timers.values()) {
      this.timer.clearTimeout(handle);
    }
    this.timers.clear();
    await this.idle();
  }

  private enqueueMetadata<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const result = this.metadataQueue.then(operation);
    this.metadataQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async restoreFromStorage(): Promise<void> {
    const records = await this.storage.read<unknown>(this.storageStream);
    this.jobs.clear();

    for (const record of records) {
      if (isRoundJob(record)) {
        this.jobs.set(record.key, copyJob(record));
      }
    }

    for (const job of this.jobs.values()) {
      if (job.status === "pending") this.arm(job);
    }
  }

  private arm(job: RoundJob): void {
    if (
      this.closed ||
      job.status !== "pending" ||
      !this.handlers.has(job.jobType) ||
      this.timers.has(job.key)
    ) {
      return;
    }

    const delayMs = Math.max(0, job.dueAt - this.now());
    const handle = this.timer.setTimeout(() => {
      this.timers.delete(job.key);
      this.track(this.runJob(job.key));
    }, delayMs);
    this.timers.set(job.key, handle);
  }

  private track(operation: Promise<void>): void {
    this.active.add(operation);
    void operation.then(
      () => this.active.delete(operation),
      () => this.active.delete(operation),
    );
  }

  private async runJob(key: string): Promise<void> {
    const attempt = await this.enqueueMetadata(async () => {
      const current = this.jobs.get(key);
      if (current === undefined || current.status !== "pending") {
        return undefined;
      }

      if (current.attemptCount >= current.retryPolicy.maxAttempts) {
        await this.failTerminal(
          current,
          current.lastError ?? "maximum attempts exhausted",
        );
        return undefined;
      }

      const next: RoundJob = {
        ...current,
        attemptCount: current.attemptCount + 1,
        updatedAt: this.now(),
      };
      await this.storage.append(this.storageStream, next);
      this.jobs.set(key, next);
      return copyJob(next);
    });

    if (attempt === undefined) return;
    const handler = this.handlers.get(attempt.jobType);
    if (handler === undefined) return;

    try {
      await handler(copyJob(attempt));
      await this.enqueueMetadata(async () => {
        const current = this.jobs.get(key);
        if (current === undefined || current.status !== "pending") return;

        const completedAt = this.now();
        const completed: RoundJob = {
          ...current,
          status: "completed",
          updatedAt: completedAt,
          completedAt,
        };
        await this.storage.append(this.storageStream, completed);
        this.jobs.set(key, completed);
        this.metrics.set(
          "source_response_latency_ms",
          roundJobSource(completed.jobType),
          Math.max(0, completedAt - attempt.updatedAt),
          { localTimestamp: new Date(completedAt).toISOString() },
        );
      });
    } catch (error) {
      await this.enqueueMetadata(async () => {
        const current = this.jobs.get(key);
        if (current === undefined || current.status !== "pending") return;

        const message = errorMessage(error);
        this.metrics.increment(
          "source_errors_total",
          roundJobSource(current.jobType),
          1,
          { localTimestamp: new Date(this.now()).toISOString() },
        );
        if (
          error instanceof TerminalRoundJobError ||
          current.attemptCount >= current.retryPolicy.maxAttempts
        ) {
          await this.failTerminal(current, message);
          return;
        }

        const now = this.now();
        const retry: RoundJob = {
          ...current,
          dueAt: now + current.retryPolicy.delayMs,
          updatedAt: now,
          lastError: message,
        };
        await this.storage.append(this.storageStream, retry);
        this.jobs.set(key, retry);
        this.arm(retry);
      });
    }
  }

  private async failTerminal(
    current: RoundJob,
    message: string,
  ): Promise<void> {
    const failedAt = this.now();
    const failed: RoundJob = {
      ...current,
      status: "failed",
      updatedAt: failedAt,
      failedAt,
      lastError: message,
    };
    const deadLetter: RoundJobDeadLetter = {
      version: 1,
      job: copyJob(failed),
      deadLetteredAt: failedAt,
      error: message,
    };
    await this.storage.append(this.storageStream, failed);
    await this.storage.append(this.deadLetterStream, deadLetter);
    this.jobs.set(current.key, failed);
  }

  private now(): number {
    const now = this.clock.now();
    if (!Number.isFinite(now)) {
      throw new TypeError("round job clock must return a finite timestamp");
    }
    return now;
  }
}
