import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  STREAM_RETENTION,
  StreamJanitor,
  type RetentionPolicy,
} from "./retention.ts";
import {
  JsonlStorage,
  MemoryStorage,
  type Storage,
} from "./storage.ts";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ufc-retention-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function typescriptSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory);
  const sources: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry);
    const details = await stat(path);
    if (details.isDirectory()) sources.push(...await typescriptSources(path));
    else if (details.isFile() && entry.endsWith(".ts")) sources.push(path);
  }
  return sources;
}

describe("stream retention registry", () => {
  it("declares a policy for every stream constant", async () => {
    const serverDirectory = dirname(fileURLToPath(import.meta.url));
    const streamPattern =
      /\bconst\s+[A-Z][A-Z0-9_]*_STREAM[A-Z0-9_]*\s*=\s*["']([^"']+)["']/gu;
    const discovered = new Set<string>();

    for (const source of await typescriptSources(serverDirectory)) {
      const contents = await readFile(source, "utf8");
      for (const match of contents.matchAll(streamPattern)) {
        const stream = match[1];
        if (stream !== undefined) discovered.add(stream);
      }
    }

    // This is deliberately a ratchet: a new stream without an explicit
    // retention decision must fail this test, not be hidden by a looser check.
    expect(
      [...discovered].filter((stream) => !(stream in STREAM_RETENTION)),
    ).toEqual([]);
  });

  it("leaves only the all-time paid spend ledger unbounded", () => {
    expect(
      Object.entries(STREAM_RETENTION)
        .filter(([, policy]) => policy.kind === "unbounded")
        .map(([stream]) => stream),
    ).toEqual(["spend-acquisitions"]);
    expect(STREAM_RETENTION["spend-acquisitions"]).toMatchObject({
      reason: expect.stringMatching(/all-time.*under-count.*overspend/u),
    });
  });
});

describe("Storage.compact", () => {
  it("is atomic with an append queued while JSONL compaction is in flight", async () => {
    const storage = new JsonlStorage(await createTemporaryDirectory());
    await storage.append("atomic", { key: "same", revision: 1 });
    await storage.append("atomic", { key: "same", revision: 2 });
    const policy: RetentionPolicy = {
      kind: "last-per-key",
      key: (record) =>
        typeof record === "object" && record !== null &&
          typeof (record as { key?: unknown }).key === "string"
          ? (record as { key: string }).key
          : undefined,
    };

    const compaction = storage.compact("atomic", policy);
    const append = storage.append("atomic", { key: "new", revision: 3 });

    await expect(compaction).resolves.toEqual({ before: 2, after: 1 });
    await append;
    await expect(storage.read("atomic")).resolves.toEqual([
      { key: "same", revision: 2 },
      { key: "new", revision: 3 },
    ]);
  });

  it("keeps latest keyed records, unkeyed records, and latest-write order", async () => {
    const storage = new MemoryStorage();
    const records = [
      { key: "a", revision: 1 },
      { note: "unkeyed one" },
      { key: "b", revision: 1 },
      { note: "unkeyed two" },
      { key: "a", revision: 2 },
    ];
    for (const record of records) await storage.append("states", record);

    await expect(storage.compact("states", {
      kind: "last-per-key",
      key: (record) =>
        typeof record === "object" && record !== null &&
          typeof (record as { key?: unknown }).key === "string"
          ? (record as { key: string }).key
          : undefined,
    })).resolves.toEqual({ before: 5, after: 4 });

    await expect(storage.read("states")).resolves.toEqual([
      { note: "unkeyed one" },
      { key: "b", revision: 1 },
      { note: "unkeyed two" },
      { key: "a", revision: 2 },
    ]);
  });

  it("keeps only the final N records for newest retention", async () => {
    const storage = new MemoryStorage();
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      await storage.append("recent", { sequence });
    }

    await expect(storage.compact("recent", {
      kind: "newest",
      limit: 3,
    })).resolves.toEqual({ before: 6, after: 3 });
    await expect(storage.read("recent")).resolves.toEqual([
      { sequence: 4 },
      { sequence: 5 },
      { sequence: 6 },
    ]);
  });

  it("keeps timestamp-less and in-window records relative to the newest timestamp", async () => {
    const storage = new MemoryStorage();
    const records = [
      { id: "old", acquiredAt: 1_000 },
      { id: "unknown" },
      { id: "newest", acquiredAt: 10_000 },
      { id: "recent", acquiredAt: 7_001 },
      { id: "too-old", acquiredAt: 7_000 },
    ];
    for (const record of records) await storage.append("windowed", record);

    await expect(storage.compact("windowed", {
      kind: "newer-than",
      windowMs: 3_000,
      at: (record) =>
        typeof record === "object" && record !== null &&
          typeof (record as { acquiredAt?: unknown }).acquiredAt === "number"
          ? (record as { acquiredAt: number }).acquiredAt
          : undefined,
    })).resolves.toEqual({ before: 5, after: 3 });
    await expect(storage.read("windowed")).resolves.toEqual([
      { id: "unknown" },
      { id: "newest", acquiredAt: 10_000 },
      { id: "recent", acquiredAt: 7_001 },
    ]);
  });

  it("counts but does not rewrite an unbounded stream", async () => {
    class ReplaceDetectingStorage extends MemoryStorage {
      readonly replace = vi.fn(super.replace.bind(this));
    }
    const storage = new ReplaceDetectingStorage();
    await storage.append("audit", { sequence: 1 });
    await storage.append("audit", { sequence: 2 });

    await expect(storage.compact("audit", {
      kind: "unbounded",
      reason: "Every entry is part of the public audit history.",
    })).resolves.toEqual({ before: 2, after: 2 });
    expect(storage.replace).not.toHaveBeenCalled();
    await expect(storage.read("audit")).resolves.toEqual([
      { sequence: 1 },
      { sequence: 2 },
    ]);
  });

  it("does not create a missing stream as a side effect", async () => {
    const storage = new JsonlStorage(await createTemporaryDirectory());

    await expect(storage.compact("missing", {
      kind: "newest",
      limit: 10,
    })).resolves.toEqual({ before: 0, after: 0 });
    await expect(storage.listStreams()).resolves.toEqual([]);
  });
});

