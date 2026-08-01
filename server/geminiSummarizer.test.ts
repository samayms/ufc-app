import { describe, expect, it, vi } from "vitest";
import { ROUND_SUMMARY_MAX_CHARS } from "../src/sources/roundSummary.ts";
import {
  createDisabledSummarizer,
  createLiveGeminiSummarizer,
} from "./geminiSummarizer.ts";

const input = {
  round: 2,
  redName: "Danilo Reyes",
  blueName: "Artem Volkov",
  commentary: "Volkov changes levels behind his jab and puts Reyes down.",
  scorerCards: [],
};

function geminiResponse(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

describe("createLiveGeminiSummarizer", () => {
  it("refuses construction without an API key", () => {
    expect(() =>
      createLiveGeminiSummarizer({
        apiKey: "  ",
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).toThrow("requires an API key");
  });

  it("sends the key in the header, never the query string", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(geminiResponse("Reyes takes the round."));
    const summarizer = createLiveGeminiSummarizer({
      apiKey: "test-key",
      fetchImpl,
    });

    await summarizer.summarize(input);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).not.toContain("test-key");
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("test-key");
  });

  it("asks the configured model", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(geminiResponse("Reyes takes the round."));
    const summarizer = createLiveGeminiSummarizer({
      apiKey: "test-key",
      model: "gemini-test-model",
      fetchImpl,
    });

    await summarizer.summarize(input);

    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "models/gemini-test-model:generateContent",
    );
  });

  it("sends the round's play-by-play as the prompt", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(geminiResponse("Reyes takes the round."));
    const summarizer = createLiveGeminiSummarizer({
      apiKey: "test-key",
      fetchImpl,
    });

    await summarizer.summarize(input);

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.contents[0].parts[0].text).toContain(input.commentary);
    expect(body.contents[0].parts[0].text).toContain("Round 2");
  });

  it("enforces the budget on whatever the model returns", async () => {
    const overlong = "Reyes lands a clean left hand and circles away. ".repeat(
      20,
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(geminiResponse(overlong));
    const summarizer = createLiveGeminiSummarizer({
      apiKey: "test-key",
      fetchImpl,
    });

    const result = await summarizer.summarize(input);

    expect(result.length).toBeLessThanOrEqual(ROUND_SUMMARY_MAX_CHARS);
  });

  it("strips an em dash the model produced despite the instruction", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(geminiResponse("Reyes presses — Volkov circles."));
    const summarizer = createLiveGeminiSummarizer({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(summarizer.summarize(input)).resolves.toBe(
      "Reyes presses, Volkov circles.",
    );
  });

  it("returns nothing when the model is refused or rate limited", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("nope", { status: 429 }));
    const summarizer = createLiveGeminiSummarizer({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(summarizer.summarize(input)).resolves.toBe("");
  });

  it("returns nothing when the response carries no candidate text", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
      );
    const summarizer = createLiveGeminiSummarizer({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(summarizer.summarize(input)).resolves.toBe("");
  });

  it("returns nothing rather than throwing when the request fails", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network down"));
    const summarizer = createLiveGeminiSummarizer({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(summarizer.summarize(input)).resolves.toBe("");
  });

  it("gives up on a hung request instead of holding the round job", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      () => new Promise<Response>(() => {}),
    );
    const summarizer = createLiveGeminiSummarizer({
      apiKey: "test-key",
      fetchImpl,
      timeoutMs: 5,
    });

    await expect(summarizer.summarize(input)).resolves.toBe("");
  });

  it("does not call the model for a round with no commentary", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const summarizer = createLiveGeminiSummarizer({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(
      summarizer.summarize({ ...input, commentary: "   " }),
    ).resolves.toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createDisabledSummarizer", () => {
  it("summarizes to nothing without any network call", async () => {
    await expect(createDisabledSummarizer().summarize(input)).resolves.toBe("");
  });
});
