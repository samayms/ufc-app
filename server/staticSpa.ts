import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

export interface StaticSpaResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: string): void;
}

export interface ServeStaticSpaOptions {
  pathname: string;
  response: StaticSpaResponse;
  distDirectory?: string;
  read?: (path: string) => Promise<Uint8Array>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function send(response: StaticSpaResponse, status: number, path: string, body: Uint8Array): void {
  response.writeHead(status, {
    "Cache-Control": path.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    "Content-Length": String(body.byteLength),
    "Content-Type": contentType(path),
    "X-Content-Type-Options": "nosniff",
  });
  // Node's ServerResponse typings model end() narrowly as a string although
  // the runtime accepts Uint8Array/Buffer payloads for binary assets too.
  response.end(body as unknown as string);
}

function sendNotFound(response: StaticSpaResponse): void {
  response.writeHead(404, { "Content-Length": "0", "X-Content-Type-Options": "nosniff" });
  response.end();
}

/**
 * Serves a Vite-style dist directory and falls back to index.html for safe
 * extensionless SPA routes. Returns false only when no static response was
 * sent, allowing the collector to retain its existing JSON 404 behavior.
 */
export async function serveStaticSpa(options: ServeStaticSpaOptions): Promise<boolean> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(options.pathname);
  } catch {
    sendNotFound(options.response);
    return true;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    sendNotFound(options.response);
    return true;
  }

  const root = resolve(options.distDirectory ?? resolve(process.cwd(), "dist"));
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    sendNotFound(options.response);
    return true;
  }

  const read = options.read ?? readFile;
  try {
    send(options.response, 200, candidate, await read(candidate));
    return true;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  // Static assets must 404 when missing; only browser navigation paths may
  // receive the SPA shell.
  if (extname(relativePath) !== "") return false;
  const index = resolve(root, "index.html");
  try {
    send(options.response, 200, index, await read(index));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}
