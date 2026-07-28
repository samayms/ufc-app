import { describe, expect, it, vi } from "vitest";
import { createXSource } from "./x.ts";

const configured = {
  boutId: "bout-main",
  sourcePostId: "1234567890",
  scorer: "MMAJunkie",
  round: 1,
  score: { red: 10, blue: 9 },
  postUrl: "https://x.com/MMAJunkie/status/1234567890",
};
const embed = {
  boutId: "bout-main",
  postId: "1234567890",
  scorer: "MMAJunkie",
  round: 1,
};

describe("createXSource", () => {
  it("produces nothing in disabled mode", async () => {
    const source = createXSource({
      mode: "disabled",
      embeds: [embed],
      manualScores: [configured],
    });

    expect(source.configuredScores("bout-main", 1)).toEqual([]);
    expect(source.configuredEmbeds()).toEqual([]);
    await expect(source.fetchApiScores("bout-main", 1)).resolves.toEqual(
      [],
    );
  });

  it("exposes only configured post IDs in embed mode", () => {
    const source = createXSource({
      mode: "embed",
      embeds: [
        embed,
        embed,
        {
          ...embed,
          boutId: "bout-other",
          postId: "999",
        },
      ],
    });

    expect(source.configuredScores("bout-main", 1)).toEqual([]);
    expect(
      source.configuredEmbeds("bout-main").map((embed) => embed.postId),
    ).toEqual(["1234567890"]);
    expect(
      source.configuredEmbeds("bout-main").some(
        (embed) => embed.postId === "999",
      ),
    ).toBe(false);
  });

  it("passes configured scorer links through as manual entries", () => {
    const source = createXSource({
      mode: "manual",
      manualScores: [configured],
    });

    expect(source.configuredScores("bout-main", 1)).toEqual([
      expect.objectContaining({
        sourcePostId: "1234567890",
        mode: "manual",
        postUrl: configured.postUrl,
        parseConfidence: 1,
      }),
    ]);
    expect(source.configuredEmbeds()).toEqual([]);
  });

  it("fails closed without a bearer token and validates API payloads", async () => {
    expect(() => createXSource({ mode: "api" })).toThrow(
      /bearer token/i,
    );
    const apiFetcher = vi.fn(async () => [
      configured,
      configured,
      { ...configured, sourcePostId: "not-a-post-id" },
    ]);
    const source = createXSource({
      mode: "api",
      bearerToken: "secret",
      apiFetcher,
      now: () => "2026-07-28T00:00:40Z",
    });

    await expect(source.fetchApiScores("bout-main", 1)).resolves.toEqual([
      expect.objectContaining({
        sourcePostId: "1234567890",
        mode: "api",
        fetchedAt: "2026-07-28T00:00:40Z",
      }),
    ]);
    expect(apiFetcher).toHaveBeenCalledWith({
      boutId: "bout-main",
      round: 1,
      bearerToken: "secret",
    });
  });
});
