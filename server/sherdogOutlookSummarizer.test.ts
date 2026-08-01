import { describe, expect, it, vi } from "vitest";
import { FIGHT_OUTLOOK_MAX_CHARS } from "../src/sources/fightOutlook.ts";
import {
  createDisabledFightOutlookSummarizer,
  createLiveFightOutlookSummarizer,
} from "./sherdogOutlookSummarizer.ts";

const input = {
  redName: "Uros Medic",
  blueName: "Daniel Rodriguez",
  weightClass: "Welterweight",
  titleFight: false,
  rawPreviewText:
    "Medic brings heavy hands and looks to end this early. Rodriguez wants " +
    "to drag this into deep water and grind it out.",
};

function geminiResponse(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

describe("createLiveFightOutlookSummarizer", () => {
  it("refuses construction without an API key", () => {
    expect(() =>
      createLiveFightOutlookSummarizer({
        apiKey: "  ",
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).toThrow("requires an API key");
  });

  it("sends the key in the header, never the query string", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(geminiResponse("Medic takes this on volume."));
    const summarizer = createLiveFightOutlookSummarizer({
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
      .mockResolvedValue(geminiResponse("Medic takes this on volume."));
    const summarizer = createLiveFightOutlookSummarizer({
      apiKey: "test-key",
      model: "gemini-test-model",
      fetchImpl,
    });

    await summarizer.summarize(input);

    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "models/gemini-test-model:generateContent",
    );
  });

  it("sends the bout and the raw preview text as the prompt", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(geminiResponse("Medic takes this on volume."));
    const summarizer = createLiveFightOutlookSummarizer({
      apiKey: "test-key",
      fetchImpl,
    });

    await summarizer.summarize(input);

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.contents[0].parts[0].text).toContain(input.rawPreviewText);
    expect(body.contents[0].parts[0].text).toContain("Uros Medic");
    expect(body.contents[0].parts[0].text).toContain("Welterweight");
  });

  it("enforces the budget on whatever the model returns", async () => {
    const overlong = "Medic lands a clean left hand and circles away. ".repeat(
      20,
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(geminiResponse(overlong));
    const summarizer = createLiveFightOutlookSummarizer({
      apiKey: "test-key",
      fetchImpl,
    });

    const result = await summarizer.summarize(input);

    expect(result.length).toBeLessThanOrEqual(FIGHT_OUTLOOK_MAX_CHARS);
  });

  it("strips an em dash the model produced despite the instruction", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(geminiResponse("Medic presses — Rodriguez circles."));
    const summarizer = createLiveFightOutlookSummarizer({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(summarizer.summarize(input)).resolves.toBe(
      "Medic presses, Rodriguez circles.",
    );
  });

  it("returns nothing when the model is refused or rate limited", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("nope", { status: 429 }));
    const summarizer = createLiveFightOutlookSummarizer({
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
    const summarizer = createLiveFightOutlookSummarizer({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(summarizer.summarize(input)).resolves.toBe("");
  });

  it("returns nothing rather than throwing when the request fails", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network down"));
    const summarizer = createLiveFightOutlookSummarizer({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(summarizer.summarize(input)).resolves.toBe("");
  });

  it("gives up on a hung request instead of holding the import job", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      () => new Promise<Response>(() => {}),
    );
    const summarizer = createLiveFightOutlookSummarizer({
      apiKey: "test-key",
      fetchImpl,
      timeoutMs: 5,
    });

    await expect(summarizer.summarize(input)).resolves.toBe("");
  });

  it("does not call the model for a bout with no preview text", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const summarizer = createLiveFightOutlookSummarizer({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(
      summarizer.summarize({ ...input, rawPreviewText: "   " }),
    ).resolves.toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createDisabledFightOutlookSummarizer", () => {
  it("summarizes to nothing without any network call", async () => {
    await expect(
      createDisabledFightOutlookSummarizer().summarize(input),
    ).resolves.toBe("");
  });
});
