declare module "node:fs/promises" {
  export interface DirectoryEntry {
    name: string;
    isFile(): boolean;
  }

  export function appendFile(
    path: string,
    data: string,
    encoding: "utf8",
  ): Promise<void>;

  export function mkdir(
    path: string,
    options: { recursive: true },
  ): Promise<string | undefined>;

  export function mkdtemp(prefix: string): Promise<string>;

  export function readFile(path: string, encoding: "utf8"): Promise<string>;

  export function readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<DirectoryEntry[]>;

  export function rm(
    path: string,
    options: { recursive: true; force: true },
  ): Promise<void>;

  export function truncate(path: string, length: number): Promise<void>;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
}

declare module "node:http" {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    on(event: "close", listener: () => void): this;
  }

  export interface ServerResponse {
    readonly headersSent: boolean;
    writeHead(
      statusCode: number,
      headers?: Record<string, string>,
    ): this;
    flushHeaders(): void;
    write(chunk: string): boolean;
    end(chunk?: string): void;
    on(event: "close", listener: () => void): this;
  }

  export interface AddressInfo {
    port: number;
  }

  export interface Server {
    readonly listening: boolean;
    listen(port: number, hostname: string): this;
    close(callback: (error?: Error) => void): this;
    address(): AddressInfo | string | null;
    once(event: "error", listener: (error: Error) => void): this;
    once(event: "listening", listener: () => void): this;
    off(event: "error", listener: (error: Error) => void): this;
    off(event: "listening", listener: () => void): this;
  }

  export function createServer(
    listener: (
      request: IncomingMessage,
      response: ServerResponse,
    ) => void,
  ): Server;
}

declare module "node:url" {
  export function pathToFileURL(path: string): URL;
}

declare const process: {
  env: Readonly<Record<string, string | undefined>>;
  argv: string[];
  exitCode?: number;
};
