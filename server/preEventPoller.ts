/**
 * Owns the collector's bounded pre-event market refresh cadence.
 *
 * The upcoming sync is deliberately a whole-document operation, so this
 * scheduler persists only its successful completion time and derives the next
 * interval from the event dates in the document it just refreshed.
 */

import { dirname } from "node:path";
import type { UpcomingOddsDocument } from "../src/lib/upcomingOdds.ts";
import { runUpcomingSync, type RunSyncResult } from "./syncUpcoming.ts";
import type { CollectorEventBus } from "./eventBus.ts";
import { NOOP_METRICS, type Metrics } from "./health.ts";
import type { FightLifecycleState } from "./lifecycle.ts";
import type { Storage } from "./storage.ts";
import { readUpcomingOddsDocument } from "./upcomingOddsStore.ts";

export const PRE_EVENT_INTERVAL_NON_EVENT_DAY_MS = 12 * 60 * 60 * 1_000;
export const PRE_EVENT_INTERVAL_EVENT_DAY_MS = 60 * 60 * 1_000;
export const PRE_EVENT_POLL_STORAGE_STREAM = "pre-event-polls";
export const PRE_EVENT_POLL_SOURCE = "pre-event-poll";
export const DEFAULT_PRE_EVENT_POLL_RETRY_MS = 15 * 60 * 1_000;

export type PreEventPollMode = "event-day" | "non-event-day";

export interface PreEventPollClock {
  now(): number;
}

export interface PreEventPollTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PreEventPollLogger {
  error(message: string): void;
}

export interface PreEventPollSuccessRecord {
  version: 1;
  completedAt: number;
  intervalMs: number;
  mode: PreEventPollMode;
}

export interface PreEventPollFailureRecord {
  version: 1;
  failedAt: number;
  retryAt: number;
  reason: "retryable" | "terminal";
}

export type PreEventPollRecord =
  | PreEventPollSuccessRecord
  | PreEventPollFailureRecord;

export interface PreEventPollerOptions {
  storage: Storage;
  eventBus?: Pick<CollectorEventBus, "subscribe">;
  getLifecycleStates?: () => readonly FightLifecycleState[];
  clock?: PreEventPollClock;
  timer?: PreEventPollTimer;
  runSync?: () => Promise<RunSyncResult | void>;
  /** Promotes a successful sync into any live runtime registries/subscriptions. */
  onSuccess?: (result: RunSyncResult | void) => Promise<void> | void;
  /** Reads the atomic upcoming document after restore and after a sync. */
  readDocument?: () => Promise<UpcomingOddsDocument | null>;
  /** Used by the default document reader when the collector owns the path. */
  persistencePath?: string;
  enabled?: boolean;
  storageStream?: string;
  nonEventDayIntervalMs?: number;
  eventDayIntervalMs?: number;
  retryMs?: number;
  metrics?: Metrics;
  logger?: PreEventPollLogger;
}

function defaultClock(): PreEventPollClock {
  return { now: () => Date.now() };
}

function defaultTimer(): PreEventPollTimer {
  return {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  };
}

const DEFAULT_LOGGER: PreEventPollLogger = {
  error(message) {
    console.error(message);
  },
};

