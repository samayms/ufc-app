import type { TimelineEntry } from "./contract.ts";

export interface LabTimelineOptions {
  /** Injected for tests. Defaults to the process clock. */
  now?: () => number;
  /** Ring-buffer cap; oldest entries drop. */
  maxEntries?: number;
  /** Optional append-only JSONL sink. */
  appendFile?: (line: string) => void;
}

export type TimelineInput = Omit<
  TimelineEntry,
  "seq" | "at" | "deltaMs" | "deltaFrom"
> & {
  /** Overrides the clock when a poller timestamped its own observation. */
  at?: string;
};

const DEFAULT_MAX_ENTRIES = 5_000;

function markerKey(boutId: string, round: number): string {
  return `${boutId}\u0000${round}`;
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${field} must be a valid ISO-8601 timestamp`);
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LabTimeline {
  readonly #now: () => number;
  readonly #maxEntries: number;
  readonly #appendFile?: (line: string) => void;
  readonly #entries: TimelineEntry[] = [];
  readonly #latestMarkerByBoutRound = new Map<string, TimelineEntry>();
  readonly #latestMarkerByRound = new Map<number, TimelineEntry>();
  readonly #latestRoundOnlyMarker = new Map<number, TimelineEntry>();
  #latestSeq = 0;

  constructor(options: LabTimelineOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive safe integer");
    }
    this.#now = options.now ?? (() => Date.now());
    this.#maxEntries = maxEntries;
    this.#appendFile = options.appendFile;
  }

  /**
   * Assigns insertion order before persistence. A failed sink can therefore
   * never make a successfully recorded observation disappear from memory.
   */
  record(input: TimelineInput): TimelineEntry {
    return this.#record(input, true);
  }

  /** Returns retained entries in insertion order, never timestamp order. */
  since(seq: number): TimelineEntry[] {
    return this.#entries.filter((entry) => entry.seq > seq);
  }

  get latestSeq(): number {
    return this.#latestSeq;
  }

  get size(): number {
    return this.#entries.length;
  }

  #record(input: TimelineInput, reportPersistenceFailure: boolean): TimelineEntry {
    const at = this.#entryTime(input.at);
    const entry: TimelineEntry = {
      seq: ++this.#latestSeq,
      at,
      kind: input.kind,
      source: input.source,
      label: input.label,
      ...(input.boutId === undefined ? {} : { boutId: input.boutId }),
      ...(input.round === undefined ? {} : { round: input.round }),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    };

    if (entry.kind === "marker") {
      this.#rememberMarker(entry);
    } else {
      const marker = this.#matchingMarker(entry);
      if (marker !== undefined) {
        entry.deltaMs = timestamp(entry.at, "at") - timestamp(marker.at, "marker at");
        entry.deltaFrom = marker.label;
      }
    }

    this.#store(entry);
    this.#persist(entry, reportPersistenceFailure);
    return entry;
  }

  #entryTime(supplied: string | undefined): string {
    if (supplied !== undefined) {
      return new Date(timestamp(supplied, "at")).toISOString();
    }
    const now = this.#now();
    if (!Number.isFinite(now)) {
      throw new TypeError("now() must return a finite timestamp");
    }
    return new Date(now).toISOString();
  }

  #rememberMarker(marker: TimelineEntry): void {
    if (marker.round === undefined) return;

    this.#latestMarkerByRound.set(marker.round, marker);
    if (marker.boutId === undefined) {
      this.#latestRoundOnlyMarker.set(marker.round, marker);
    } else {
      this.#latestMarkerByBoutRound.set(
        markerKey(marker.boutId, marker.round),
        marker,
      );
    }
  }

  #matchingMarker(entry: TimelineEntry): TimelineEntry | undefined {
    if (entry.round === undefined) return undefined;

    if (entry.boutId !== undefined) {
      return (
        this.#latestMarkerByBoutRound.get(
          markerKey(entry.boutId, entry.round),
        ) ?? this.#latestRoundOnlyMarker.get(entry.round)
      );
    }
    return this.#latestMarkerByRound.get(entry.round);
  }

  #store(entry: TimelineEntry): void {
    this.#entries.push(entry);
    if (this.#entries.length > this.#maxEntries) {
      this.#entries.splice(0, this.#entries.length - this.#maxEntries);
    }
  }

  #persist(entry: TimelineEntry, reportPersistenceFailure: boolean): void {
    if (this.#appendFile === undefined) return;

    try {
      this.#appendFile(`${JSON.stringify(entry)}\n`);
    } catch (error) {
      if (!reportPersistenceFailure) return;

      this.#record(
        {
          kind: "note",
          source: "timeline",
          label: "timeline persistence failed",
          detail: { error: errorMessage(error) },
        },
        false,
      );
    }
  }
}
