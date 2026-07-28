import type { Storage } from "./storage.ts";
import { NOOP_METRICS, type Metrics } from "./health.ts";

export const DEFAULT_QUOTA_STORAGE_STREAM = "quota-acquisitions";
export const DEFAULT_INTERVAL_QUOTA_STORAGE_STREAM =
  "interval-quota-acquisitions";
export const DEFAULT_SPEND_STORAGE_STREAM = "spend-acquisitions";
export const DEFAULT_ODDS_API_IO_QUOTA_POLICY: QuotaPolicy = {
  perMinute: 90,
  perHour: 90,
  perDay: 450,
};

export type QuotaWindow = "minute" | "hour" | "day";

export interface QuotaPolicy {
  perMinute: number;
  perHour: number;
  perDay: number;
}

export interface QuotaRemaining {
  minute: number;
  hour: number;
  day: number;
}

export interface QuotaClock {
  now(): number;
}

export interface RollingQuotaGuardOptions {
  storage: Storage;
  policies: Readonly<Record<string, QuotaPolicy>>;
  clock?: QuotaClock;
  storageStream?: string;
  metrics?: Metrics;
}

interface PersistedAcquisition {
  version: 1;
  source: string;
  acquiredAt: number;
}

interface PersistedIntervalAcquisition {
  version: 1;
  source: string;
  acquiredAt: number;
}

interface PersistedSpend {
  version: 1;
  source: string;
  spentCents: number;
  acquiredAt: number;
}

const WINDOW_MS: Readonly<Record<QuotaWindow, number>> = {
  minute: 60_000,
  hour: 60 * 60_000,
  day: 24 * 60 * 60_000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPersistedAcquisition(
  value: unknown,
): value is PersistedAcquisition {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.source === "string" &&
    value.source.length > 0 &&
    typeof value.acquiredAt === "number" &&
    Number.isFinite(value.acquiredAt)
  );
}

function isPersistedIntervalAcquisition(
  value: unknown,
): value is PersistedIntervalAcquisition {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.source === "string" &&
    value.source.length > 0 &&
    typeof value.acquiredAt === "number" &&
    Number.isFinite(value.acquiredAt)
  );
}

function isPersistedSpend(value: unknown): value is PersistedSpend {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.source === "string" &&
    value.source.length > 0 &&
    typeof value.spentCents === "number" &&
    Number.isSafeInteger(value.spentCents) &&
    value.spentCents >= 0 &&
    typeof value.acquiredAt === "number" &&
    Number.isFinite(value.acquiredAt)
  );
}

