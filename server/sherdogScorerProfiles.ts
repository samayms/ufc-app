import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sherdogAuthorProfilesFixtureJson from "../src/fixtures/sherdogAuthorProfiles.json" with { type: "json" };
import type { SherdogScorerProfile } from "../src/schema.ts";
import { SHERDOG_MAX_PAYLOAD_BYTES } from "../src/sources/sherdog.ts";
import {
  fetchSherdogPage,
  permissionAllowsSherdogRead,
} from "./sherdogFeed.ts";
import type { Storage } from "./storage.ts";

/**
 * Resolves and caches, per named Sherdog round-scorer, their author-page
 * profile photo — so the photo is fetched once and reused across events
 * rather than re-fetched on every round observation. See project notes for
 * the live-site research this module is built against: author pages live at
 * unpredictable numeric-id URLs discoverable only via bylines that already
 * link to them (there is no name-based author search on Sherdog), so
 * discovery works by scanning the homepage's recent-article bylines for a
 * matching name.
 */

const sherdogAuthorProfilesFixture = sherdogAuthorProfilesFixtureJson as {
  authorPages: Record<string, string>;
};

const sherdogAuthorHubFixture = readFileSync(
  fileURLToPath(
    new URL("../src/fixtures/sherdogAuthorHub.html", import.meta.url),
  ),
  "utf8",
);

export const SHERDOG_SCORER_PROFILES_STORAGE_STREAM =
  "sherdog-scorer-profiles";
export const DEFAULT_SHERDOG_SCORER_PHOTOS_DIRECTORY =
  "./data/sherdog-scorer-photos";
export const SHERDOG_SCORER_PHOTOS_API_PREFIX =
  "/api/sherdog-scorer-photos/";
/**
 * Vite-bundled asset (see `src/assets/sherdog-default-avatar.svg`). Served by
 * the Vite dev/build origin, not by the collector — a plain string constant
 * here can only point at where Vite serves project-root files from in dev;
 * production consumers should prefer importing the asset directly (see
 * `src/ui/ScorecardFeed.tsx`) rather than trusting this string cross-origin.
 */
export const SHERDOG_DEFAULT_AVATAR_URL =
  "/src/assets/sherdog-default-avatar.svg";

const DEFAULT_THROTTLE_MS = 1_000;

export function normalizeScorerName(name: string): string {
  return name
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}

