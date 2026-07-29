import { describe, expect, it, vi } from "vitest";
import {
  createLiveSherdogFetcher,
  type SherdogFetcher,
} from "./sherdogJobs.ts";

const TEST_URL = "https://sherdog.example.invalid/news/news/live-card";
const TEST_HTML = "<article><h3>Round 1</h3><p>Round commentary</p></article>";

function createFetcher(
  fetchImpl: typeof fetch,
  options: Partial<Parameters<typeof createLiveSherdogFetcher>[0]> = {},
): SherdogFetcher {
  return createLiveSherdogFetcher({
    permissionScope: "sherdog-read",
    resolveBoutUrl: () => TEST_URL,
    fetchImpl,
    ...options,
  });
}

describe("createLiveSherdogFetcher", () => {
  it.each(["none", "analytics", "x-read"])(
    "refuses construction for the unrelated %s permission scope",
    (permissionScope) => {
      expect(() =>
        createLiveSherdogFetcher({
          permissionScope,
          resolveBoutUrl: () => TEST_URL,
          fetchImpl: vi.fn() as unknown as typeof fetch,
        }),
      ).toThrow("permission scope does not allow live-blog reads");
    },
  );

  it.each(["live-blog-read", "sherdog-read", "all"])(
    "constructs for the permitting %s scope",
    (permissionScope) => {
      expect(() =>
        createLiveSherdogFetcher({
          permissionScope,
          resolveBoutUrl: () => TEST_URL,
          fetchImpl: vi.fn() as unknown as typeof fetch,
        }),
      ).not.toThrow();
    },
  );

  it("requests the URL resolved from the bout's Sherdog external ref", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        new Response(TEST_HTML, { status: 200 }),
      );
    const resolveBoutUrl = vi.fn(() => "/news/news/live-card");
    const fetcher = createLiveSherdogFetcher({
      permissionScope: "live-blog-read",
      resolveBoutUrl,
      baseUrl: "https://sherdog.example.invalid",
      fetchImpl,
    });

    await expect(fetcher.fetchBout("bout-123", "round")).resolves.toEqual({
      status: 200,
      html: TEST_HTML,
      sourceUrl: TEST_URL,
    });
    expect(resolveBoutUrl).toHaveBeenCalledWith("bout-123");
    expect(fetchImpl).toHaveBeenCalledWith(
      TEST_URL,
      expect.objectContaining({
        headers: {
          "User-Agent":
            "UFC Live Dashboard/1.0 (personal non-commercial dashboard)",
        },
      }),
    );
  });

  it("does not request a bout without a Sherdog external ref", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const fetcher = createFetcher(fetchImpl, {
      resolveBoutUrl: () => undefined,
    });

    await expect(fetcher.fetchBout("unmapped-bout", "round")).rejects.toThrow(
      "has no mapped live-blog URL",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the same static identifying User-Agent on every request", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        new Response(TEST_HTML, { status: 200 }),
      );
    const fetcher = createFetcher(fetchImpl);

    await fetcher.fetchBout("bout-123", "round");
    await fetcher.fetchBout("bout-123", "final");

    const userAgents = fetchImpl.mock.calls.map(
      ([, init]) => new Headers(init?.headers).get("User-Agent"),
    );
    expect(userAgents).toEqual([
      "UFC Live Dashboard/1.0 (personal non-commercial dashboard)",
      "UFC Live Dashboard/1.0 (personal non-commercial dashboard)",
    ]);
  });

  it("propagates HTTP 403 without making a second request", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("forbidden", { status: 403 }));
    const fetcher = createFetcher(fetchImpl);

    await expect(fetcher.fetchBout("bout-123", "round")).resolves.toMatchObject({
      status: 403,
      sourceUrl: TEST_URL,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized body before a parser can receive it", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("12345", { status: 200 }));
    const fetcher = createFetcher(fetchImpl, { maxBytes: 4 });

    await expect(fetcher.fetchBout("bout-123", "round")).rejects.toThrow(
      "maximum response size",
    );
  });

  it("surfaces a timeout as a failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const fetcher = createFetcher(fetchImpl, { timeoutMs: 5 });

    await expect(fetcher.fetchBout("bout-123", "round")).rejects.toThrow(
      "timed out",
    );
  });
});
