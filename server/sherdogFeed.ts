import { SHERDOG_MAX_PAYLOAD_BYTES } from "../src/sources/sherdog.ts";

export const SHERDOG_NEWS_FEED_PATH = "/rss/news.xml";

export interface SherdogNewsItem {
  title: string;
  url: string;
  publishedAt?: string;
}

export interface FetchSherdogNewsFeedOptions {
  permissionScope: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
}

function decodeXml(value: string): string {
  return value
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/u, "$1")
    .replace(/&#(\d+);/gu, (_match, digits: string) =>
      String.fromCodePoint(Number(digits)),
    )
    .replace(/&#x([0-9a-f]+);/giu, (_match, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 16)),
    )
    .replace(/&apos;/gu, "'")
    .replace(/&quot;/gu, '"')
    .replace(/&gt;/gu, ">")
    .replace(/&lt;/gu, "<")
    .replace(/&amp;/gu, "&")
    .trim();
}

function readTag(block: string, tag: string): string | undefined {
  const match = block.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "iu"),
  );
  return match?.[1] === undefined ? undefined : decodeXml(match[1]);
}

export function parseSherdogNewsFeed(xml: string): SherdogNewsItem[] {
  const items: SherdogNewsItem[] = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/giu)) {
    const block = match[1];
    if (block === undefined) continue;
    const title = readTag(block, "title");
    const url = readTag(block, "link");
    if (title === undefined || url === undefined) continue;
    const publishedAt = readTag(block, "pubDate");
    items.push({
      title,
      url,
      ...(publishedAt === undefined ? {} : { publishedAt }),
    });
  }
  return items;
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

export function fighterSurname(name: string): string | undefined {
  const suffixes = new Set(["jr", "sr", "ii", "iii", "iv"]);
  const tokens = normalizeSearchText(name).split(/\s+/u).filter(Boolean);
  while (tokens.length > 0 && suffixes.has(tokens.at(-1) ?? "")) {
    tokens.pop();
  }
  return tokens.at(-1);
}

export function eventTokenScore(eventName: string, candidate: string): number {
  const ignored = new Set([
    "ufc",
    "fight",
    "night",
    "on",
    "espn",
    "vs",
    "the",
  ]);
  const candidateTokens = new Set(normalizeSearchText(candidate).split(/\s+/u));
  return normalizeSearchText(eventName)
    .split(/\s+/u)
    .filter((token) => token.length >= 3 && !ignored.has(token))
    .reduce(
      (score, token) => score + (candidateTokens.has(token) ? 1 : 0),
      0,
    );
}

function permissionAllowsSherdogRead(scope: string): boolean {
  const permissions = new Set(
    scope
      .toLocaleLowerCase("en-US")
      .split(/[\s,]+/u)
      .filter(Boolean),
  );
  return (
    permissions.has("live-blog-read") ||
    permissions.has("sherdog-read") ||
    permissions.has("all")
  );
}

async function readWithByteLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("Sherdog news feed exceeded the maximum response size");
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Sherdog news feed exceeded the maximum response size");
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export async function fetchSherdogNewsFeed(
  options: FetchSherdogNewsFeedOptions,
): Promise<SherdogNewsItem[]> {
  if (!permissionAllowsSherdogRead(options.permissionScope)) {
    throw new Error(
      "SHERDOG_PERMISSION_SCOPE must include live-blog-read, sherdog-read, or all",
    );
  }

  const baseUrl = options.baseUrl ?? "https://www.sherdog.com";
  const feedUrl = new URL(SHERDOG_NEWS_FEED_PATH, baseUrl);
  if (feedUrl.protocol !== "http:" && feedUrl.protocol !== "https:") {
    throw new TypeError("Sherdog base URL must use HTTP or HTTPS");
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? SHERDOG_MAX_PAYLOAD_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Sherdog discovery timeout must be positive");
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new TypeError("Sherdog discovery maximum response size must be positive");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(feedUrl, {
      signal: controller.signal,
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml",
        "User-Agent":
          options.userAgent ??
          "UFC Live Dashboard/1.0 (personal non-commercial dashboard)",
      },
    });
    if (!response.ok) {
      throw new Error(`Sherdog news feed responded ${response.status}`);
    }
    const xml = await readWithByteLimit(response, maxBytes);
    return parseSherdogNewsFeed(xml);
  } finally {
    clearTimeout(timeout);
  }
}
