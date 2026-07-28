import type { Storage } from "./storage.ts";

export const SOURCE_HEALTH_STORAGE_STREAM = "source-health";
export const SOURCE_METRICS_STORAGE_STREAM = "source-metrics";
export const HEALTH_ALERT_STORAGE_STREAM = "health-alerts";
export const DEFAULT_METRICS_PERSIST_INTERVAL_MS = 30_000;

export type SourceHealthStatus =
  | "healthy"
  | "stale"
  | "degraded"
  | "unavailable";

export interface SourceHealth {
  source: string;
  status: SourceHealthStatus;
  fresh: boolean;
  checkedAt: string;
  sourceUpdatedAt?: string;
  message?: string;
}

export const METRIC_NAMES = [
  "source_requests_total",
  "source_errors_total",
  "source_rate_limit_remaining",
  "source_response_latency_ms",
  "source_payload_age_seconds",
  "websocket_reconnects_total",
  "round_event_detection_delay_ms",
  "round_stats_availability_delay_ms",
  "sherdog_publication_delay_ms",
  "mapping_confidence",
  "parser_failures_total",
  "provisional_records_total",
  "revisions_total",
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];
export type CounterMetricName =
  | "source_requests_total"
  | "source_errors_total"
  | "websocket_reconnects_total"
  | "parser_failures_total"
  | "provisional_records_total"
  | "revisions_total";
export type GaugeMetricName = Exclude<MetricName, CounterMetricName>;

export interface MetricTimestamps {
  sourceTimestamp?: string;
  localTimestamp?: string;
}

/**
 * Small synchronous injection seam used by collectors and source adapters.
 * Persistence and SSE delivery are serialized by the registry itself.
 */
export interface Metrics {
  increment(
    metric: CounterMetricName,
    source: string,
    amount?: number,
    timestamps?: MetricTimestamps,
  ): void;
  set(
    metric: GaugeMetricName,
    source: string,
    value: number,
    timestamps?: MetricTimestamps,
  ): void;
  recordPayload(
    source: string,
    sourceTimestamp: string | undefined,
    localTimestamp: string,
  ): void;
}

export const NOOP_METRICS: Metrics = {
  increment() {},
  set() {},
  recordPayload() {},
};

export interface SourceMetricSnapshot {
  source: string;
  values: Partial<Record<MetricName, number>>;
  sourceTimestamp?: string;
  localTimestamp: string;
}

export interface MetricsSnapshot {
  generatedAt: string;
  sources: Readonly<Record<string, SourceMetricSnapshot>>;
}

export type HealthAlertType = "quota" | "freshness";

export interface HealthAlert {
  id: string;
  source: string;
  type: HealthAlertType;
  active: boolean;
  alert: boolean;
  occurredAt: string;
  metric: MetricName;
  value: number;
  threshold: number;
  sourceTimestamp?: string;
  localTimestamp: string;
  message: string;
}

export interface HealthEvent extends SourceHealth {
  metrics: SourceMetricSnapshot;
  alert?: boolean;
  alertType?: HealthAlertType;
}

export interface SourceHealthRegistryOptions {
  storage: Storage;
  now?: () => string;
  persistIntervalMs?: number;
  staleAfterMs?: Readonly<Record<string, number>>;
  quotaThresholds?: Readonly<Record<string, number>>;
  publish?: (event: HealthEvent) => Promise<unknown>;
}

interface PersistedSourceHealth {
  version: 1;
  health: SourceHealth;
}

interface PersistedSourceMetrics {
  version: 1;
  snapshot: SourceMetricSnapshot;
}

interface PersistedHealthAlert {
  version: 1;
  alert: HealthAlert;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSourceHealth(value: unknown): value is SourceHealth {
  return (
    isRecord(value) &&
    typeof value.source === "string" &&
    value.source.length > 0 &&
    (value.status === "healthy" ||
      value.status === "stale" ||
      value.status === "degraded" ||
      value.status === "unavailable") &&
    typeof value.fresh === "boolean" &&
    validTimestamp(value.checkedAt) &&
    (value.sourceUpdatedAt === undefined ||
      validTimestamp(value.sourceUpdatedAt)) &&
    (value.message === undefined || typeof value.message === "string")
  );
}

function isPersistedSourceHealth(
  value: unknown,
): value is PersistedSourceHealth {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isSourceHealth(value.health)
  );
}

function isMetricName(value: string): value is MetricName {
  return (METRIC_NAMES as readonly string[]).includes(value);
}