function slugifyNormalizedName(normalizedName: string): string {
  const slug = normalizedName
    .replace(/\s+/gu, "-")
    .replace(/[^a-z0-9-]/gu, "");
  return slug.length > 0 ? slug : "scorer";
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Minimum-gap-between-requests throttle for outbound Sherdog HTTP calls.
 * Deliberately standalone (not coupled to the round job's `quota` object)
 * since profile resolution can be triggered from tests/scripts outside that
 * job context too. Calls are also serialized: a second `wait()` queued while
 * one is already pending waits for its turn rather than racing it.
 */
export class SherdogRequestThrottle {
  private readonly minGapMs: number;

  private readonly now: () => number;

  private readonly sleep: (ms: number) => Promise<void>;

  private lastAcquiredAt: number | undefined;

  private chain: Promise<void> = Promise.resolve();

  constructor(
    options: {
      minGapMs?: number;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.minGapMs = options.minGapMs ?? DEFAULT_THROTTLE_MS;
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async wait(): Promise<void> {
    const turn = this.chain.then(() => this.acquire());
    this.chain = turn.catch(() => undefined);
    await turn;
  }

  private async acquire(): Promise<void> {
    const now = this.now();
    if (this.lastAcquiredAt !== undefined) {
      const elapsed = now - this.lastAcquiredAt;
      if (elapsed < this.minGapMs) {
        await this.sleep(this.minGapMs - elapsed);
      }
    }
    this.lastAcquiredAt = this.now();
  }
}

/**
 * Regex-scans a Sherdog "hub" page (the homepage's recent-article bylines,
 * in fixture mode; a live fetch of the same page otherwise) for the byline
 * pattern `<div class='authors'><a href='/authors/Slug-Id'>Visible Name</a>`
 * — note the single-quoted attributes, unlike most of the site's HTML — and
 * returns the matching author page URL, or `undefined` if this name isn't
 * linkable from this particular hub snapshot (expected: the homepage is a
 * rotating snapshot, not an exhaustive directory).
 */
export function extractAuthorUrlFromHub(
  hubHtml: string,
  name: string,
  baseUrl: string,
): string | undefined {
  const target = normalizeScorerName(name);
  for (const match of hubHtml.matchAll(
    /<a href='\/authors\/([^']+)'>([^<]+)<\/a>/gu,
  )) {
    const slug = match[1];
    const visibleName = match[2];
    if (slug === undefined || visibleName === undefined) continue;
    if (normalizeScorerName(decodeHtmlEntities(visibleName)) === target) {
      return new URL(`/authors/${slug}`, baseUrl).toString();
    }
  }
  return undefined;
}

function extractAttribute(tag: string, attribute: string): string | undefined {
  const match = tag.match(
    new RegExp(`${attribute}\\s*=\\s*["']([^"']*)["']`, "iu"),
  );
  return match?.[1];
}

/**
 * Extracts the author's profile photo URL from their Sherdog author-page
 * HTML: prefers the `class="profile_image"` `<img>` (more specific — some
 * authors have no personal photo and Sherdog serves its own generic
 * placeholder there, which still counts as a successful resolution), falls
 * back to the `og:image` meta tag. Resolves relative URLs against `baseUrl`.
 */
export function extractProfileImageUrl(
  authorPageHtml: string,
  baseUrl: string,
): string | undefined {
  const imgTags = authorPageHtml.match(/<img\b[^>]*>/giu) ?? [];
  const profileImageTag = imgTags.find((tag) =>
    /class\s*=\s*["'][^"']*\bprofile_image\b[^"']*["']/iu.test(tag),
  );
  const profileImageSrc =
    profileImageTag === undefined
      ? undefined
      : extractAttribute(profileImageTag, "src");
  if (profileImageSrc !== undefined && profileImageSrc.trim().length > 0) {
    return new URL(profileImageSrc, baseUrl).toString();
  }

  const ogImageMatch = authorPageHtml.match(
    /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["'][^>]*>/iu,
  );
  const ogImageContent = ogImageMatch?.[1];
  if (ogImageContent !== undefined && ogImageContent.trim().length > 0) {
    return new URL(ogImageContent, baseUrl).toString();
  }

  return undefined;
}

async function readBytesWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error("Sherdog image exceeded the maximum response size");
    }
    return buffer;
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
      throw new Error("Sherdog image exceeded the maximum response size");
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export interface SherdogImageFetchOptions {
  permissionScope: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
}

export interface SherdogImageFetchResult {
  bytes: Uint8Array;
  contentType?: string;
}

/**
 * Binary counterpart to `fetchSherdogPage`: same permission-gate/timeout/
 * byte-cap courtesy posture, but reads bytes rather than decoded text. Used
 * to download a scorer's profile photo. Returns `undefined` on a non-2xx
 * response rather than throwing, matching `fetchSherdogPage`'s posture.
 */
export async function fetchSherdogImageBytes(
  url: string,
  options: SherdogImageFetchOptions,
): Promise<SherdogImageFetchResult | undefined> {
  if (!permissionAllowsSherdogRead(options.permissionScope)) {
    throw new Error(
      "SHERDOG_PERMISSION_SCOPE must include live-blog-read, sherdog-read, or all",
    );
  }

  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new TypeError("Sherdog image URL must use HTTP or HTTPS");
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? SHERDOG_MAX_PAYLOAD_BYTES;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(
      parsedUrl,
      {
        signal: controller.signal,
        headers: {
          "User-Agent":
            options.userAgent ??
            "UFC Live Dashboard/1.0 (personal non-commercial dashboard)",
        },
      },
    );
    if (!response.ok) return undefined;
    const bytes = await readBytesWithLimit(response, maxBytes);
    const contentType = response.headers.get("content-type") ?? undefined;
    return { bytes, ...(contentType === undefined ? {} : { contentType }) };
  } finally {
    clearTimeout(timeout);
  }
}

const IMAGE_EXTENSIONS_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

function inferImageExtension(
  url: string,
  contentType: string | undefined,
): string {
  try {
    const fromUrl = extname(new URL(url).pathname)
      .replace(/^\./u, "")
      .toLocaleLowerCase("en-US");
    if (["jpg", "jpeg", "png", "gif", "webp"].includes(fromUrl)) {
      return fromUrl === "jpeg" ? "jpg" : fromUrl;
    }
  } catch {
    // fall through to content-type inference
  }
  const base = contentType?.split(";")[0]?.trim().toLocaleLowerCase("en-US");
  return (base !== undefined && IMAGE_EXTENSIONS_BY_CONTENT_TYPE[base]) || "jpg";
}

/** Fixture-mode default: never touches the network, returns fake image bytes. */
function createFixturePhotoFetchImpl(): typeof fetch {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const stub = (async () =>
    new Response(bytes, {
      status: 200,
      headers: { "content-type": "image/png" },
    })) as unknown as typeof fetch;
  return stub;
}

/** Extracts the trailing `/authors/<slug>` path segment from an author page URL. */
function authorSlugFromUrl(authorPageUrl: string): string | undefined {
  try {
    const path = new URL(authorPageUrl).pathname;
    const match = path.match(/\/authors\/([^/]+)\/?$/u);
    return match?.[1];
  } catch {
    return undefined;
  }
}

interface PersistedSherdogScorerProfile {
  version: 1;
  value: SherdogScorerProfile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProfile(value: unknown): value is SherdogScorerProfile {
  return (
    isRecord(value) &&
    typeof value.scorerName === "string" &&
    typeof value.normalizedName === "string" &&
    (value.authorPageUrl === null ||
      typeof value.authorPageUrl === "string") &&
    typeof value.photoUrl === "string" &&
    typeof value.resolved === "boolean" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isPersisted(
  value: unknown,
): value is PersistedSherdogScorerProfile {
  return isRecord(value) && value.version === 1 && isProfile(value.value);
}

export interface SherdogScorerProfileStoreOptions {
  storage: Storage;
  dataMode: "fixture" | "live";
  permissionScope: string;
  baseUrl?: string;
  hubUrl?: string;
  fetchImpl?: typeof fetch;
  throttleMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  dataDirectory?: string;
  now?: () => string;
}

/**
 * Caches one resolved (or default-avatar-fallback) profile per normalized
 * scorer name, keyed by `normalizedName`, restored from `storage` on init —
 * the same restore-on-startup pattern `SherdogRoundJobs` uses.
 */
export class SherdogScorerProfileStore {
  private readonly storage: Storage;

  private readonly dataMode: "fixture" | "live";

  private readonly permissionScope: string;

  private readonly baseUrl: string;

  private readonly hubUrl: string;

  private readonly fetchImpl: typeof fetch;

  private readonly throttle: SherdogRequestThrottle;

  private readonly timeoutMs: number | undefined;

  private readonly maxBytes: number | undefined;

  private readonly userAgent: string | undefined;

  private readonly dataDirectory: string;

  private readonly clockNow: () => string;

  private readonly profiles = new Map<string, SherdogScorerProfile>();

  private readonly inFlight = new Map<string, Promise<SherdogScorerProfile>>();

  private restorePromise: Promise<void> | undefined;

  constructor(options: SherdogScorerProfileStoreOptions) {
    this.storage = options.storage;
    this.dataMode = options.dataMode;
    this.permissionScope = options.permissionScope;
    this.baseUrl = options.baseUrl ?? "https://www.sherdog.com";
    this.hubUrl = options.hubUrl ?? new URL("/", this.baseUrl).toString();
    this.fetchImpl =
      options.fetchImpl ??
      (this.dataMode === "fixture"
        ? createFixturePhotoFetchImpl()
        : globalThis.fetch);
    this.throttle = new SherdogRequestThrottle({
      minGapMs: options.throttleMs,
    });
    this.timeoutMs = options.timeoutMs;
    this.maxBytes = options.maxBytes;
    this.userAgent = options.userAgent;
    this.dataDirectory =
      options.dataDirectory ?? DEFAULT_SHERDOG_SCORER_PHOTOS_DIRECTORY;
    this.clockNow = options.now ?? (() => new Date().toISOString());
  }

  static async create(
    options: SherdogScorerProfileStoreOptions,
  ): Promise<SherdogScorerProfileStore> {
    const store = new SherdogScorerProfileStore(options);
    await store.restore();
    return store;
  }

  async restore(): Promise<void> {
    this.restorePromise ??= this.restoreFromStorage();
    await this.restorePromise;
  }

  private async restoreFromStorage(): Promise<void> {
    const records = await this.storage.read<unknown>(
      SHERDOG_SCORER_PROFILES_STORAGE_STREAM,
    );
    this.profiles.clear();
    for (const record of records) {
      if (!isPersisted(record)) continue;
      this.profiles.set(record.value.normalizedName, record.value);
    }
  }

  list(): SherdogScorerProfile[] {
    return [...this.profiles.values()].sort((left, right) =>
      left.normalizedName.localeCompare(right.normalizedName),
    );
  }

  getCached(scorerName: string): SherdogScorerProfile | undefined {
    return this.profiles.get(normalizeScorerName(scorerName));
  }

  /**
   * Main entry point: idempotent per normalized name. A cached record
   * (success or previously-failed/default-avatar) is returned with no
   * network call. Concurrent calls for the same not-yet-cached name share
   * one discovery/download sequence via `inFlight`.
   */
  async resolveScorerProfile(
    scorerName: string,
  ): Promise<SherdogScorerProfile> {
    await this.restore();
    const normalizedName = normalizeScorerName(scorerName);
    const cached = this.profiles.get(normalizedName);
    if (cached !== undefined) return cached;

    const pending = this.inFlight.get(normalizedName);
    if (pending !== undefined) return pending;

    const promise = this.resolveAndPersist(
      scorerName,
      normalizedName,
    ).finally(() => {
      this.inFlight.delete(normalizedName);
    });
    this.inFlight.set(normalizedName, promise);
    return promise;
  }

  private async discoverAuthorPageUrlInternal(
    scorerName: string,
  ): Promise<string | undefined> {
    if (this.dataMode === "fixture") {
      return extractAuthorUrlFromHub(
        sherdogAuthorHubFixture,
        scorerName,
        this.baseUrl,
      );
    }
    const hubs = [
      this.hubUrl,
      new URL("/contact.php", this.baseUrl).toString(),
      new URL("/Article", this.baseUrl).toString(),
    ];
    for (const hubUrl of [...new Set(hubs)]) {
      const hub = await fetchSherdogPage(hubUrl, {
        permissionScope: this.permissionScope,
        fetchImpl: this.fetchImpl,
        ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
        ...(this.maxBytes === undefined ? {} : { maxBytes: this.maxBytes }),
        ...(this.userAgent === undefined ? {} : { userAgent: this.userAgent }),
      });
      if (hub.status < 200 || hub.status >= 300) continue;
      const authorUrl = extractAuthorUrlFromHub(hub.html, scorerName, this.baseUrl);
      if (authorUrl !== undefined) return authorUrl;
      await this.throttle.wait();
    }
    return undefined;
  }

  private async fetchAuthorPageHtml(
    authorPageUrl: string,
  ): Promise<string | undefined> {
    if (this.dataMode === "fixture") {
      const slug = authorSlugFromUrl(authorPageUrl);
      return slug === undefined
        ? undefined
        : sherdogAuthorProfilesFixture.authorPages[slug];
    }
    const page = await fetchSherdogPage(authorPageUrl, {
      permissionScope: this.permissionScope,
      fetchImpl: this.fetchImpl,
      ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
      ...(this.maxBytes === undefined ? {} : { maxBytes: this.maxBytes }),
      ...(this.userAgent === undefined ? {} : { userAgent: this.userAgent }),
    });
    if (page.status < 200 || page.status >= 300) return undefined;
    return page.html;
  }

  private async downloadPhoto(
    normalizedName: string,
    remotePhotoUrl: string,
  ): Promise<string | undefined> {
    const fetched = await fetchSherdogImageBytes(remotePhotoUrl, {
      permissionScope: this.permissionScope,
      fetchImpl: this.fetchImpl,
      ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
      ...(this.maxBytes === undefined ? {} : { maxBytes: this.maxBytes }),
      ...(this.userAgent === undefined ? {} : { userAgent: this.userAgent }),
    });
    if (fetched === undefined || fetched.bytes.byteLength === 0) {
      return undefined;
    }
    const extension = inferImageExtension(remotePhotoUrl, fetched.contentType);
    const filename = `${slugifyNormalizedName(normalizedName)}.${extension}`;
    await mkdir(this.dataDirectory, { recursive: true });
    await writeFile(join(this.dataDirectory, filename), fetched.bytes);
    return `${SHERDOG_SCORER_PHOTOS_API_PREFIX}${filename}`;
  }

  private async resolveAndPersist(
    scorerName: string,
    normalizedName: string,
  ): Promise<SherdogScorerProfile> {
    let authorPageUrl: string | undefined;
    let storedPhotoUrl: string | undefined;
    let resolved = false;

    try {
      await this.throttle.wait();
      authorPageUrl = await this.discoverAuthorPageUrlInternal(scorerName);
      if (authorPageUrl === undefined) {
        console.warn(
          `Sherdog scorer profile: could not find an author page for "${scorerName}" on the hub page; using the default avatar`,
        );
      } else {
        const authorHtml = await this.fetchAuthorPageHtml(authorPageUrl);
        if (authorHtml === undefined) {
          console.warn(
            `Sherdog scorer profile: could not fetch the author page for "${scorerName}" (${authorPageUrl}); using the default avatar`,
          );
        } else {
          const remotePhotoUrl = extractProfileImageUrl(
            authorHtml,
            this.baseUrl,
          );
          if (remotePhotoUrl === undefined) {
            console.warn(
              `Sherdog scorer profile: no photo found on the author page for "${scorerName}" (${authorPageUrl}); using the default avatar`,
            );
          } else {
            storedPhotoUrl = await this.downloadPhoto(
              normalizedName,
              remotePhotoUrl,
            );
            if (storedPhotoUrl === undefined) {
              console.warn(
                `Sherdog scorer profile: could not download the photo for "${scorerName}" (${remotePhotoUrl}); using the default avatar`,
              );
            } else {
              resolved = true;
            }
          }
        }
      }
    } catch (error) {
      console.warn(
        `Sherdog scorer profile: resolution failed for "${scorerName}": ${errorText(error)}; using the default avatar`,
      );
    }

    const now = this.clockNow();
    const existing = this.profiles.get(normalizedName);
    const record: SherdogScorerProfile = {
      scorerName,
      normalizedName,
      authorPageUrl: authorPageUrl ?? null,
      photoUrl:
        resolved && storedPhotoUrl !== undefined
          ? storedPhotoUrl
          : SHERDOG_DEFAULT_AVATAR_URL,
      resolved,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.storage.append(SHERDOG_SCORER_PROFILES_STORAGE_STREAM, {
      version: 1,
      value: record,
    } satisfies PersistedSherdogScorerProfile);
    this.profiles.set(normalizedName, record);
    return record;
  }
}

/** Strict allowlist for the `GET /api/sherdog-scorer-photos/:filename` route — no path traversal. */
export const SHERDOG_SCORER_PHOTO_FILENAME_PATTERN =
  /^[a-z0-9-]+\.(?:jpg|jpeg|png|gif|webp)$/u;

export function isValidSherdogScorerPhotoFilename(
  filename: string,
): boolean {
  return SHERDOG_SCORER_PHOTO_FILENAME_PATTERN.test(filename);
}