describe("StreamJanitor", () => {
  it("warns at startup and on each sweep when a stream exceeds its byte budget", async () => {
    const storage = new JsonlStorage(await createTemporaryDirectory());
    await storage.append("spend-acquisitions", { payload: "x".repeat(200) });
    const logger = { log: vi.fn(), warn: vi.fn() };
    const timer = {
      setInterval: vi.fn(() => 7),
      clearInterval: vi.fn(),
    };
    const janitor = new StreamJanitor({
      storage,
      logger,
      timer,
      sizeWarningBytes: 64,
    });

    await janitor.start();
    await janitor.sweep();
    await janitor.stop();

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/spend-acquisitions.*\d+ bytes.*64 bytes/u),
    );
  });

  it("tolerates a stream disappearing before its size can be inspected", async () => {
    class DisappearingStorage extends JsonlStorage {
      override async listStreams(): Promise<string[]> {
        return ["already-gone"];
      }
    }
    const storage = new DisappearingStorage(await createTemporaryDirectory());
    const logger = { log: vi.fn(), warn: vi.fn() };
    const janitor = new StreamJanitor({
      storage,
      logger,
      sizeWarningBytes: 1,
    });

    await expect(janitor.sweep()).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("sweeps at startup and on its timer, then stops the timer", async () => {
    const storage = new MemoryStorage();
    await storage.append("collector-state", {
      state: { event: { id: "event-1" } },
      revision: 1,
    });
    await storage.append("collector-state", {
      state: { event: { id: "event-1" } },
      revision: 2,
    });
    let intervalCallback: (() => void) | undefined;
    const timer = {
      setInterval: vi.fn((callback: () => void) => {
        intervalCallback = callback;
        return 7;
      }),
      clearInterval: vi.fn(),
    };
    const logger = { log: vi.fn(), warn: vi.fn() };
    const janitor = new StreamJanitor({
      storage,
      intervalMs: 123,
      timer,
      logger,
    });

    await janitor.start();
    await expect(storage.read("collector-state")).resolves.toHaveLength(1);

    await storage.append("collector-state", {
      state: { event: { id: "event-1" } },
      revision: 3,
    });
    intervalCallback?.();
    await janitor.stop();

    await expect(storage.read("collector-state")).resolves.toEqual([
      {
        state: { event: { id: "event-1" } },
        revision: 3,
      },
    ]);
    expect(timer.setInterval).toHaveBeenCalledWith(expect.any(Function), 123);
    expect(timer.clearInterval).toHaveBeenCalledWith(7);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("continues to later streams after one compaction fails", async () => {
    const compact = vi.fn(async (stream: string) => {
      if (stream === "collector-state") throw new Error("disk failure");
      return { before: 1, after: 1 };
    });
    const storage: Storage = {
      append: async () => undefined,
      replace: async () => undefined,
      read: async () => [],
      listStreams: async () => [],
      compact,
    };
    const logger = { log: vi.fn(), warn: vi.fn() };
    const janitor = new StreamJanitor({ storage, logger });

    await janitor.sweep();

    expect(compact).toHaveBeenCalledWith(
      "fight-lifecycle",
      STREAM_RETENTION["fight-lifecycle"],
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("collector-state"),
      expect.any(Error),
    );
  });
});
