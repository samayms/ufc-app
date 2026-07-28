import type { Storage } from "./storage.ts";

export const DEFAULT_QUOTA_STORAGE_STREAM = "quota-acquisitions";

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
}

interface PersistedAcquisition {
  version: 1;
  source: string;
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
