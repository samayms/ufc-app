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
