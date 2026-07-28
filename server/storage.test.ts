import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  JsonlStorage,
  MemoryStorage,
  type Storage,
} from "./storage.ts";

type TestRecord = {
  id: string;
  round: number;
  nested?: { final: boolean };
};

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ufc-storage-"));
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

async function expectStorageParity(storage: Storage): Promise<void> {
  const first: TestRecord = { id: "round-1", round: 1 };
  const second: TestRecord = {
    id: "round-2",
    round: 2,
    nested: { final: true },
  };

  await expect(storage.listStreams()).resolves.toEqual([]);
  await expect(storage.read("missing")).resolves.toEqual([]);

  await storage.append("rounds", first);
  await storage.append("rounds", second);
  await storage.append("health", { source: "espn", healthy: true });

  await expect(storage.read<TestRecord>("rounds")).resolves.toEqual([
    first,
    second,
  ]);
  await expect(storage.listStreams()).resolves.toEqual(["health", "rounds"]);
}

describe("JsonlStorage", () => {
  it("round-trips appended records across reloads", async () => {
    const directory = await createTemporaryDirectory();
    const storage = new JsonlStorage(directory);

    await expectStorageParity(storage);

    const reloaded = new JsonlStorage(directory);
    await expect(reloaded.read<TestRecord>("rounds")).resolves.toEqual([
      { id: "round-1", round: 1 },
      {
        id: "round-2",
        round: 2,
        nested: { final: true },
      },
    ]);
    await expect(reloaded.listStreams()).resolves.toEqual([
      "health",
      "rounds",
    ]);
  });

  it("ignores and repairs a corrupt truncated final line after reload", async () => {
    const directory = await createTemporaryDirectory();
    const storage = new JsonlStorage(directory);
    const first: TestRecord = { id: "round-1", round: 1 };
    const second: TestRecord = { id: "round-2", round: 2 };

    await storage.append("rounds", first);
    await storage.append("rounds", second);
    await appendFile(
      join(directory, "rounds.jsonl"),
      '{"id":"truncated"',
      "utf8",
    );

    const reloaded = new JsonlStorage(directory);
    await expect(reloaded.read<TestRecord>("rounds")).resolves.toEqual([
      first,
      second,
    ]);

    const third: TestRecord = { id: "round-3", round: 3 };
    await reloaded.append("rounds", third);

    const reloadedAgain = new JsonlStorage(directory);
    await expect(reloadedAgain.read<TestRecord>("rounds")).resolves.toEqual([
      first,
      second,
      third,
    ]);
  });
});

describe("MemoryStorage", () => {
  it("matches the Storage stream behavior", async () => {
    await expectStorageParity(new MemoryStorage());
  });
});
