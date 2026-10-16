import { describe, expect, it } from "vitest";

import { AMBIGUOUS_MAPPING_STREAM } from "./mapping.ts";
import {
  ReviewRegistry,
  PARSER_ERROR_STORAGE_STREAM,
} from "./review.ts";
import { DEFAULT_ROUND_JOB_DEAD_LETTER_STREAM } from "./roundJobs.ts";
import { MemoryStorage } from "./storage.ts";

describe("ReviewRegistry", () => {
  it("streams review records while preserving filtering and stream order", async () => {
    class StreamingReviewStorage extends MemoryStorage {
      override async read<Record = unknown>(stream: string): Promise<Record[]> {
        if (
          stream === DEFAULT_ROUND_JOB_DEAD_LETTER_STREAM ||
          stream === PARSER_ERROR_STORAGE_STREAM ||
          stream === AMBIGUOUS_MAPPING_STREAM
        ) {
          throw new Error(`${stream} must be streamed`);
        }
        return super.read<Record>(stream);
      }
    }

    const storage = new StreamingReviewStorage();
    const job = {
      version: 1 as const,
      key: "bout-1:1:score",
      boutId: "bout-1",
      round: 1,
      jobType: "score",
      status: "failed" as const,
      dueAt: 10,
      attemptCount: 3,
      retryPolicy: { delayMs: 100, maxAttempts: 3 },
      createdAt: 1,
      updatedAt: 10,
    };
    const deadLetters = [
      { version: 1, job, deadLetteredAt: 11, error: "first" },
      { version: 1, job, deadLetteredAt: 12, error: "second" },
    ];
    const parserErrors = [
      {
        version: 1,
        source: "espn",
        context: "first parser error",
        error: "first",
        localTimestamp: "2026-10-16T12:00:00Z",
      },
      {
        version: 1,
        source: "sherdog",
        context: "second parser error",
        error: "second",
        localTimestamp: "2026-10-16T12:01:00Z",
      },
    ];
    const ambiguousMappings = [
      { version: 1, record: { externalId: "first" } },
      { version: 1, record: { externalId: "second" } },
    ];
    await storage.append(DEFAULT_ROUND_JOB_DEAD_LETTER_STREAM, deadLetters[0]);
    await storage.append(DEFAULT_ROUND_JOB_DEAD_LETTER_STREAM, { invalid: true });
    await storage.append(DEFAULT_ROUND_JOB_DEAD_LETTER_STREAM, deadLetters[1]);
    await storage.append(PARSER_ERROR_STORAGE_STREAM, parserErrors[0]);
    await storage.append(PARSER_ERROR_STORAGE_STREAM, { invalid: true });
    await storage.append(PARSER_ERROR_STORAGE_STREAM, parserErrors[1]);
    await storage.append(AMBIGUOUS_MAPPING_STREAM, ambiguousMappings[0]);
    await storage.append(AMBIGUOUS_MAPPING_STREAM, ambiguousMappings[1]);

    await expect(
      new ReviewRegistry({ storage }).getReviewRecords(),
    ).resolves.toEqual({
      deadLetters,
      parserErrors,
      ambiguousMappings,
    });
  });
});
