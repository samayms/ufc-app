import {
  appendFile,
  mkdir,
  readdir,
  rename,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import type { RetentionPolicy } from "./retention.ts";

export const DEFAULT_DATA_DIRECTORY = "./data";

export interface Storage {
  append(stream: string, record: unknown): Promise<void>;
  replace(stream: string, records: readonly unknown[]): Promise<void>;
  compact(
    stream: string,
    policy: RetentionPolicy,
  ): Promise<{ before: number; after: number }>;
  read<Record = unknown>(stream: string): Promise<Record[]>;
  listStreams(): Promise<string[]>;
  streamSize?(stream: string): Promise<number | undefined>;
}

type ParsedJsonl = {
  records: unknown[];
  invalidTrailingLineStart?: number;
  endsWithNewline: boolean;
};

type JsonlReadState = {
  invalidTrailingLineStart?: number;
  endsWithNewline: boolean;
};

async function* iterateJsonlFile(
  path: string,
  stream: string,
  state: JsonlReadState = { endsWithNewline: true },
): AsyncGenerator<unknown, void> {
  let line = Buffer.alloc(0);
  let lineStart = 0;
  let lineNumber = 0;
  let invalidTrailingLineStart: number | undefined;
  let endedWithNewline = true;

  const consumeLine = (rawLine: Buffer): unknown | undefined => {
    lineNumber += 1;
    const text = rawLine.toString("utf8").replace(/\r$/, "");
    if (text.trim().length === 0) return;

    try {
      const record = JSON.parse(text) as unknown;
      if (invalidTrailingLineStart !== undefined) {
        throw new SyntaxError(
          `Corrupt JSONL record in stream "${stream}" at line ${lineNumber - 1}`,
        );
      }
      return record;
    } catch (error) {
      if (invalidTrailingLineStart === undefined) {
        invalidTrailingLineStart = lineStart;
        return;
      }
      throw error;
    }
  };

  for await (const chunk of createReadStream(path)) {
    line = Buffer.concat([line, chunk as Buffer]);
    endedWithNewline = line.length === 0;
    let newline = line.indexOf(10);
    while (newline !== -1) {
      const completeLine = line.subarray(0, newline);
      const record = consumeLine(completeLine);
      if (record !== undefined) yield record;
      lineStart += newline + 1;
      line = line.subarray(newline + 1);
      endedWithNewline = line.length === 0;
      newline = line.indexOf(10);
    }
  }

  if (line.length > 0) {
    endedWithNewline = false;
    const record = consumeLine(line);
    if (record !== undefined) yield record;
  }
  state.invalidTrailingLineStart = invalidTrailingLineStart;
  state.endsWithNewline = endedWithNewline;
}

async function readJsonlFile(path: string, stream: string): Promise<ParsedJsonl> {
  const records: unknown[] = [];
  const state: JsonlReadState = { endsWithNewline: true };
  for await (const record of iterateJsonlFile(path, stream, state)) records.push(record);
  return {
    records,
    ...(state.invalidTrailingLineStart === undefined
      ? {}
      : { invalidTrailingLineStart: state.invalidTrailingLineStart }),
    endsWithNewline: state.endsWithNewline,
  };
}

export async function readStorageRecords(
  storage: Storage,
  stream: string,
  visitor: (record: unknown) => void,
): Promise<void> {
  const streaming = storage as Storage & {
    readEach?: (stream: string, visitor: (record: unknown) => void) => Promise<void>;
  };
  if (streaming.readEach !== undefined) {
    await streaming.readEach(stream, visitor);
    return;
  }
  for (const record of await storage.read(stream)) visitor(record);
}

function assertStreamName(stream: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stream) ||
    stream === "." ||
    stream === ".."
  ) {
    throw new TypeError(
      "Stream names must start with an alphanumeric character and contain only letters, numbers, dots, underscores, or hyphens",
    );
  }
}

