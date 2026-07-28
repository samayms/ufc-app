import { AMBIGUOUS_MAPPING_STREAM } from "./mapping.ts";
import {
  DEFAULT_ROUND_JOB_DEAD_LETTER_STREAM,
  type RoundJobDeadLetter,
} from "./roundJobs.ts";
import type { Metrics } from "./health.ts";
import { NOOP_METRICS } from "./health.ts";
import type { Storage } from "./storage.ts";

export const PARSER_ERROR_STORAGE_STREAM = "parser-errors";

export interface ParserErrorRecord {
  version: 1;
  source: string;
  context: string;
  error: string;
  sourceTimestamp?: string;
  localTimestamp: string;
}

export interface ParserErrorSink {
  recordParserError(input: {
    source: string;
    context: string;
    error: unknown;
    sourceTimestamp?: string;
    localTimestamp?: string;
  }): Promise<void>;
}

export interface ReviewRecords {
  deadLetters: readonly RoundJobDeadLetter[];
  parserErrors: readonly ParserErrorRecord[];
  ambiguousMappings: readonly unknown[];
}

export interface ReviewRegistryOptions {
  storage: Storage;
  metrics?: Metrics;
  now?: () => string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isParserError(value: unknown): value is ParserErrorRecord {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.source === "string" &&
    value.source.length > 0 &&
    typeof value.context === "string" &&
    value.context.length > 0 &&
    typeof value.error === "string" &&
    value.error.length > 0 &&
    (value.sourceTimestamp === undefined ||
      isTimestamp(value.sourceTimestamp)) &&
    isTimestamp(value.localTimestamp)
  );
}

function isDeadLetter(value: unknown): value is RoundJobDeadLetter {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isRecord(value.job) &&
    typeof value.job.key === "string" &&
    value.job.status === "failed" &&
    typeof value.deadLetteredAt === "number" &&
    typeof value.error === "string"
  );
}

export class ReviewRegistry implements ParserErrorSink {
  private readonly storage: Storage;

  private readonly metrics: Metrics;

  private readonly now: () => string;

  constructor(options: ReviewRegistryOptions) {
    this.storage = options.storage;
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async recordParserError(input: {
    source: string;
    context: string;
    error: unknown;
    sourceTimestamp?: string;
    localTimestamp?: string;
  }): Promise<void> {
    const localTimestamp = input.localTimestamp ?? this.now();
    if (
      input.source.trim().length === 0 ||
      input.context.trim().length === 0 ||
      !isTimestamp(localTimestamp) ||
      (input.sourceTimestamp !== undefined &&
        !isTimestamp(input.sourceTimestamp))
    ) {
      throw new TypeError(
        "parser errors require source, context, and valid timestamps",
      );
    }
    const record: ParserErrorRecord = {
      version: 1,
      source: input.source,
      context: input.context,
      error: errorMessage(input.error),
      ...(input.sourceTimestamp === undefined
        ? {}
        : { sourceTimestamp: input.sourceTimestamp }),
      localTimestamp,
    };
    await this.storage.append(PARSER_ERROR_STORAGE_STREAM, record);
    this.metrics.increment("parser_failures_total", input.source, 1, {
      ...(input.sourceTimestamp === undefined
        ? {}
        : { sourceTimestamp: input.sourceTimestamp }),
      localTimestamp,
    });
  }

  async getReviewRecords(): Promise<ReviewRecords> {
    const [deadLetters, parserErrors, ambiguousMappings] =
      await Promise.all([
        this.storage.read<unknown>(
          DEFAULT_ROUND_JOB_DEAD_LETTER_STREAM,
        ),
        this.storage.read<unknown>(PARSER_ERROR_STORAGE_STREAM),
        this.storage.read<unknown>(AMBIGUOUS_MAPPING_STREAM),
      ]);
    return {
      deadLetters: deadLetters.filter(isDeadLetter),
      parserErrors: parserErrors.filter(isParserError),
      ambiguousMappings,
    };
  }
}