function isSourceMetricSnapshot(
  value: unknown,
): value is SourceMetricSnapshot {
  if (
    !isRecord(value) ||
    typeof value.source !== "string" ||
    !isRecord(value.values) ||
    !validTimestamp(value.localTimestamp) ||
    (value.sourceTimestamp !== undefined &&
      !validTimestamp(value.sourceTimestamp))
  ) {
    return false;
  }
  return Object.entries(value.values).every(
    ([name, metric]) =>
      isMetricName(name) &&
      typeof metric === "number" &&
      Number.isFinite(metric),
  );
}

function isPersistedSourceMetrics(
  value: unknown,
): value is PersistedSourceMetrics {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isSourceMetricSnapshot(value.snapshot)
  );
}

function isHealthAlert(value: unknown): value is HealthAlert {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string" &&
    (value.type === "quota" || value.type === "freshness") &&
    typeof value.active === "boolean" &&
    value.alert === value.active &&
    validTimestamp(value.occurredAt) &&
    typeof value.metric === "string" &&
    isMetricName(value.metric) &&
    typeof value.value === "number" &&
    Number.isFinite(value.value) &&
    typeof value.threshold === "number" &&
    Number.isFinite(value.threshold) &&
    (value.sourceTimestamp === undefined ||
      validTimestamp(value.sourceTimestamp)) &&
    validTimestamp(value.localTimestamp) &&
    typeof value.message === "string"
  );
}

function isPersistedHealthAlert(
  value: unknown,
): value is PersistedHealthAlert {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isHealthAlert(value.alert)
  );
}

function copyHealth(health: SourceHealth): SourceHealth {
  return {
    ...health,
    ...(health.sourceUpdatedAt === undefined
      ? {}
      : { sourceUpdatedAt: health.sourceUpdatedAt }),
  };
}

function copyMetric(snapshot: SourceMetricSnapshot): SourceMetricSnapshot {
  return {
    source: snapshot.source,
    values: { ...snapshot.values },
    ...(snapshot.sourceTimestamp === undefined
      ? {}
      : { sourceTimestamp: snapshot.sourceTimestamp }),
    localTimestamp: snapshot.localTimestamp,
  };
}

function healthChanged(
  previous: SourceHealth | undefined,
  next: SourceHealth,
): boolean {
  return (
    previous === undefined ||
    previous.status !== next.status ||
    previous.fresh !== next.fresh ||
    previous.sourceUpdatedAt !== next.sourceUpdatedAt ||
    previous.message !== next.message
  );
}

function validateSourceAndValue(source: string, value?: number): void {
  if (source.trim().length === 0) {
    throw new TypeError("metric source must not be empty");
  }
  if (value !== undefined && !Number.isFinite(value)) {
    throw new TypeError("metric values must be finite");
  }
}

function timestampOrNow(value: string | undefined, now: () => string): string {
  const timestamp = value ?? now();
  if (!validTimestamp(timestamp)) {
    throw new TypeError("metric localTimestamp must be valid ISO-8601");
  }
  return timestamp;
}

export class SourceHealthRegistry implements Metrics {
  private readonly storage: Storage;

  private readonly now: () => string;

  private readonly staleAfterMs: Readonly<Record<string, number>>;

  private readonly quotaThresholds: Readonly<Record<string, number>>;

  private readonly health = new Map<string, SourceHealth>();

  private readonly metrics = new Map<string, SourceMetricSnapshot>();

  private readonly alerts: HealthAlert[] = [];

  private readonly activeAlerts = new Set<string>();

  private publish: ((event: HealthEvent) => Promise<unknown>) | undefined;

  private operationQueue: Promise<void> = Promise.resolve();

  private dirty = false;

  private closed = false;

  private readonly persistenceTimer: ReturnType<typeof setInterval>;

  private constructor(options: SourceHealthRegistryOptions) {
    const persistIntervalMs =
      options.persistIntervalMs ?? DEFAULT_METRICS_PERSIST_INTERVAL_MS;
    if (!Number.isFinite(persistIntervalMs) || persistIntervalMs < 1) {
      throw new TypeError("persistIntervalMs must be a positive number");
    }
    for (const [source, threshold] of Object.entries(
      options.staleAfterMs ?? {},
    )) {
      validateSourceAndValue(source, threshold);
      if (threshold < 0) {
        throw new TypeError("freshness thresholds must be non-negative");
      }
    }
    for (const [source, threshold] of Object.entries(
      options.quotaThresholds ?? {},
    )) {
      validateSourceAndValue(source, threshold);
      if (threshold < 0) {
        throw new TypeError("quota thresholds must be non-negative");
      }
    }

    this.storage = options.storage;
    this.now = options.now ?? (() => new Date().toISOString());
    this.staleAfterMs = { ...(options.staleAfterMs ?? {}) };
    this.quotaThresholds = { ...(options.quotaThresholds ?? {}) };
    this.publish = options.publish;
    this.persistenceTimer = setInterval(() => {
      void this.flush().catch(() => undefined);
    }, persistIntervalMs);
    (
      this.persistenceTimer as unknown as { unref?: () => void }
    ).unref?.();
  }