function usdToCents(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative number`);
  }
  return Math.round(value * 100);
}

function validateLimit(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
}

function validatePolicy(source: string, policy: QuotaPolicy): void {
  if (source.trim().length === 0) {
    throw new TypeError("quota source names must not be empty");
  }

  validateLimit(policy.perMinute, `${source}.perMinute`);
  validateLimit(policy.perHour, `${source}.perHour`);
  validateLimit(policy.perDay, `${source}.perDay`);
}

function limitFor(
  policy: QuotaPolicy,
  window: QuotaWindow,
): number {
  switch (window) {
    case "minute":
      return policy.perMinute;
    case "hour":
      return policy.perHour;
    case "day":
      return policy.perDay;
  }
}

export class RollingQuotaGuard {
  private readonly storage: Storage;

  private readonly policies: Readonly<Record<string, QuotaPolicy>>;

  private readonly clock: QuotaClock;

  private readonly storageStream: string;

  private readonly metrics: Metrics;

  private readonly acquisitions = new Map<string, number[]>();

  private restorePromise: Promise<void> | undefined;

  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: RollingQuotaGuardOptions) {
    for (const [source, policy] of Object.entries(options.policies)) {
      validatePolicy(source, policy);
    }

    this.storage = options.storage;
    this.policies = options.policies;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.storageStream =
      options.storageStream ?? DEFAULT_QUOTA_STORAGE_STREAM;
    this.metrics = options.metrics ?? NOOP_METRICS;
  }

  static async create(
    options: RollingQuotaGuardOptions,
  ): Promise<RollingQuotaGuard> {
    const guard = new RollingQuotaGuard(options);
    await guard.restore();
    return guard;
  }

  async restore(): Promise<void> {
    this.restorePromise ??= this.restoreFromStorage();
    await this.restorePromise;
  }

  remaining(source: string): Promise<QuotaRemaining> {
    return this.enqueue(async () => {
      await this.restore();
      const policy = this.policyFor(source);
      const now = this.now();
      const acquisitions = this.activeAcquisitions(source, now);

      return {
        minute: Math.max(
          0,
          policy.perMinute -
            this.countInside(acquisitions, now, "minute"),
        ),
        hour: Math.max(
          0,
          policy.perHour -
            this.countInside(acquisitions, now, "hour"),
        ),
        day: Math.max(
          0,
          policy.perDay -
            this.countInside(acquisitions, now, "day"),
        ),
      };
    });
  }

  tryAcquire(source: string): Promise<boolean> {
    return this.enqueue(async () => {
      await this.restore();
      const policy = this.policyFor(source);
      const now = this.now();
      const acquisitions = this.activeAcquisitions(source, now);

      for (const window of [
        "minute",
        "hour",
        "day",
      ] as const) {
        if (
          this.countInside(acquisitions, now, window) >=
          limitFor(policy, window)
        ) {
          this.metrics.set(
            "source_rate_limit_remaining",
            source,
            0,
            {
              localTimestamp: new Date(now).toISOString(),
            },
          );
          return false;
        }
      }

      const record: PersistedAcquisition = {
        version: 1,
        source,
        acquiredAt: now,
      };
      await this.storage.append(this.storageStream, record);
      acquisitions.push(now);
      this.acquisitions.set(source, acquisitions);
      this.metrics.increment("source_requests_total", source, 1, {
        localTimestamp: new Date(now).toISOString(),
      });
      this.metrics.set(
        "source_rate_limit_remaining",
        source,
        Math.max(
          0,
          policy.perDay -
            this.countInside(acquisitions, now, "day"),
        ),
        { localTimestamp: new Date(now).toISOString() },
      );
      return true;
    });
  }

  async isRemainingAtOrBelow(
    source: string,
    window: QuotaWindow,
    threshold: number,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(threshold) || threshold < 0) {
      throw new TypeError("quota threshold must be a non-negative integer");
    }

    const remaining = await this.remaining(source);
    return remaining[window] <= threshold;
  }

  async hasRemaining(
    source: string,
    window: QuotaWindow,
    minimum = 1,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(minimum) || minimum < 0) {
      throw new TypeError("quota minimum must be a non-negative integer");
    }

    const remaining = await this.remaining(source);
    return remaining[window] >= minimum;
  }

  private enqueue<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async restoreFromStorage(): Promise<void> {
    const records = await this.storage.read<unknown>(this.storageStream);
    const now = this.now();
    this.acquisitions.clear();

    for (const record of records) {
      if (
        !isPersistedAcquisition(record) ||
        this.policies[record.source] === undefined ||
        record.acquiredAt > now ||
        record.acquiredAt <= now - WINDOW_MS.day
      ) {
        continue;
      }

      const sourceAcquisitions =
        this.acquisitions.get(record.source) ?? [];
      sourceAcquisitions.push(record.acquiredAt);
      this.acquisitions.set(record.source, sourceAcquisitions);
    }

    for (const acquisitions of this.acquisitions.values()) {
      acquisitions.sort((left, right) => left - right);
    }
  }

  private policyFor(source: string): QuotaPolicy {
    const policy = this.policies[source];
    if (policy === undefined) {
      throw new TypeError(`No quota policy configured for "${source}"`);
    }
    return policy;
  }

  private now(): number {
    const now = this.clock.now();
    if (!Number.isFinite(now)) {
      throw new TypeError("quota clock must return a finite timestamp");
    }
    return now;
  }

  private activeAcquisitions(source: string, now: number): number[] {
    const active = (this.acquisitions.get(source) ?? []).filter(
      (acquiredAt) =>
        acquiredAt > now - WINDOW_MS.day && acquiredAt <= now,
    );
    this.acquisitions.set(source, active);
    return active;
  }

  private countInside(
    acquisitions: readonly number[],
    now: number,
    window: QuotaWindow,
  ): number {
    const cutoff = now - WINDOW_MS[window];
    return acquisitions.filter((acquiredAt) => acquiredAt > cutoff).length;
  }
}

export interface RequestIntervalGuardOptions {
  storage: Storage;
  intervalsMs: Readonly<Record<string, number>>;
  clock?: QuotaClock;
  storageStream?: string;
  metrics?: Metrics;
}

/**
 * A persisted, serialized minimum-spacing guard for permission-bound sources.
 * A denied acquisition never invokes the external request.
 */
export class RequestIntervalGuard {
  private readonly storage: Storage;

  private readonly intervalsMs: Readonly<Record<string, number>>;

  private readonly clock: QuotaClock;

  private readonly storageStream: string;

  private readonly metrics: Metrics;

  private readonly lastAcquiredAt = new Map<string, number>();

  private restorePromise: Promise<void> | undefined;

  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: RequestIntervalGuardOptions) {
    for (const [source, intervalMs] of Object.entries(options.intervalsMs)) {
      if (
        source.trim().length === 0 ||
        !Number.isFinite(intervalMs) ||
        intervalMs < 0
      ) {
        throw new TypeError(
          "interval quota sources require a non-empty name and non-negative interval",
        );
      }
    }
    this.storage = options.storage;
    this.intervalsMs = options.intervalsMs;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.storageStream =
      options.storageStream ?? DEFAULT_INTERVAL_QUOTA_STORAGE_STREAM;
    this.metrics = options.metrics ?? NOOP_METRICS;
  }

  static async create(
    options: RequestIntervalGuardOptions,
  ): Promise<RequestIntervalGuard> {
    const guard = new RequestIntervalGuard(options);
    await guard.restore();
    return guard;
  }

  async restore(): Promise<void> {
    this.restorePromise ??= this.restoreFromStorage();
    await this.restorePromise;
  }

  tryAcquire(source: string): Promise<boolean> {
    return this.enqueue(async () => {
      await this.restore();
      const intervalMs = this.intervalsMs[source];
      if (intervalMs === undefined) {
        throw new TypeError(
          `No request interval configured for "${source}"`,
        );
      }
      const now = this.now();
      const previous = this.lastAcquiredAt.get(source);
      if (previous !== undefined && now - previous < intervalMs) {
        return false;
      }

      const record: PersistedIntervalAcquisition = {
        version: 1,
        source,
        acquiredAt: now,
      };
      await this.storage.append(this.storageStream, record);
      this.lastAcquiredAt.set(source, now);
      this.metrics.increment("source_requests_total", source, 1, {
        localTimestamp: new Date(now).toISOString(),
      });
      return true;
    });
  }

  private enqueue<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async restoreFromStorage(): Promise<void> {
    const records = await this.storage.read<unknown>(this.storageStream);
    this.lastAcquiredAt.clear();
    for (const record of records) {
      if (
        !isPersistedIntervalAcquisition(record) ||
        this.intervalsMs[record.source] === undefined
      ) {
        continue;
      }
      const previous = this.lastAcquiredAt.get(record.source);
      if (previous === undefined || record.acquiredAt > previous) {
        this.lastAcquiredAt.set(record.source, record.acquiredAt);
      }
    }
  }

  private now(): number {
    const now = this.clock.now();
    if (!Number.isFinite(now)) {
      throw new TypeError("interval quota clock must return a finite timestamp");
    }
    return now;
  }
}

export interface SpendingCapGuardOptions {
  storage: Storage;
  capsUsd: Readonly<Record<string, number>>;
  clock?: QuotaClock;
  storageStream?: string;
  metrics?: Metrics;
}

/** Persisted cents-based counter used before any paid API request. */
export class SpendingCapGuard {
  private readonly storage: Storage;

  private readonly capsCents: Readonly<Record<string, number>>;

  private readonly clock: QuotaClock;

  private readonly storageStream: string;

  private readonly metrics: Metrics;

  private readonly totals = new Map<string, number>();

  private restorePromise: Promise<void> | undefined;

  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: SpendingCapGuardOptions) {
    this.capsCents = Object.fromEntries(
      Object.entries(options.capsUsd).map(([source, cap]) => {
        if (source.trim().length === 0) {
          throw new TypeError("spending cap source names must not be empty");
        }
        return [source, usdToCents(cap, `${source} spending cap`)];
      }),
    );
    this.storage = options.storage;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.storageStream =
      options.storageStream ?? DEFAULT_SPEND_STORAGE_STREAM;
    this.metrics = options.metrics ?? NOOP_METRICS;
  }

  static async create(
    options: SpendingCapGuardOptions,
  ): Promise<SpendingCapGuard> {
    const guard = new SpendingCapGuard(options);
    await guard.restore();
    return guard;
  }

  async restore(): Promise<void> {
    this.restorePromise ??= this.restoreFromStorage();
    await this.restorePromise;
  }

  spentUsd(source: string): Promise<number> {
    return this.enqueue(async () => {
      await this.restore();
      this.capFor(source);
      return (this.totals.get(source) ?? 0) / 100;
    });
  }

  trySpend(source: string, amountUsd: number): Promise<boolean> {
    const amountCents = usdToCents(amountUsd, "spend amount");
    if (amountCents < 1) {
      return Promise.reject(
        new TypeError("spend amount must round to at least one cent"),
      );
    }

    return this.enqueue(async () => {
      await this.restore();
      const capCents = this.capFor(source);
      const current = this.totals.get(source) ?? 0;
      if (current + amountCents > capCents) return false;

      const record: PersistedSpend = {
        version: 1,
        source,
        spentCents: amountCents,
        acquiredAt: this.now(),
      };
      await this.storage.append(this.storageStream, record);
      this.totals.set(source, current + amountCents);
      this.metrics.increment("source_requests_total", source, 1, {
        localTimestamp: new Date(record.acquiredAt).toISOString(),
      });
      return true;
    });
  }

  private capFor(source: string): number {
    const cap = this.capsCents[source];
    if (cap === undefined) {
      throw new TypeError(`No spending cap configured for "${source}"`);
    }
    return cap;
  }

  private enqueue<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async restoreFromStorage(): Promise<void> {
    const records = await this.storage.read<unknown>(this.storageStream);
    this.totals.clear();
    for (const record of records) {
      if (
        !isPersistedSpend(record) ||
        this.capsCents[record.source] === undefined
      ) {
        continue;
      }
      this.totals.set(
        record.source,
        (this.totals.get(record.source) ?? 0) + record.spentCents,
      );
    }
  }

  private now(): number {
    const now = this.clock.now();
    if (!Number.isFinite(now)) {
      throw new TypeError("spending cap clock must return a finite timestamp");
    }
    return now;
  }
}
