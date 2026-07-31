import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractAuthorUrlFromHub,
  extractProfileImageUrl,
  isValidSherdogScorerPhotoFilename,
  normalizeScorerName,
  SHERDOG_DEFAULT_AVATAR_URL,
  SHERDOG_SCORER_PHOTOS_API_PREFIX,
  SherdogScorerProfileStore,
} from "./sherdogScorerProfiles.ts";
import { MemoryStorage } from "./storage.ts";
import authorProfilesFixtureJson from "../src/fixtures/sherdogAuthorProfiles.json" with { type: "json" };

const authorProfilesFixture = authorProfilesFixtureJson as {
  authorPages: Record<string, string>;
};

const TEST_PHOTO_DIRECTORY =
  "./data/sherdog-scorer-photos-test-tmp";

function fakeImageFetchImpl(
  calls: { url: string }[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    calls.push({ url: String(input) });
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  }) as unknown as typeof fetch;
}

function createStore(
  overrides: Partial<
    ConstructorParameters<typeof SherdogScorerProfileStore>[0]
  > = {},
) {
  const storage = overrides.storage ?? new MemoryStorage();
  return new SherdogScorerProfileStore({
    storage,
    dataMode: "fixture",
    permissionScope: "sherdog-read",
    dataDirectory: TEST_PHOTO_DIRECTORY,
    ...overrides,
  });
}

describe("normalizeScorerName", () => {
  it("lowercases, collapses whitespace, and trims", () => {
    expect(normalizeScorerName("  Ben   Duffy ")).toBe("ben duffy");
    expect(normalizeScorerName("Ben Duffy")).toBe("ben duffy");
  });
});

describe("extractAuthorUrlFromHub", () => {
  const hub = `<div class='authors'><a href='/authors/Ben-Duffy-1649'>Ben Duffy</a></div>`;

  it("finds a matching author URL", () => {
    expect(
      extractAuthorUrlFromHub(hub, "Ben Duffy", "https://www.sherdog.com"),
    ).toBe("https://www.sherdog.com/authors/Ben-Duffy-1649");
  });

  it("is case/whitespace insensitive", () => {
    expect(
      extractAuthorUrlFromHub(
        hub,
        "  ben   DUFFY ",
        "https://www.sherdog.com",
      ),
    ).toBe("https://www.sherdog.com/authors/Ben-Duffy-1649");
  });

  it("returns undefined for a name absent from the hub", () => {
    expect(
      extractAuthorUrlFromHub(hub, "Tyler Treese", "https://www.sherdog.com"),
    ).toBeUndefined();
  });
});

describe("extractProfileImageUrl", () => {
  it("prefers the profile_image img over og:image", () => {
    const html = authorProfilesFixture.authorPages["Ben-Duffy-1649"] ?? "";
    const url = extractProfileImageUrl(html, "https://www.sherdog.com");
    expect(url).toBe(
      "https://www.sherdog.com/image_crop/72/72/_images/authors/20260730103503_avsq2026.JPG",
    );
  });

  it("resolves the generic placeholder as a real (if generic) photo", () => {
    const html = authorProfilesFixture.authorPages["Dayne-Fox-1728"] ?? "";
    const url = extractProfileImageUrl(html, "https://www.sherdog.com");
    expect(url).toBe(
      "https://www.sherdog.com/image_crop/72/72/img/default_300x300.jpg",
    );
  });

  it("falls back to og:image when there is no profile_image img", () => {
    const html = `<meta property="og:image" content="/foo.jpg"><body></body>`;
    expect(
      extractProfileImageUrl(html, "https://www.sherdog.com"),
    ).toBe("https://www.sherdog.com/foo.jpg");
  });

  it("returns undefined when neither is present", () => {
    expect(
      extractProfileImageUrl("<html><body>nothing</body></html>", "https://www.sherdog.com"),
    ).toBeUndefined();
  });
});

describe("isValidSherdogScorerPhotoFilename", () => {
  it("accepts a plain slug filename", () => {
    expect(isValidSherdogScorerPhotoFilename("ben-duffy.jpg")).toBe(true);
  });

  it("rejects path traversal and malformed input", () => {
    expect(isValidSherdogScorerPhotoFilename("../../etc/passwd")).toBe(false);
    expect(isValidSherdogScorerPhotoFilename("ben duffy.jpg")).toBe(false);
    expect(isValidSherdogScorerPhotoFilename("ben-duffy.exe")).toBe(false);
    expect(isValidSherdogScorerPhotoFilename("ben-duffy")).toBe(false);
    expect(isValidSherdogScorerPhotoFilename("/etc/passwd")).toBe(false);
    expect(isValidSherdogScorerPhotoFilename("ben-duffy.jpg/../x")).toBe(
      false,
    );
  });
});

