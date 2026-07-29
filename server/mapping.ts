import type {
  ExternalRef,
  SourceId,
  UfcEvent,
  WeightClass,
} from "../src/schema.ts";
import type { Storage } from "./storage.ts";
import { NOOP_METRICS, type Metrics } from "./health.ts";
import {
  matchFighterPair,
  normalizeFighterName,
  roundConfidence,
} from "../src/lib/boutMatch.ts";

export { normalizeFighterName };

export const BOUT_MAPPING_STREAM = "bout-mappings";
export const BOUT_MAPPING_OVERRIDE_STREAM = "bout-mapping-overrides";
export const AMBIGUOUS_MAPPING_STREAM = "ambiguous-mappings";
export const DEFAULT_MAPPING_CONFIDENCE_THRESHOLD = 0.85;

export interface BoutMapping {
  internalBoutId: string;
  externalRefs: ExternalRef[];
  redFighter: string;
  blueFighter: string;
  weightClass: WeightClass;
  scheduledRounds: number;
  mappingConfidence: number;
  manuallyVerified: boolean;
}

export interface ManualBoutMappingOverride {
  internalBoutId: string;
  externalRef: ExternalRef;
}

export interface DiscoveredBoutIdentity {
  externalRef: ExternalRef;
  redFighter: string;
  blueFighter: string;
}

export interface FuzzyBoutMatch {
  confidence: number;
  cornersReversed: boolean;
}

export interface AmbiguousMappingCandidate {
  internalBoutId: string;
  confidence: number;
}

export interface AmbiguousMappingRecord {
  discovered: DiscoveredBoutIdentity;
  candidates: AmbiguousMappingCandidate[];
  confidenceThreshold: number;
}

export interface CreateBoutMappingRegistryOptions {
  event: UfcEvent;
  storage: Storage;
  manualOverrides?: readonly ManualBoutMappingOverride[];
  confidenceThreshold?: number;
  metrics?: Metrics;
}

interface PersistedBoutMapping {
  version: 1;
  mapping: BoutMapping;
}

interface PersistedManualOverride {
  version: 1;
  override: ManualBoutMappingOverride;
}

interface PersistedAmbiguousMapping {
  version: 1;
  record: AmbiguousMappingRecord;
}

const SOURCE_IDS: ReadonlySet<string> = new Set([
  "espn",
  "sherdog",
  "cito",
  "kalshi",
  "polymarket",
  "odds-api-io",
  "odds-api",
  "x-embed",
  "fixture",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSourceId(value: unknown): value is SourceId {
  return typeof value === "string" && SOURCE_IDS.has(value);
}

function isExternalRef(value: unknown): value is ExternalRef {
  return (
    isRecord(value) &&
    isSourceId(value.source) &&
    typeof value.id === "string" &&
    value.id.length > 0
  );
}

function isBoutMapping(value: unknown): value is BoutMapping {
  return (
    isRecord(value) &&
    typeof value.internalBoutId === "string" &&
    Array.isArray(value.externalRefs) &&
    value.externalRefs.every(isExternalRef) &&
    typeof value.redFighter === "string" &&
    typeof value.blueFighter === "string" &&
    typeof value.weightClass === "string" &&
    typeof value.scheduledRounds === "number" &&
    Number.isInteger(value.scheduledRounds) &&
    typeof value.mappingConfidence === "number" &&
    Number.isFinite(value.mappingConfidence) &&
    value.mappingConfidence >= 0 &&
    value.mappingConfidence <= 1 &&
    typeof value.manuallyVerified === "boolean"
  );
}

function isManualOverride(
  value: unknown,
): value is ManualBoutMappingOverride {
  return (
    isRecord(value) &&
    typeof value.internalBoutId === "string" &&
    isExternalRef(value.externalRef)
  );
}

function isPersistedBoutMapping(
  value: unknown,
): value is PersistedBoutMapping {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isBoutMapping(value.mapping)
  );
}

function isPersistedManualOverride(
  value: unknown,
): value is PersistedManualOverride {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isManualOverride(value.override)
  );
}

function externalRefKey(ref: ExternalRef): string {
  return `${ref.source}\u0000${ref.id}`;
}