  static async create(
    options: SourceHealthRegistryOptions,
  ): Promise<SourceHealthRegistry> {
    const registry = new SourceHealthRegistry(options);
    await registry.restore();
    return registry;
  }

  setPublisher(
    publish: (event: HealthEvent) => Promise<unknown>,
  ): void {
    this.publish = publish;
  }

  increment(
    metric: CounterMetricName,
    source: string,
    amount = 1,
    timestamps: MetricTimestamps = {},
  ): void {
    validateSourceAndValue(source, amount);
    if (amount < 0) {
      throw new TypeError("counter increments must be non-negative");
    }
    const snapshot = this.metricFor(source, timestamps);
    snapshot.values[metric] = (snapshot.values[metric] ?? 0) + amount;
    this.dirty = true;
  }

  set(
    metric: GaugeMetricName,
    source: string,
    value: number,
    timestamps: MetricTimestamps = {},
  ): void {
    validateSourceAndValue(source, value);
    const snapshot = this.metricFor(source, timestamps);
    snapshot.values[metric] = value;
    this.dirty = true;

    if (metric === "source_rate_limit_remaining") {
      const threshold = this.quotaThresholds[source];
      if (threshold !== undefined) {
        this.enqueue(() =>
          this.evaluateAlert(
            source,
            "quota",
            metric,
            value,
            threshold,
            value <= threshold,
            snapshot,
          ),
        );
      }
    }
  }

  recordPayload(
    source: string,
    sourceTimestamp: string | undefined,
    localTimestamp: string,
  ): void {
    validateSourceAndValue(source);
    const local = timestampOrNow(localTimestamp, this.now);
    if (sourceTimestamp !== undefined && !validTimestamp(sourceTimestamp)) {
      throw new TypeError("sourceTimestamp must be valid ISO-8601");
    }
    const sourceTime = sourceTimestamp ?? local;
    const ageSeconds = Math.max(
      0,
      (Date.parse(local) - Date.parse(sourceTime)) / 1_000,
    );
    const snapshot = this.metricFor(source, {
      sourceTimestamp: sourceTime,
      localTimestamp: local,
    });
    snapshot.values.source_payload_age_seconds = ageSeconds;
    this.dirty = true;

    const thresholdMs = this.staleAfterMs[source];
    if (thresholdMs !== undefined) {
      this.enqueue(() =>
        this.evaluateAlert(
          source,
          "freshness",
          "source_payload_age_seconds",
          ageSeconds,
          thresholdMs / 1_000,
          ageSeconds * 1_000 > thresholdMs,
          snapshot,
        ),
      );
    }
  }

  async publishHealth(nextHealth: SourceHealth): Promise<boolean> {
    if (!isSourceHealth(nextHealth)) {
      throw new TypeError("health requires a source and valid timestamps");
    }
    return this.enqueue(async () => {
      const next = copyHealth(nextHealth);
      const previous = this.health.get(next.source);
      this.health.set(next.source, next);
      if (!healthChanged(previous, next)) return false;
      await this.storage.append(SOURCE_HEALTH_STORAGE_STREAM, {
        version: 1,
        health: next,
      } satisfies PersistedSourceHealth);
      await this.publishEvent(next);
      return true;
    });
  }

  getHealth(): Readonly<Record<string, SourceHealth>> {
    return Object.fromEntries(
      [...this.health.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([source, health]) => [source, copyHealth(health)]),
    );
  }

  getMetrics(): MetricsSnapshot {
    return {
      generatedAt: this.now(),
      sources: Object.fromEntries(
        [...this.metrics.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([source, snapshot]) => [source, copyMetric(snapshot)]),
      ),
    };
  }

  getSourceMetrics(source: string): SourceMetricSnapshot {
    const existing = this.metrics.get(source);
    return existing === undefined
      ? {
          source,
          values: {},
          localTimestamp: this.now(),
        }
      : copyMetric(existing);
  }

  getAlerts(): readonly HealthAlert[] {
    return this.alerts.map((alert) => ({ ...alert }));
  }

