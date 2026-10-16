import { COLLECTOR_STATE_STREAM } from "./collector.ts";
import { EVENT_ROTATION_STORAGE_STREAM } from "./eventRotationSupervisor.ts";
import {
  HEALTH_ALERT_STORAGE_STREAM,
  SOURCE_HEALTH_STORAGE_STREAM,
  SOURCE_METRICS_STORAGE_STREAM,
} from "./health.ts";
import { LAB_TIMELINE_STREAM } from "./lab/timeline.ts";
import { DEFAULT_LIFECYCLE_STORAGE_STREAM } from "./lifecycle.ts";
import {
  AMBIGUOUS_MAPPING_STREAM,
  BOUT_MAPPING_OVERRIDE_STREAM,
  BOUT_MAPPING_STREAM,
} from "./mapping.ts";
import { PRE_EVENT_POLL_STORAGE_STREAM } from "./preEventPoller.ts";
import {
  DEFAULT_SSE_BUFFER_SIZE,
  DEFAULT_SSE_STORAGE_STREAM,
} from "./push.ts";
import {
  DEFAULT_INTERVAL_QUOTA_STORAGE_STREAM,
  DEFAULT_QUOTA_STORAGE_STREAM,
  DEFAULT_SPEND_STORAGE_STREAM,
  WINDOW_MS,
} from "./quota.ts";
import { PARSER_ERROR_STORAGE_STREAM } from "./review.ts";
import {
  DEFAULT_ROUND_JOB_DEAD_LETTER_STREAM,
  DEFAULT_ROUND_JOBS_STORAGE_STREAM,
} from "./roundJobs.ts";
import {
  ROUND_STATS_STORAGE_STREAM,
  UNIFIED_ROUNDS_STORAGE_STREAM,
} from "./roundStats.ts";
import { SHERDOG_EVENT_DISCOVERY_STORAGE_STREAM } from "./sherdogEventDiscovery.ts";
import {
  SHERDOG_BASELINES_STORAGE_STREAM,
  SHERDOG_OBSERVATIONS_STORAGE_STREAM,
} from "./sherdogJobs.ts";
import { SHERDOG_SCORER_PROFILES_STORAGE_STREAM } from "./sherdogScorerProfiles.ts";
import type { Storage } from "./storage.ts";
import {
  MARKET_FRESHNESS_STORAGE_STREAM,
  MARKET_SNAPSHOTS_STORAGE_STREAM,
  MARKET_TICKS_STORAGE_STREAM,
  MAX_RESTORED_TICKS,
} from "./tickStore.ts";
import {
  UPCOMING_DECISION_MAPPING_STREAM,
  UPCOMING_MAPPING_STREAM,
} from "./upcomingOddsStore.ts";

export type RetentionPolicy =
  | { kind: "last-per-key"; key: (record: unknown) => string | undefined }
  | { kind: "newest"; limit: number }
  | {
      kind: "newer-than";
      windowMs: number;
      at: (record: unknown) => number | undefined;
    }
  | { kind: "unbounded"; reason: string };

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null
    ? value as UnknownRecord
    : undefined;
}

function atPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const part of path) {
    current = record(current)?.[part];
  }
  return current;
}

function stringAt(value: unknown, ...path: string[]): string | undefined {
  const candidate = atPath(value, path);
  return typeof candidate === "string" ? candidate : undefined;
}