function cloneExternalRef(ref: ExternalRef): ExternalRef {
  return { source: ref.source, id: ref.id };
}

function cloneMapping(mapping: BoutMapping): BoutMapping {
  return {
    ...mapping,
    externalRefs: mapping.externalRefs.map(cloneExternalRef),
  };
}

function cloneManualOverride(
  override: ManualBoutMappingOverride,
): ManualBoutMappingOverride {
  return {
    internalBoutId: override.internalBoutId,
    externalRef: cloneExternalRef(override.externalRef),
  };
}

/**
 * Scores two fighter pairs without assuming that a source preserves red and
 * blue corner order. Delegates to the shared matcher in
 * `src/lib/boutMatch.ts` so this registry, the upcoming-odds sync, and any
 * future provider all agree on what "the same fight" means. Automatic name
 * matches are capped below manual/fixture mappings so callers can distinguish
 * discovery from verified identity.
 */
export function fuzzyMatchBoutFighters(
  known: Pick<BoutMapping, "redFighter" | "blueFighter">,
  discovered: Pick<
    DiscoveredBoutIdentity,
    "redFighter" | "blueFighter"
  >,
): FuzzyBoutMatch {
  const pair = matchFighterPair(known, discovered);
  return {
    confidence: roundConfidence(pair.confidence * 0.95),
    cornersReversed: pair.cornersReversed,
  };
}

function validateThreshold(threshold: number): void {
  if (
    !Number.isFinite(threshold) ||
    threshold <= 0 ||
    threshold > 1
  ) {
    throw new TypeError(
      "confidenceThreshold must be greater than 0 and at most 1",
    );
  }
}

function validateDiscoveredBout(discovered: DiscoveredBoutIdentity): void {
  if (
    !isExternalRef(discovered.externalRef) ||
    discovered.redFighter.trim().length === 0 ||
    discovered.blueFighter.trim().length === 0
  ) {
    throw new TypeError(
      "Discovered bouts require an externalRef and both fighter names",
    );
  }
}

export class BoutMappingRegistry {
  private readonly storage: Storage;

  private readonly confidenceThreshold: number;

  private readonly metrics: Metrics;

  private readonly mappings = new Map<string, BoutMapping>();

  private readonly externalToInternal = new Map<string, string>();

  private readonly latestPersistedMappings = new Map<string, string>();

  private readonly latestPersistedOverrides = new Map<string, string>();

  private constructor(
    storage: Storage,
    confidenceThreshold: number,
    metrics: Metrics,
  ) {
    this.storage = storage;
    this.confidenceThreshold = confidenceThreshold;
    this.metrics = metrics;
  }

  static async create(
    options: CreateBoutMappingRegistryOptions,
  ): Promise<BoutMappingRegistry> {
    const threshold =
      options.confidenceThreshold ??
      DEFAULT_MAPPING_CONFIDENCE_THRESHOLD;
    validateThreshold(threshold);

    const registry = new BoutMappingRegistry(
      options.storage,
      threshold,
      options.metrics ?? NOOP_METRICS,
    );
    await registry.restore(options.event);
    for (const override of options.manualOverrides ?? []) {
      await registry.setManualOverride(override);
    }
    await registry.persistChangedMappings();
    return registry;
  }

  getAll(): BoutMapping[] {
    return [...this.mappings.values()].map(cloneMapping);
  }

  findInternalBoutId(
    source: SourceId,
    externalId: string,
  ): string | undefined {
    return this.externalToInternal.get(
      externalRefKey({ source, id: externalId }),
    );
  }

  getMapping(internalBoutId: string): BoutMapping | undefined {
    const mapping = this.mappings.get(internalBoutId);
    return mapping === undefined ? undefined : cloneMapping(mapping);
  }

  getExternalRefs(internalBoutId: string): ExternalRef[] {
    return (
      this.mappings
        .get(internalBoutId)
        ?.externalRefs.map(cloneExternalRef) ?? []
    );
  }