function timestampFromIso(iso: string): number | undefined {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Returns the calendar day represented by an ISO timestamp's own offset.
 * ESPN currently emits `Z`, so this is UTC in live cards today; validate a
 * live card with its source payload before treating that as permanent timezone
 * precision (see the deferred live-card validation item in the spec).
 */
export function sourceCalendarDay(
  iso: string,
): { day: string; offsetMinutes: number } {
  const timestamp = timestampFromIso(iso);
  const match = /(Z|([+-])(\d{2}):?(\d{2}))$/iu.exec(iso);
  if (timestamp === undefined || match === null) {
    throw new TypeError("ISO timestamp must include a valid UTC offset");
  }

  const offsetMinutes =
    (match[1] ?? "").toUpperCase() === "Z"
      ? 0
      : (Number(match[3]) * 60 + Number(match[4])) *
        (match[2] === "-" ? -1 : 1);
  if (Math.abs(offsetMinutes) > 14 * 60 || Number.isNaN(offsetMinutes)) {
    throw new TypeError("ISO timestamp has an invalid UTC offset");
  }

  return {
    day: new Date(timestamp + offsetMinutes * 60_000)
      .toISOString()
      .slice(0, 10),
    offsetMinutes,
  };
}

function isEventDay(now: number, eventStartTimes: readonly string[]): boolean {
  for (const iso of eventStartTimes) {
    const start = timestampFromIso(iso);
    if (start === undefined || start <= now) continue;

    try {
      const sourceDay = sourceCalendarDay(iso);
      const nowDay = new Date(now + sourceDay.offsetMinutes * 60_000)
        .toISOString()
        .slice(0, 10);
      if (sourceDay.day === nowDay) return true;
    } catch {
      // A malformed provider timestamp must not disable the other events.
    }
  }
  return false;
}

export function preEventIntervalMs(input: {
  now: number;
  eventStartTimes: readonly string[];
}): number {
  if (!Number.isFinite(input.now)) {
    throw new TypeError("pre-event poll now must be a finite timestamp");
  }
  return isEventDay(input.now, input.eventStartTimes)
    ? PRE_EVENT_INTERVAL_EVENT_DAY_MS
    : PRE_EVENT_INTERVAL_NON_EVENT_DAY_MS;
}

export function nextPreEventPollAt(input: {
  now: number;
  lastSuccessAt?: number;
  eventStartTimes: readonly string[];
}): number {
  if (!Number.isFinite(input.now)) {
    throw new TypeError("pre-event poll now must be a finite timestamp");
  }
  if (input.lastSuccessAt === undefined) return input.now;
  if (!Number.isFinite(input.lastSuccessAt)) {
    throw new TypeError("pre-event poll lastSuccessAt must be finite");
  }
  return (
    input.lastSuccessAt +
    preEventIntervalMs({
      now: input.now,
      eventStartTimes: input.eventStartTimes,
    })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseCompletedAt(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") return timestampFromIso(value);
  return undefined;
}

function isSuccessRecord(value: unknown): value is PreEventPollSuccessRecord {
  if (!isRecord(value) || value.version !== 1) return false;
  const completedAt = parseCompletedAt(value.completedAt);
  return (
    completedAt !== undefined &&
    typeof value.intervalMs === "number" &&
    Number.isFinite(value.intervalMs) &&
    value.intervalMs > 0 &&
    (value.mode === "event-day" || value.mode === "non-event-day")
  );
}

function isTerminalFailure(error: unknown): boolean {
  if (!isRecord(error)) {
    return error instanceof Error &&
      /authentication|unauthori[sz]ed|quota|rate limit|too many requests/iu.test(
        error.message,
      );
  }
  const kind = typeof error.kind === "string" ? error.kind.toLowerCase() : "";
  const code = typeof error.code === "string" ? error.code.toLowerCase() : "";
  const status = typeof error.status === "number" ? error.status : undefined;
  return (
    kind === "auth" ||
    kind === "authentication" ||
    kind === "quota" ||
    code === "auth" ||
    code === "quota" ||
    status === 401 ||
    status === 403 ||
    status === 429 ||
    (typeof error.message === "string" &&
      /authentication|unauthori[sz]ed|quota|rate limit|too many requests/iu.test(
        error.message,
      ))
  );
}

function eventStartTimes(document: UpcomingOddsDocument | null): string[] {
  if (document === null) return [];
  return document.events.flatMap((event) => {
    const starts = event.startsAt === undefined ? [] : [event.startsAt];
    return starts.concat(
      event.bouts.flatMap((bout) =>
        bout.startsAt === undefined ? [] : [bout.startsAt],
      ),
    );
  });
}

function hasActiveBout(
  states: readonly FightLifecycleState[] | undefined,
): boolean {
  return (
    states?.some((state) => state.state === "in" && !state.completed) ?? false
  );
}

export class PreEventPoller {
  private readonly storage: Storage;
  private readonly eventBus: Pick<CollectorEventBus, "subscribe"> | undefined;
  private readonly getLifecycleStates:
    | (() => readonly FightLifecycleState[])
    | undefined;
  private readonly clock: PreEventPollClock;
  private readonly timer: PreEventPollTimer;
  private readonly runSync: NonNullable<PreEventPollerOptions["runSync"]>;
  private readonly readDocument:
    | (() => Promise<UpcomingOddsDocument | null>)
    | undefined;
  private readonly onSuccess: PreEventPollerOptions["onSuccess"];
  private readonly storageStream: string;
  private readonly enabled: boolean;
  private readonly nonEventDayIntervalMs: number;
  private readonly eventDayIntervalMs: number;
  private readonly retryMs: number;
  private readonly metrics: Metrics;
  private readonly logger: PreEventPollLogger;
  private readonly unsubscribers: Array<() => void> = [];

  private eventStartTimes: string[] = [];
  private lastSuccessAt: number | undefined;
  private timerHandle: unknown;
  private currentRun: Promise<void> | undefined;
  private restorePromise: Promise<void> | undefined;
  private started = false;
  private suspended = false;
  private skippedSuspendedSlot = false;
  private closed = false;

  constructor(options: PreEventPollerOptions) {
    this.storage = options.storage;
    this.eventBus = options.eventBus;
    this.getLifecycleStates = options.getLifecycleStates;
    this.clock = options.clock ?? defaultClock();
    this.timer = options.timer ?? defaultTimer();
    this.runSync = options.runSync ?? (() => runUpcomingSync());
    this.onSuccess = options.onSuccess;
    this.readDocument =
      options.readDocument ??
      (options.persistencePath === undefined
        ? undefined
        : () => readUpcomingOddsDocument(options.persistencePath!));
    this.storageStream =
      options.storageStream ?? PRE_EVENT_POLL_STORAGE_STREAM;
    this.enabled = options.enabled ?? true;
    this.nonEventDayIntervalMs =
      options.nonEventDayIntervalMs ?? PRE_EVENT_INTERVAL_NON_EVENT_DAY_MS;
    this.eventDayIntervalMs =
      options.eventDayIntervalMs ?? PRE_EVENT_INTERVAL_EVENT_DAY_MS;
    this.retryMs = options.retryMs ?? DEFAULT_PRE_EVENT_POLL_RETRY_MS;
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.logger = options.logger ?? DEFAULT_LOGGER;

    for (const [name, value] of [
      ["nonEventDayIntervalMs", this.nonEventDayIntervalMs],
      ["eventDayIntervalMs", this.eventDayIntervalMs],
      ["retryMs", this.retryMs],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new TypeError(`pre-event poll ${name} must be positive`);
      }
    }
  }

  isStarted(): boolean {
    return this.started;
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  getLastSuccessAt(): number | undefined {
    return this.lastSuccessAt;
  }

  async restore(): Promise<void> {
    this.restorePromise ??= this.restoreFromStorage();
    await this.restorePromise;
  }

  async start(): Promise<void> {
    if (this.started || this.closed) return;
    await this.restore();
    this.started = true;
    this.subscribeToLifecycle();
    if (!this.enabled) return;

    this.suspended = hasActiveBout(this.getLifecycleStates?.());
    const nextAt = this.nextScheduledAt(this.clock.now());
    if (this.suspended) {
      if (nextAt <= this.clock.now()) this.skippedSuspendedSlot = true;
      return;
    }
    if (nextAt <= this.clock.now()) {
      await this.trigger();
    } else {
      this.armAt(nextAt);
    }
  }

  /** Requests one run; simultaneous callers share the same in-flight work. */
  async trigger(): Promise<void> {
    if (this.currentRun !== undefined) return this.currentRun;

    const run = this.triggerInternal();
    this.currentRun = run;
    try {
      await run;
    } finally {
      if (this.currentRun === run) this.currentRun = undefined;
    }
  }

  private async triggerInternal(): Promise<void> {
    await this.restore();
    if (!this.enabled || this.closed) return;
    if (this.suspended) {
      this.skippedSuspendedSlot = true;
      this.clearTimer();
      return;
    }
    await this.runOnce();
  }

  async idle(): Promise<void> {
    while (this.currentRun !== undefined) {
      const run = this.currentRun;
      await run;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.idle();
      return;
    }
    this.closed = true;
    this.clearTimer();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    await this.idle();
  }

  private async restoreFromStorage(): Promise<void> {
    const records = await this.storage.read<unknown>(this.storageStream);
    const latest = [...records].reverse().find(isSuccessRecord);
    this.lastSuccessAt =
      latest === undefined ? undefined : parseCompletedAt(latest.completedAt);

    if (this.readDocument !== undefined) {
      try {
        this.eventStartTimes = eventStartTimes(await this.readDocument());
      } catch {
        this.eventStartTimes = [];
      }
    }
  }

  private subscribeToLifecycle(): void {
    if (this.eventBus === undefined || this.unsubscribers.length > 0) return;
    this.unsubscribers.push(
      this.eventBus.subscribe("FIGHT_STARTED", () => {
        this.suspended = true;
        const nextAt = this.nextScheduledAt(this.clock.now());
        if (nextAt <= this.clock.now()) this.skippedSuspendedSlot = true;
        this.clearTimer();
      }),
      this.eventBus.subscribe("FIGHT_ENDED", () => {
        this.suspended = hasActiveBout(this.getLifecycleStates?.());
        if (this.suspended || !this.started || !this.enabled) return;

        const now = this.clock.now();
        if (
          !this.skippedSuspendedSlot &&
          this.nextScheduledAt(now) <= now
        ) {
          // A timer is cleared as soon as a bout starts. If the cleared slot
          // passed during the fight, mark it skipped here rather than running
          // a stale backlog immediately after the final bell.
          this.skippedSuspendedSlot = true;
        }
        if (this.skippedSuspendedSlot) {
          this.skippedSuspendedSlot = false;
          this.armAt(now + this.intervalFor(now).intervalMs);
          return;
        }
        const nextAt = this.nextScheduledAt(now);
        if (nextAt <= now) void this.trigger().catch(() => undefined);
        else this.armAt(nextAt);
      }),
    );
  }

  private intervalFor(now: number): {
    intervalMs: number;
    mode: PreEventPollMode;
  } {
    const mode: PreEventPollMode = isEventDay(now, this.eventStartTimes)
      ? "event-day"
      : "non-event-day";
    return {
      mode,
      intervalMs:
        mode === "event-day"
          ? this.eventDayIntervalMs
          : this.nonEventDayIntervalMs,
    };
  }

  private nextScheduledAt(now: number): number {
    if (this.lastSuccessAt === undefined) return now;
    return this.lastSuccessAt + this.intervalFor(now).intervalMs;
  }

  private armAt(at: number): void {
    if (this.closed || !this.enabled || this.suspended) return;
    this.clearTimer();
    const delayMs = Math.max(0, at - this.clock.now());
    this.timerHandle = this.timer.setTimeout(() => {
      this.timerHandle = undefined;
      void this.trigger().catch(() => undefined);
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timerHandle === undefined) return;
    this.timer.clearTimeout(this.timerHandle);
    this.timerHandle = undefined;
  }

  private async runOnce(): Promise<void> {
    const startedAt = this.clock.now();
    this.metrics.increment("source_requests_total", PRE_EVENT_POLL_SOURCE, 1, {
      localTimestamp: new Date(startedAt).toISOString(),
    });

    try {
      const result = await this.runSync();
      if (this.readDocument !== undefined) {
        try {
          const document = await this.readDocument();
          this.eventStartTimes = eventStartTimes(document);
        } catch {
          // The sync already owns the atomic document write; a stale cache is
          // safer than turning a successful refresh into a duplicate retry.
        }
      } else if (result?.path !== undefined) {
        const document = await readUpcomingOddsDocument(dirname(result.path));
        this.eventStartTimes = eventStartTimes(document);
      }
      await this.onSuccess?.(result);

      const completedAt = this.clock.now();
      const completedInterval = this.intervalFor(completedAt);
      await this.storage.append(this.storageStream, {
        version: 1,
        completedAt,
        intervalMs: completedInterval.intervalMs,
        mode: completedInterval.mode,
      } satisfies PreEventPollSuccessRecord);
      this.lastSuccessAt = completedAt;
      this.skippedSuspendedSlot = false;
      this.rearmAfterSuccess(completedAt);
    } catch (error) {
      const terminal = isTerminalFailure(error);
      const failedAt = this.clock.now();
      this.metrics.increment("source_errors_total", PRE_EVENT_POLL_SOURCE, 1, {
        localTimestamp: new Date(failedAt).toISOString(),
      });
      this.logger.error(
        `Pre-event market poll failed; ${terminal ? "waiting for the next scheduled slot" : "retrying after the bounded delay"}`,
      );
      const retryAt = terminal
        ? Math.max(
            this.nextScheduledAt(failedAt),
            failedAt + this.intervalFor(failedAt).intervalMs,
          )
        : failedAt + this.retryMs;
      await this.storage
        .append(this.storageStream, {
          version: 1,
          failedAt,
          retryAt,
          reason: terminal ? "terminal" : "retryable",
        } satisfies PreEventPollFailureRecord)
        .catch(() => undefined);
      this.armAt(retryAt);
    }
  }

  private rearmAfterSuccess(completedAt: number): void {
    if (this.suspended) return;
    this.armAt(completedAt + this.intervalFor(completedAt).intervalMs);
  }
}