describe("SherdogScorerProfileStore (fixture mode)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await rm(TEST_PHOTO_DIRECTORY, { recursive: true, force: true });
  });

  it("resolves a scorer found on the hub with a real photo", async () => {
    const calls: { url: string }[] = [];
    const store = createStore({ fetchImpl: fakeImageFetchImpl(calls) });

    const profile = await store.resolveScorerProfile("Ben Duffy");

    expect(profile.resolved).toBe(true);
    expect(profile.scorerName).toBe("Ben Duffy");
    expect(profile.normalizedName).toBe("ben duffy");
    expect(profile.authorPageUrl).toBe(
      "https://www.sherdog.com/authors/Ben-Duffy-1649",
    );
    expect(profile.photoUrl.startsWith(SHERDOG_SCORER_PHOTOS_API_PREFIX)).toBe(
      true,
    );
    expect(calls).toHaveLength(1);
  });

  it("resolves Jay Pettry with a real photo", async () => {
    const store = createStore({ fetchImpl: fakeImageFetchImpl() });
    const profile = await store.resolveScorerProfile("Jay Pettry");
    expect(profile.resolved).toBe(true);
    expect(profile.authorPageUrl).toBe(
      "https://www.sherdog.com/authors/Jay-Pettry-1657",
    );
  });

  it("treats Dayne Fox's generic Sherdog placeholder photo as a successful resolution", async () => {
    const store = createStore({ fetchImpl: fakeImageFetchImpl() });
    const profile = await store.resolveScorerProfile("Dayne Fox");

    expect(profile.resolved).toBe(true);
    expect(profile.authorPageUrl).toBe(
      "https://www.sherdog.com/authors/Dayne-Fox-1728",
    );
    expect(profile.photoUrl.startsWith(SHERDOG_SCORER_PHOTOS_API_PREFIX)).toBe(
      true,
    );
  });

  it("falls back to the default avatar and logs when the author can't be found", async () => {
    const calls: { url: string }[] = [];
    const store = createStore({ fetchImpl: fakeImageFetchImpl(calls) });

    const profile = await store.resolveScorerProfile("Tyler Treese");

    expect(profile.resolved).toBe(false);
    expect(profile.authorPageUrl).toBeNull();
    expect(profile.photoUrl).toBe(SHERDOG_DEFAULT_AVATAR_URL);
    expect(calls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("Tyler Treese");
  });

  it("is idempotent: a second call returns the cached record without re-fetching", async () => {
    const calls: { url: string }[] = [];
    const store = createStore({ fetchImpl: fakeImageFetchImpl(calls) });

    const first = await store.resolveScorerProfile("Ben Duffy");
    expect(calls).toHaveLength(1);
    const second = await store.resolveScorerProfile("Ben Duffy");
    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("does not create duplicate records for names differing only in whitespace/case", async () => {
    const storage = new MemoryStorage();
    const store = createStore({
      storage,
      fetchImpl: fakeImageFetchImpl(),
    });

    await store.resolveScorerProfile("Ben Duffy");
    await store.resolveScorerProfile("  ben   duffy ");

    expect(store.list()).toHaveLength(1);
    const records = await storage.read("sherdog-scorer-profiles");
    expect(records).toHaveLength(1);
  });

  it("dedups concurrent calls for the same not-yet-cached name", async () => {
    const calls: { url: string }[] = [];
    const store = createStore({ fetchImpl: fakeImageFetchImpl(calls) });

    const [first, second] = await Promise.all([
      store.resolveScorerProfile("Ben Duffy"),
      store.resolveScorerProfile("Ben Duffy"),
    ]);

    expect(calls).toHaveLength(1);
    expect(first).toEqual(second);
  });

  it("restores cached profiles from storage on a fresh instance", async () => {
    const storage = new MemoryStorage();
    const store1 = createStore({ storage, fetchImpl: fakeImageFetchImpl() });
    await store1.resolveScorerProfile("Ben Duffy");

    const calls: { url: string }[] = [];
    const store2 = await SherdogScorerProfileStore.create({
      storage,
      dataMode: "fixture",
      permissionScope: "sherdog-read",
      dataDirectory: TEST_PHOTO_DIRECTORY,
      fetchImpl: fakeImageFetchImpl(calls),
    });
    const profile = await store2.resolveScorerProfile("Ben Duffy");
    expect(profile.resolved).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("SherdogScorerProfileStore (live mode integration)", () => {
  afterEach(async () => {
    await rm(TEST_PHOTO_DIRECTORY, { recursive: true, force: true });
  });

  it("uses fetchSherdogPage/fetchSherdogImageBytes against injected fetchImpl", async () => {
    const hubHtml = `<div class='authors'><a href='/authors/Ben-Duffy-1649'>Ben Duffy</a></div>`;
    const authorHtml = `<img src="/photo.jpg" class="profile_image" alt="Ben Duffy" />`;
    const requestedUrls: string[] = [];

    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === "https://www.sherdog.com/") {
        return new Response(hubHtml, { status: 200 });
      }
      if (url === "https://www.sherdog.com/authors/Ben-Duffy-1649") {
        return new Response(authorHtml, { status: 200 });
      }
      if (url === "https://www.sherdog.com/photo.jpg") {
        return new Response(new Uint8Array([9, 9, 9]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const store = createStore({
      dataMode: "live",
      fetchImpl,
    });

    const profile = await store.resolveScorerProfile("Ben Duffy");
    expect(profile.resolved).toBe(true);
    expect(profile.authorPageUrl).toBe(
      "https://www.sherdog.com/authors/Ben-Duffy-1649",
    );
    expect(requestedUrls).toEqual([
      "https://www.sherdog.com/",
      "https://www.sherdog.com/authors/Ben-Duffy-1649",
      "https://www.sherdog.com/photo.jpg",
    ]);
  });

  it("throws on construction-independent permission gate when resolving without scope", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const store = createStore({
      dataMode: "live",
      permissionScope: "none",
      fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    });

    const profile = await store.resolveScorerProfile("Ben Duffy");
    expect(profile.resolved).toBe(false);
    expect(profile.photoUrl).toBe(SHERDOG_DEFAULT_AVATAR_URL);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