  async flush(): Promise<void> {
    await this.operationQueue;
    if (!this.dirty) return;
    const records: PersistedSourceMetrics[] = [...this.metrics.values()]
      .sort((left, right) => left.source.localeCompare(right.source))
      .map((snapshot) => ({
        version: 1,
        snapshot: copyMetric(snapshot),
      }));
    await this.storage.replace(SOURCE_METRICS_STORAGE_STREAM, records);
    this.dirty = false;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.persistenceTimer);
    await this.flush();
  }

  private metricFor(
    source: string,
    timestamps: MetricTimestamps,
  ): SourceMetricSnapshot {
    const localTimestamp = timestampOrNow(
      timestamps.localTimestamp,
      this.now,
    );
    if (
      timestamps.sourceTimestamp !== undefined &&
      !validTimestamp(timestamps.sourceTimestamp)
    ) {
      throw new TypeError("sourceTimestamp must be valid ISO-8601");
    }
    const existing = this.metrics.get(source);
    const snapshot: SourceMetricSnapshot =
      existing ??
      {
        source,
        values: {},
        localTimestamp,
      };
    snapshot.localTimestamp = localTimestamp;
    if (timestamps.sourceTimestamp !== undefined) {
      snapshot.sourceTimestamp = timestamps.sourceTimestamp;
    }
    this.metrics.set(source, snapshot);
    return snapshot;
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

  private async restore(): Promise<void> {
    const [healthRecords, metricRecords, alertRecords] = await Promise.all([
      this.storage.read<unknown>(SOURCE_HEALTH_STORAGE_STREAM),
      this.storage.read<unknown>(SOURCE_METRICS_STORAGE_STREAM),
      this.storage.read<unknown>(HEALTH_ALERT_STORAGE_STREAM),
    ]);
    for (const record of healthRecords) {
      if (isPersistedSourceHealth(record)) {
        this.health.set(record.health.source, copyHealth(record.health));
      }
    }
    for (const record of metricRecords) {
      if (isPersistedSourceMetrics(record)) {
        this.metrics.set(
          record.snapshot.source,
          copyMetric(record.snapshot),
        );
      }
    }
    for (const record of alertRecords) {
      if (!isPersistedHealthAlert(record)) continue;
      this.alerts.push({ ...record.alert });
      const key = `${record.alert.source}:${record.alert.type}`;
      if (record.alert.active) this.activeAlerts.add(key);
      else this.activeAlerts.delete(key);
    }
  }

  private async evaluateAlert(
    source: string,
    type: HealthAlertType,
    metric: MetricName,
    value: number,
    threshold: number,
    active: boolean,
    snapshot: SourceMetricSnapshot,
  ): Promise<void> {
    const key = `${source}:${type}`;
    if (this.activeAlerts.has(key) === active) return;
    if (active) this.activeAlerts.add(key);
    else this.activeAlerts.delete(key);

    const localTimestamp = snapshot.localTimestamp;
    const message =
      type === "quota"
        ? active
          ? `${source} entered quota conservation at ${value} remaining`
          : `${source} left quota conservation with ${value} remaining`
        : active
          ? `${source} payload age ${value}s exceeded ${threshold}s`
          : `${source} payload freshness recovered at ${value}s`;
    const alert: HealthAlert = {
      id: `${source}:${type}:${localTimestamp}:${active ? "active" : "clear"}`,
      source,
      type,
      active,
      alert: active,
      occurredAt: localTimestamp,
      metric,
      value,
      threshold,
      ...(snapshot.sourceTimestamp === undefined
        ? {}
        : { sourceTimestamp: snapshot.sourceTimestamp }),
      localTimestamp,
      message,
    };
    this.alerts.push(alert);
    await this.storage.append(HEALTH_ALERT_STORAGE_STREAM, {
      version: 1,
      alert,
    } satisfies PersistedHealthAlert);

    const existing = this.health.get(source);
    const health: SourceHealth = active
      ? {
          source,
          status: type === "freshness" ? "stale" : "degraded",
          fresh: type !== "freshness" && (existing?.fresh ?? true),
          checkedAt: localTimestamp,
          ...(snapshot.sourceTimestamp === undefined
            ? {}
            : { sourceUpdatedAt: snapshot.sourceTimestamp }),
          message,
        }
      : {
          source,
          status: "healthy",
          fresh: true,
          checkedAt: localTimestamp,
          ...(snapshot.sourceTimestamp === undefined
            ? {}
            : { sourceUpdatedAt: snapshot.sourceTimestamp }),
          message,
        };
    this.health.set(source, health);
    await this.storage.append(SOURCE_HEALTH_STORAGE_STREAM, {
      version: 1,
      health,
    } satisfies PersistedSourceHealth);
    await this.publishEvent(health, { alert: active, alertType: type });
  }

  private async publishEvent(
    health: SourceHealth,
    alert?: Pick<HealthEvent, "alert" | "alertType">,
  ): Promise<void> {
    await this.publish?.({
      ...copyHealth(health),
      metrics: this.getSourceMetrics(health.source),
      ...(alert?.alert === undefined ? {} : { alert: alert.alert }),
      ...(alert?.alertType === undefined
        ? {}
        : { alertType: alert.alertType }),
    });
  }
}