function serializeRecord(record: unknown): string {
  const serialized = JSON.stringify(record);

  if (serialized === undefined) {
    throw new TypeError("Storage records must be JSON-serializable");
  }

  return serialized;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

interface RetentionAccumulator {
  add(record: unknown): void;
  finish(): { before: number; records?: unknown[] };
}

function retentionAccumulator(policy: RetentionPolicy): RetentionAccumulator {
  let before = 0;

  switch (policy.kind) {
    case "last-per-key": {
      const retained = new Map<string | symbol, unknown>();
      return {
        add(record) {
          before += 1;
          const key = policy.key(record);
          if (key === undefined) {
            // An unrecognized record may still be meaningful to a newer
            // reader. Give it a unique key so compaction preserves it in its
            // original relative position instead of treating it as garbage.
            retained.set(Symbol(), record);
            return;
          }
          // Reinsertion makes Map order reflect the record's final write, so
          // the compacted stream's last entry is still the global newest.
          retained.delete(key);
          retained.set(key, record);
        },
        finish: () => ({ before, records: [...retained.values()] }),
      };
    }
    case "newest": {
      if (!Number.isSafeInteger(policy.limit) || policy.limit < 0) {
        throw new TypeError(
          "newest retention limit must be a non-negative safe integer",
        );
      }
      const retained: unknown[] = [];
      return {
        add(record) {
          before += 1;
          if (policy.limit === 0) return;
          if (retained.length < policy.limit) retained.push(record);
          else retained[(before - 1) % policy.limit] = record;
        },
        finish() {
          if (policy.limit === 0 || before <= policy.limit) {
            return { before, records: retained };
          }
          const start = before % policy.limit;
          return {
            before,
            records: retained.slice(start).concat(retained.slice(0, start)),
          };
        },
      };
    }
    case "newer-than": {
      if (!Number.isFinite(policy.windowMs) || policy.windowMs < 0) {
        throw new TypeError(
          "newer-than retention windowMs must be a non-negative finite number",
        );
      }
      const retained: Array<{ record: unknown; at: number | undefined }> = [];
      let newestAt: number | undefined;
      return {
        add(record) {
          before += 1;
          const at = policy.at(record);
          retained.push({ record, at });
          if (at !== undefined && (newestAt === undefined || at > newestAt)) {
            newestAt = at;
          }
        },
        finish() {
          if (newestAt === undefined) {
            return { before, records: retained.map(({ record }) => record) };
          }
          const cutoff = newestAt - policy.windowMs;
          return {
            before,
            records: retained
              .filter(({ at }) => at === undefined || at > cutoff)
              .map(({ record }) => record),
          };
        },
      };
    }
    case "unbounded":
      return {
        add() {
          before += 1;
        },
        finish: () => ({ before }),
      };
  }
}

export class JsonlStorage implements Storage {
  private readonly directory: string;

  private readonly recoveredStreams = new Set<string>();

  private readonly writeQueues = new Map<string, Promise<unknown>>();

  constructor(directory = DEFAULT_DATA_DIRECTORY) {
    this.directory = directory;
  }

  async append(stream: string, record: unknown): Promise<void> {
    assertStreamName(stream);
    const serialized = serializeRecord(record);
    await this.enqueueWrite(stream, () =>
      this.appendSerialized(stream, serialized)
    );
  }

  async replace(
    stream: string,
    records: readonly unknown[],
  ): Promise<void> {
    assertStreamName(stream);
    const serialized = records.map(serializeRecord);
    await this.enqueueWrite(stream, () =>
      this.replaceSerialized(stream, serialized)
    );
  }

  async compact(
    stream: string,
    policy: RetentionPolicy,
  ): Promise<{ before: number; after: number }> {
    assertStreamName(stream);
    return this.enqueueWrite(stream, async () => {
      const accumulator = retentionAccumulator(policy);
      try {
        for await (const record of iterateJsonlFile(
          this.streamPath(stream),
          stream,
        )) {
          accumulator.add(record);
        }
      } catch (error) {
        if (!isFileNotFound(error)) throw error;
      }

      const result = accumulator.finish();
      if (result.records === undefined) {
        return { before: result.before, after: result.before };
      }
      if (result.records.length === result.before) {
        return { before: result.before, after: result.before };
      }
      // This private rewrite is intentionally inside the same queued
      // operation as the streaming read. Calling public replace() here would
      // deadlock behind this operation; doing read()+replace() outside it
      // would allow an intervening append to be silently discarded.
      await this.replaceSerialized(
        stream,
        result.records.map(serializeRecord),
      );
      return { before: result.before, after: result.records.length };
    });
  }

  async read<Record = unknown>(stream: string): Promise<Record[]> {
    assertStreamName(stream);
    await this.writeQueues.get(stream);

    try {
      return (await readJsonlFile(this.streamPath(stream), stream)).records as Record[];
    } catch (error) {
      if (isFileNotFound(error)) {
        return [];
      }

      throw error;
    }
  }

  async readEach(
    stream: string,
    visitor: (record: unknown) => void,
  ): Promise<void> {
    assertStreamName(stream);
    await this.writeQueues.get(stream);
    try {
      for await (const record of iterateJsonlFile(this.streamPath(stream), stream)) {
        visitor(record);
      }
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
  }

  async listStreams(): Promise<string[]> {
    await Promise.all(this.writeQueues.values());

    try {
      const entries = await readdir(this.directory, { withFileTypes: true });

      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name.slice(0, -".jsonl".length))
        .filter((stream) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stream))
        .sort();
    } catch (error) {
      if (isFileNotFound(error)) {
        return [];
      }

      throw error;
    }
  }

  async streamSize(stream: string): Promise<number | undefined> {
    assertStreamName(stream);
    await this.writeQueues.get(stream);
    try {
      return (await stat(this.streamPath(stream))).size;
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw error;
    }
  }

  private streamPath(stream: string): string {
    return join(this.directory, `${stream}.jsonl`);
  }

  private async enqueueWrite<Result>(
    stream: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previousWrite = this.writeQueues.get(stream) ?? Promise.resolve();
    const write = previousWrite
      .catch(() => undefined)
      .then(operation);
    this.writeQueues.set(stream, write);

    try {
      return await write;
    } finally {
      if (this.writeQueues.get(stream) === write) {
        this.writeQueues.delete(stream);
      }
    }
  }

  private async appendSerialized(
    stream: string,
    serialized: string,
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = this.streamPath(stream);
    let separator = "";

    if (!this.recoveredStreams.has(stream)) {
      separator = await this.recoverTrailingLine(path, stream);
      this.recoveredStreams.add(stream);
    }

    await appendFile(path, `${separator}${serialized}\n`, "utf8");
  }

  private async replaceSerialized(
    stream: string,
    records: readonly string[],
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = this.streamPath(stream);
    const temporaryPath = `${path}.replace`;
    const contents =
      records.length === 0 ? "" : `${records.join("\n")}\n`;

    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, path);
    this.recoveredStreams.add(stream);
  }

  private async recoverTrailingLine(
    path: string,
    stream: string,
  ): Promise<string> {
    try {
      const parsed = await readJsonlFile(path, stream);
      if (parsed.invalidTrailingLineStart !== undefined) {
        await truncate(path, parsed.invalidTrailingLineStart);
        return "";
      }
      return parsed.endsWithNewline ? "" : "\n";
    } catch (error) {
      if (isFileNotFound(error)) {
        return "";
      }

      throw error;
    }
  }
}