  async matchDiscoveredBout(
    discovered: DiscoveredBoutIdentity,
  ): Promise<BoutMapping | undefined> {
    validateDiscoveredBout(discovered);
    const existingInternalId = this.findInternalBoutId(
      discovered.externalRef.source,
      discovered.externalRef.id,
    );
    if (existingInternalId !== undefined) {
      return this.getMapping(existingInternalId);
    }

    const candidates = [...this.mappings.values()]
      .map((mapping) => ({
        internalBoutId: mapping.internalBoutId,
        confidence: fuzzyMatchBoutFighters(mapping, discovered).confidence,
      }))
      .sort(
        (left, right) =>
          right.confidence - left.confidence ||
          left.internalBoutId.localeCompare(right.internalBoutId),
      );
    const best = candidates[0];
    this.metrics.set(
      "mapping_confidence",
      discovered.externalRef.source,
      best?.confidence ?? 0,
    );

    if (
      best === undefined ||
      best.confidence < this.confidenceThreshold
    ) {
      await this.storage.append(AMBIGUOUS_MAPPING_STREAM, {
        version: 1,
        record: {
          discovered: {
            ...discovered,
            externalRef: cloneExternalRef(discovered.externalRef),
          },
          candidates,
          confidenceThreshold: this.confidenceThreshold,
        },
      } satisfies PersistedAmbiguousMapping);
      return undefined;
    }

    const mapping = this.mappings.get(best.internalBoutId);
    if (mapping === undefined) return undefined;

    mapping.externalRefs.push(cloneExternalRef(discovered.externalRef));
    mapping.mappingConfidence = mapping.manuallyVerified
      ? 1
      : Math.min(mapping.mappingConfidence, best.confidence);
    this.rebuildExternalIndex();
    await this.persistMappingIfChanged(mapping);
    return cloneMapping(mapping);
  }

  async setManualOverride(
    override: ManualBoutMappingOverride,
  ): Promise<BoutMapping> {
    if (!isManualOverride(override)) {
      throw new TypeError(
        "Manual overrides require an internalBoutId and externalRef",
      );
    }
    const target = this.mappings.get(override.internalBoutId);
    if (target === undefined) {
      throw new TypeError(
        `Manual override references unknown bout "${override.internalBoutId}"`,
      );
    }

    const storedOverride = cloneManualOverride(override);
    const key = externalRefKey(storedOverride.externalRef);
    const serialized = JSON.stringify(storedOverride);
    if (this.latestPersistedOverrides.get(key) !== serialized) {
      await this.storage.append(BOUT_MAPPING_OVERRIDE_STREAM, {
        version: 1,
        override: storedOverride,
      } satisfies PersistedManualOverride);
      this.latestPersistedOverrides.set(key, serialized);
    }

    const previousInternalId = this.externalToInternal.get(key);
    if (
      previousInternalId !== undefined &&
      previousInternalId !== target.internalBoutId
    ) {
      const previous = this.mappings.get(previousInternalId);
      if (previous !== undefined) {
        previous.externalRefs = previous.externalRefs.filter(
          (ref) => externalRefKey(ref) !== key,
        );
        await this.persistMappingIfChanged(previous);
      }
    }

    if (
      !target.externalRefs.some((ref) => externalRefKey(ref) === key)
    ) {
      target.externalRefs.push(cloneExternalRef(storedOverride.externalRef));
    }
    target.mappingConfidence = 1;
    target.manuallyVerified = true;
    this.metrics.set(
      "mapping_confidence",
      storedOverride.externalRef.source,
      1,
    );
    this.rebuildExternalIndex();
    await this.persistMappingIfChanged(target);
    return cloneMapping(target);
  }

