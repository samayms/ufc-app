import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  truncate,
} from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_DATA_DIRECTORY = "./data";

export interface Storage {
  append(stream: string, record: unknown): Promise<void>;
  read<Record = unknown>(stream: string): Promise<Record[]>;
  listStreams(): Promise<string[]>;
}

type ParsedJsonl = {
  records: unknown[];
  invalidTrailingLineStart?: number;
};

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

function parseJsonl(contents: string, stream: string): ParsedJsonl {
  const lines = contents.split("\n");
  let lastMeaningfulLine = lines.length - 1;

  while (
    lastMeaningfulLine >= 0 &&
    lines[lastMeaningfulLine]?.trim().length === 0
  ) {
    lastMeaningfulLine -= 1;
  }

  const records: unknown[] = [];
  let lineStart = 0;

  for (let index = 0; index <= lastMeaningfulLine; index += 1) {
    const line = lines[index] ?? "";

    if (line.trim().length === 0) {
      lineStart += line.length + 1;
      continue;
    }

    try {
      records.push(JSON.parse(line) as unknown);
    } catch (error) {
      if (index === lastMeaningfulLine) {
        return { records, invalidTrailingLineStart: lineStart };
      }

      throw new SyntaxError(
        `Corrupt JSONL record in stream "${stream}" at line ${index + 1}`,
        { cause: error },
      );
    }

    lineStart += line.length + 1;
  }

  return { records };
}

export class JsonlStorage implements Storage {
  private readonly directory: string;

  private readonly recoveredStreams = new Set<string>();

  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(directory = DEFAULT_DATA_DIRECTORY) {
    this.directory = directory;
  }

  async append(stream: string, record: unknown): Promise<void> {
    assertStreamName(stream);
    const serialized = serializeRecord(record);
    const previousWrite = this.writeQueues.get(stream) ?? Promise.resolve();
    const write = previousWrite
      .catch(() => undefined)
      .then(() => this.appendSerialized(stream, serialized));

    this.writeQueues.set(stream, write);

    try {
      await write;
    } finally {
      if (this.writeQueues.get(stream) === write) {
        this.writeQueues.delete(stream);
      }
    }
  }

  async read<Record = unknown>(stream: string): Promise<Record[]> {
    assertStreamName(stream);
    await this.writeQueues.get(stream);

    try {
      const contents = await readFile(this.streamPath(stream), "utf8");
      return parseJsonl(contents, stream).records as Record[];
    } catch (error) {
      if (isFileNotFound(error)) {
        return [];
      }

      throw error;
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

  private streamPath(stream: string): string {
    return join(this.directory, `${stream}.jsonl`);
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

  private async recoverTrailingLine(
    path: string,
    stream: string,
  ): Promise<string> {
    let contents: string;

    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return "";
      }

      throw error;
    }

    const parsed = parseJsonl(contents, stream);

    if (parsed.invalidTrailingLineStart !== undefined) {
      const validPrefix = contents.slice(0, parsed.invalidTrailingLineStart);
      const validByteLength = new TextEncoder().encode(validPrefix).byteLength;
      await truncate(path, validByteLength);
      return "";
    }

    return contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
  }
}

export class MemoryStorage implements Storage {
  private readonly streams = new Map<string, unknown[]>();

  async append(stream: string, record: unknown): Promise<void> {
    assertStreamName(stream);
    const storedRecord = JSON.parse(serializeRecord(record)) as unknown;
    const records = this.streams.get(stream) ?? [];
    records.push(storedRecord);
    this.streams.set(stream, records);
  }

  async read<Record = unknown>(stream: string): Promise<Record[]> {
    assertStreamName(stream);
    const records = this.streams.get(stream) ?? [];
    return records.map(
      (record) => JSON.parse(serializeRecord(record)) as Record,
    );
  }

  async listStreams(): Promise<string[]> {
    return [...this.streams.keys()].sort();
  }
}