export class MemoryStorage implements Storage {
  private readonly streams = new Map<string, unknown[]>();

  private readonly writeQueues = new Map<string, Promise<unknown>>();

  async append(stream: string, record: unknown): Promise<void> {
    assertStreamName(stream);
    const storedRecord = JSON.parse(serializeRecord(record)) as unknown;
    await this.enqueueWrite(stream, async () => {
      const records = this.streams.get(stream) ?? [];
      records.push(storedRecord);
      this.streams.set(stream, records);
    });
  }

  async replace(
    stream: string,
    records: readonly unknown[],
  ): Promise<void> {
    assertStreamName(stream);
    const storedRecords = records.map(
      (record) => JSON.parse(serializeRecord(record)) as unknown,
    );
    await this.enqueueWrite(stream, async () => {
      this.streams.set(stream, storedRecords);
    });
  }

  async compact(
    stream: string,
    policy: RetentionPolicy,
  ): Promise<{ before: number; after: number }> {
    assertStreamName(stream);
    return this.enqueueWrite(stream, async () => {
      const accumulator = retentionAccumulator(policy);
      for (const record of this.streams.get(stream) ?? []) {
        accumulator.add(record);
      }
      const result = accumulator.finish();
      if (result.records === undefined) {
        return { before: result.before, after: result.before };
      }
      if (result.records.length === result.before) {
        return { before: result.before, after: result.before };
      }
      this.streams.set(
        stream,
        result.records.map(
          (record) => JSON.parse(serializeRecord(record)) as unknown,
        ),
      );
      return { before: result.before, after: result.records.length };
    });
  }

  async read<Record = unknown>(stream: string): Promise<Record[]> {
    assertStreamName(stream);
    await this.writeQueues.get(stream);
    const records = this.streams.get(stream) ?? [];
    return records.map(
      (record) => JSON.parse(serializeRecord(record)) as Record,
    );
  }

  async listStreams(): Promise<string[]> {
    await Promise.all(this.writeQueues.values());
    return [...this.streams.keys()].sort();
  }

  async readEach(
    stream: string,
    visitor: (record: unknown) => void,
  ): Promise<void> {
    await this.writeQueues.get(stream);
    for (const record of this.streams.get(stream) ?? []) visitor(record);
  }

  private async enqueueWrite<Result>(
    stream: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previousWrite = this.writeQueues.get(stream) ?? Promise.resolve();
    const write = previousWrite
      .catch(() => undefined)
      .then(operation);
    this.writeQueues.set(stream, write);

    try {
      return await write;
    } finally {
      if (this.writeQueues.get(stream) === write) {
        this.writeQueues.delete(stream);
      }
    }
  }
}