  private async restore(event: UfcEvent): Promise<void> {
    for (const bout of event.bouts) {
      this.mappings.set(bout.id, {
        internalBoutId: bout.id,
        externalRefs: bout.externalRefs.map(cloneExternalRef),
        redFighter: bout.fighters.red.name,
        blueFighter: bout.fighters.blue.name,
        weightClass: bout.weightClass,
        scheduledRounds: bout.scheduledRounds,
        mappingConfidence: 1,
        manuallyVerified: false,
      });
    }
    this.rebuildExternalIndex();

    const persistedRecords =
      await this.storage.read<unknown>(BOUT_MAPPING_STREAM);
    const restoredMappings = new Map<string, BoutMapping>();
    for (const record of persistedRecords) {
      if (isPersistedBoutMapping(record)) {
        restoredMappings.set(
          record.mapping.internalBoutId,
          cloneMapping(record.mapping),
        );
        this.latestPersistedMappings.set(
          record.mapping.internalBoutId,
          JSON.stringify(record.mapping),
        );
      }
    }

    for (const restored of restoredMappings.values()) {
      const current = this.mappings.get(restored.internalBoutId);
      if (current === undefined) continue;

      for (const ref of restored.externalRefs) {
        const key = externalRefKey(ref);
        const fixtureOwner = this.externalToInternal.get(key);
        if (
          fixtureOwner === undefined ||
          fixtureOwner === current.internalBoutId
        ) {
          if (
            !current.externalRefs.some(
              (existing) => externalRefKey(existing) === key,
            )
          ) {
            current.externalRefs.push(cloneExternalRef(ref));
          }
        }
      }
      current.mappingConfidence = Math.min(
        current.mappingConfidence,
        restored.mappingConfidence,
      );
      current.manuallyVerified = restored.manuallyVerified;
    }
    this.rebuildExternalIndex();

    const overrideRecords =
      await this.storage.read<unknown>(BOUT_MAPPING_OVERRIDE_STREAM);
    const restoredOverrides = new Map<
      string,
      ManualBoutMappingOverride
    >();
    for (const record of overrideRecords) {
      if (isPersistedManualOverride(record)) {
        const override = cloneManualOverride(record.override);
        const key = externalRefKey(override.externalRef);
        restoredOverrides.set(key, override);
        this.latestPersistedOverrides.set(
          key,
          JSON.stringify(override),
        );
      }
    }

    for (const override of restoredOverrides.values()) {
      if (this.mappings.has(override.internalBoutId)) {
        this.applyRestoredOverride(override);
      }
    }
  }

  private applyRestoredOverride(
    override: ManualBoutMappingOverride,
  ): void {
    const key = externalRefKey(override.externalRef);
    for (const mapping of this.mappings.values()) {
      if (mapping.internalBoutId !== override.internalBoutId) {
        mapping.externalRefs = mapping.externalRefs.filter(
          (ref) => externalRefKey(ref) !== key,
        );
      }
    }

    const target = this.mappings.get(override.internalBoutId);
    if (target === undefined) return;
    if (
      !target.externalRefs.some((ref) => externalRefKey(ref) === key)
    ) {
      target.externalRefs.push(cloneExternalRef(override.externalRef));
    }
    target.mappingConfidence = 1;
    target.manuallyVerified = true;
    this.rebuildExternalIndex();
  }

  private rebuildExternalIndex(): void {
    this.externalToInternal.clear();
    for (const mapping of this.mappings.values()) {
      for (const ref of mapping.externalRefs) {
        this.externalToInternal.set(
          externalRefKey(ref),
          mapping.internalBoutId,
        );
      }
    }
  }

  private async persistChangedMappings(): Promise<void> {
    for (const mapping of this.mappings.values()) {
      await this.persistMappingIfChanged(mapping);
    }
  }

  private async persistMappingIfChanged(
    mapping: BoutMapping,
  ): Promise<void> {
    for (const source of new Set(
      mapping.externalRefs.map((ref) => ref.source),
    )) {
      this.metrics.set(
        "mapping_confidence",
        source,
        mapping.mappingConfidence,
      );
    }
    const serialized = JSON.stringify(mapping);
    if (
      this.latestPersistedMappings.get(mapping.internalBoutId) ===
      serialized
    ) {
      return;
    }

    await this.storage.append(BOUT_MAPPING_STREAM, {
      version: 1,
      mapping: cloneMapping(mapping),
    } satisfies PersistedBoutMapping);
    this.latestPersistedMappings.set(
      mapping.internalBoutId,
      serialized,
    );
  }
}

export async function createBoutMappingRegistry(
  options: CreateBoutMappingRegistryOptions,
): Promise<BoutMappingRegistry> {
  return BoutMappingRegistry.create(options);
}
