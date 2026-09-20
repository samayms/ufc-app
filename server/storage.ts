import {
  appendFile,
  mkdir,
  readdir,
  rename,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";

export const DEFAULT_DATA_DIRECTORY = "./data";

export interface Storage {
  append(stream: string, record: unknown): Promise<void>;
  replace(stream: string, records: readonly unknown[]): Promise<void>;
  read<Record = unknown>(stream: string): Promise<Record[]>;
  listStreams(): Promise<string[]>;
}

type ParsedJsonl = {
  records: unknown[];
  invalidTrailingLineStart?: number;
  endsWithNewline: boolean;
};

async function readJsonlFile(path: string, stream: string): Promise<ParsedJsonl> {
  const records: unknown[] = [];
  let line = Buffer.alloc(0);
  let lineStart = 0;
  let lineNumber = 0;
  let invalidTrailingLineStart: number | undefined;

  const consumeLine = (rawLine: Buffer): void => {
    lineNumber += 1;
    const text = rawLine.toString("utf8").replace(/\r$/, "");
    if (text.trim().length === 0) return;

    try {
      records.push(JSON.parse(text) as unknown);
      if (invalidTrailingLineStart !== undefined) {
        throw new SyntaxError(
          `Corrupt JSONL record in stream "${stream}" at line ${lineNumber - 1}`,
        );
      }
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
    let newline = line.indexOf(10);
    while (newline !== -1) {
      const completeLine = line.subarray(0, newline);
      consumeLine(completeLine);
      lineStart += newline + 1;
      line = line.subarray(newline + 1);
      newline = line.indexOf(10);
    }
  }

  if (line.length > 0) consumeLine(line);
  return {
    records,
    ...(invalidTrailingLineStart === undefined ? {} : { invalidTrailingLineStart }),
    endsWithNewline: line.length === 0,
  };
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

  async replace(
    stream: string,
    records: readonly unknown[],
  ): Promise<void> {
    assertStreamName(stream);
    const serialized = records.map(serializeRecord);
    const previousWrite = this.writeQueues.get(stream) ?? Promise.resolve();
    const write = previousWrite
      .catch(() => undefined)
      .then(() => this.replaceSerialized(stream, serialized));

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
      return (await readJsonlFile(this.streamPath(stream), stream)).records as Record[];
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

  async append(stream: string, record: unknown): Promise<void> {
    assertStreamName(stream);
    const storedRecord = JSON.parse(serializeRecord(record)) as unknown;
    const records = this.streams.get(stream) ?? [];
    records.push(storedRecord);
    this.streams.set(stream, records);
  }

  async replace(
    stream: string,
    records: readonly unknown[],
  ): Promise<void> {
    assertStreamName(stream);
    this.streams.set(
      stream,
      records.map(
        (record) => JSON.parse(serializeRecord(record)) as unknown,
      ),
    );
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