function numberAt(value: unknown, ...path: string[]): number | undefined {
  const candidate = atPath(value, path);
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function joinedKey(
  ...parts: Array<string | number | undefined>
): string | undefined {
  return parts.some((part) => part === undefined)
    ? undefined
    : JSON.stringify(parts);
}

// QuotaLedger only reads one day, but compaction can overlap a restore. Three
// days keeps a wide safety margin while still making the logs self-bounding.
const QUOTA_RETENTION_WINDOW_MS = WINDOW_MS.day * 3;

/**
 * One reviewable retention decision for every JSONL stream. Key extractors
 * mirror the corresponding restore reader's identity. Rows without that
 * identity return undefined and Storage.compact preserves them verbatim.
 */
export const STREAM_RETENTION: Record<string, RetentionPolicy> = {
  [COLLECTOR_STATE_STREAM]: {
    kind: "last-per-key",
    key: (value) => stringAt(value, "state", "event", "id"),
  },
  [DEFAULT_LIFECYCLE_STORAGE_STREAM]: {
    kind: "last-per-key",
    key: (value) => stringAt(value, "state", "boutId"),
  },
  [DEFAULT_SSE_STORAGE_STREAM]: {
    kind: "newest",
    limit: DEFAULT_SSE_BUFFER_SIZE,
  },
  [MARKET_TICKS_STORAGE_STREAM]: {
    kind: "newest",
    limit: MAX_RESTORED_TICKS * 2,
  },
  [MARKET_SNAPSHOTS_STORAGE_STREAM]: {
    kind: "last-per-key",
    key: (value) => joinedKey(
      stringAt(value, "snapshot", "boutId"),
      numberAt(value, "snapshot", "round"),
      stringAt(value, "snapshot", "source"),
      stringAt(value, "snapshot", "boundaryType"),
    ),
  },
  [UNIFIED_ROUNDS_STORAGE_STREAM]: {
    kind: "last-per-key",
    key: (value) => joinedKey(
      stringAt(value, "record", "boutId"),
      numberAt(value, "record", "round"),
    ),
  },
  [ROUND_STATS_STORAGE_STREAM]: {
    kind: "last-per-key",
    // Revision history is public behavior. Deduplicate only repeated writes
    // of the same logical revision, retaining its final confirmed form.
    key: (value) => joinedKey(
      stringAt(value, "record", "boutId"),
      numberAt(value, "record", "round"),
      numberAt(value, "record", "revision"),
      stringAt(value, "record", "payloadHash"),
    ),
  },
  [SOURCE_HEALTH_STORAGE_STREAM]: {
    kind: "last-per-key",
    key: (value) => stringAt(value, "health", "source"),
  },
  [SOURCE_METRICS_STORAGE_STREAM]: {
    kind: "last-per-key",
    key: (value) => stringAt(value, "snapshot", "source"),
  },
  [HEALTH_ALERT_STORAGE_STREAM]: {
    // Ten thousand transitions preserve ample operational context without
    // allowing a noisy source to grow the dashboard bootstrap forever.
    kind: "newest",
    limit: 10_000,
  },
  [MARKET_FRESHNESS_STORAGE_STREAM]: {
    // Freshness transitions are compact display history; 25k spans many
    // events while bounding the higher-volume queue.
    kind: "newest",
    limit: 25_000,
  },
  [BOUT_MAPPING_STREAM]: {
    kind: "last-per-key",
    key: (value) => stringAt(value, "mapping", "internalBoutId"),
  },
  [BOUT_MAPPING_OVERRIDE_STREAM]: {
    kind: "last-per-key",
    key: (value) => joinedKey(
      stringAt(value, "override", "externalRef", "source"),
      stringAt(value, "override", "externalRef", "id"),
    ),
  },
  [AMBIGUOUS_MAPPING_STREAM]: {
    // Manual triage cannot use an unlimited backlog; 5k leaves a generous
    // review window without turning stale ambiguities into permanent data.
    kind: "newest",
    limit: 5_000,
  },
  [UPCOMING_MAPPING_STREAM]: {
    kind: "last-per-key",
    // The import reader intentionally accumulates distinct historical
    // provider ids for a bout; only repeated snapshots of one attachment are
    // superseded by a later write.
    key: (value) => joinedKey(
      stringAt(value, "espnEventId"),
      stringAt(value, "boutId"),
      stringAt(value, "provider"),
      stringAt(value, "externalId"),
    ),
  },
  [UPCOMING_DECISION_MAPPING_STREAM]: {
    kind: "last-per-key",
    key: (value) => joinedKey(
      stringAt(value, "espnEventId"),
      stringAt(value, "boutId"),
      stringAt(value, "provider"),
    ),
  },
  [PARSER_ERROR_STORAGE_STREAM]: {
    // Parser failures are diagnostic samples, not an audit log. Keep enough
    // for pattern diagnosis while bounding repeated upstream breakage.
    kind: "newest",
    limit: 5_000,
  },
  [DEFAULT_ROUND_JOBS_STORAGE_STREAM]: {
    kind: "last-per-key",
    key: (value) => stringAt(value, "key"),
  },
  [DEFAULT_ROUND_JOB_DEAD_LETTER_STREAM]: {
    // Two thousand failed jobs is already far beyond a practical manual
    // recovery queue and still leaves substantial incident history.
    kind: "newest",
    limit: 2_000,
  },
  [PRE_EVENT_POLL_STORAGE_STREAM]: {
    kind: "last-per-key",
    // Restore needs the latest success even when a newer failure follows it.
    key: (value) => {
      if (atPath(value, ["completedAt"]) !== undefined) return "success";
      if (atPath(value, ["failedAt"]) !== undefined) return "failure";
      return undefined;
    },
  },
  [DEFAULT_QUOTA_STORAGE_STREAM]: {
    kind: "newer-than",
    windowMs: QUOTA_RETENTION_WINDOW_MS,
    at: (value) => numberAt(value, "acquiredAt"),
  },
  [DEFAULT_INTERVAL_QUOTA_STORAGE_STREAM]: {
    kind: "newer-than",
    windowMs: QUOTA_RETENTION_WINDOW_MS,
    at: (value) => numberAt(value, "acquiredAt"),
  },
  [DEFAULT_SPEND_STORAGE_STREAM]: {
    kind: "unbounded",
    reason:
      "SpendLedger reconstructs all-time spending caps by summing every paid acquisition; dropping a record could under-count spend and overspend real money. It grows by one small record per paid acquisition.",
  },
  [EVENT_ROTATION_STORAGE_STREAM]: { kind: "newest", limit: 1 },
  [SHERDOG_BASELINES_STORAGE_STREAM]: {
    kind: "last-per-key",
    key: (value) => joinedKey(
      stringAt(value, "boutId"),
      numberAt(value, "round"),
    ),
  },
  [SHERDOG_EVENT_DISCOVERY_STORAGE_STREAM]: {
    kind: "last-per-key",
    key: (value) => stringAt(value, "value", "eventId"),
  },
  [SHERDOG_OBSERVATIONS_STORAGE_STREAM]: {
    kind: "last-per-key",
    // Like round-stats, readers expose distinct content revisions while the
    // latest duplicate of one revision carries its final timestamps.
    key: (value) => joinedKey(
      stringAt(value, "value", "observation", "boutId"),
      numberAt(value, "value", "observation", "round"),
      numberAt(value, "value", "revision"),
      stringAt(value, "value", "observation", "payloadHash"),
    ),
  },
  [SHERDOG_SCORER_PROFILES_STORAGE_STREAM]: {
    kind: "last-per-key",
    key: (value) => stringAt(value, "value", "normalizedName"),
  },
  [LAB_TIMELINE_STREAM]: {
    // The lab UI retains 5k entries in memory; twice that is a generous local
    // investigation window without preserving fight-night captures forever.
    kind: "newest",
    limit: 10_000,
  },
};

export const DEFAULT_STREAM_JANITOR_INTERVAL_MS = 15 * 60 * 1_000;
export const DEFAULT_STREAM_SIZE_WARNING_BYTES = 64 * 1024 * 1024;
export const STREAM_SIZE_WARNING_BYTES_ENV = "STREAM_SIZE_WARNING_BYTES";

export interface StreamJanitorTimer {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface StreamJanitorLogger {
  log(message: string): void;
  warn(message: string, error?: unknown): void;
}

export interface StreamJanitorOptions {
  storage: Storage;
  intervalMs?: number;
  timer?: StreamJanitorTimer;
  logger?: StreamJanitorLogger;
  sizeWarningBytes?: number;
}

const DEFAULT_JANITOR_TIMER: StreamJanitorTimer = {
  setInterval: (callback, intervalMs) =>
    globalThis.setInterval(callback, intervalMs),
  clearInterval: (handle) =>
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Time-driven safety net for every bounded JSONL stream. */
export class StreamJanitor {
  private readonly storage: Storage;

  private readonly intervalMs: number;

  private readonly timer: StreamJanitorTimer;

  private readonly logger: StreamJanitorLogger;

  private readonly sizeWarningBytes: number;

  private intervalHandle: unknown;

  private sweepQueue: Promise<void> = Promise.resolve();

  private started = false;

  constructor(options: StreamJanitorOptions) {
    const intervalMs =
      options.intervalMs ?? DEFAULT_STREAM_JANITOR_INTERVAL_MS;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new TypeError("stream janitor intervalMs must be positive");
    }
    this.storage = options.storage;
    this.intervalMs = intervalMs;
    this.timer = options.timer ?? DEFAULT_JANITOR_TIMER;
    this.logger = options.logger ?? console;
    const sizeWarningBytes = options.sizeWarningBytes ?? Number(
      process.env[STREAM_SIZE_WARNING_BYTES_ENV] ??
        DEFAULT_STREAM_SIZE_WARNING_BYTES,
    );
    if (!Number.isSafeInteger(sizeWarningBytes) || sizeWarningBytes <= 0) {
      throw new TypeError(
        "stream janitor sizeWarningBytes must be a positive safe integer",
      );
    }
    this.sizeWarningBytes = sizeWarningBytes;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.sweep();
    this.intervalHandle = this.timer.setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    (this.intervalHandle as { unref?: () => void }).unref?.();
  }

  sweep(): Promise<void> {
    const operation = this.sweepQueue.then(() => this.sweepOnce());
    this.sweepQueue = operation.catch(() => undefined);
    return operation;
  }

  async stop(): Promise<void> {
    if (this.intervalHandle !== undefined) {
      this.timer.clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    await this.sweepQueue;
  }

  private async sweepOnce(): Promise<void> {
    await this.warnOversizedStreams();
    for (const [stream, policy] of Object.entries(STREAM_RETENTION)) {
      if (policy.kind === "unbounded") continue;
      try {
        const { before, after } = await this.storage.compact(stream, policy);
        if (after < before) {
          this.logger.log(
            `Compacted ${stream}: ${before} -> ${after} records`,
          );
        }
      } catch (error) {
        // One corrupt or unwritable stream must not disable retention for all
        // the independent streams that follow it in the registry.
        this.logger.warn(`Unable to compact ${stream}`, error);
      }
    }
  }

  private async warnOversizedStreams(): Promise<void> {
    if (this.storage.streamSize === undefined) return;

    let streams: string[];
    try {
      streams = await this.storage.listStreams();
    } catch (error) {
      this.logger.warn("Unable to list streams for size inspection", error);
      return;
    }

    for (const stream of streams) {
      try {
        const size = await this.storage.streamSize(stream);
        if (size !== undefined && size > this.sizeWarningBytes) {
          this.logger.warn(
            `Stream ${stream} is ${size} bytes, exceeding the ${this.sizeWarningBytes} bytes warning budget`,
          );
        }
      } catch (error) {
        // Sizing is only an early warning. A race with rotation or an
        // unreadable file must never prevent compaction of independent logs.
        this.logger.warn(`Unable to inspect size of ${stream}`, error);
      }
    }
  }
}
