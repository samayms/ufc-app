import {
  ROUND_SUMMARY_MAX_CHARS,
  buildRoundSummaryPrompt,
  enforceRoundSummary,
  type RoundSummaryInput,
} from "../src/sources/roundSummary.ts";

export interface RoundSummarizer {
  /** Returns the summary, or an empty string when none could be produced. */
  summarize(input: RoundSummaryInput): Promise<string>;
}

export interface LiveGeminiSummarizerOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Roughly four characters per token, plus headroom, so the model is never cut
 * off mid-sentence before `enforceRoundSummary` sees the text.
 */
const MAX_OUTPUT_TOKENS = Math.ceil(ROUND_SUMMARY_MAX_CHARS / 3) + 64;

function candidateText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const parts = (
    candidates[0] as { content?: { parts?: unknown } } | undefined
  )?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) =>
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
}

/**
 * Summarizing is decorative: the raw play-by-play is already stored and shown
 * if this fails. So every failure path returns an empty string rather than
 * throwing, and none of them can fail a Sherdog round job.
 */
export function createLiveGeminiSummarizer(
  options: LiveGeminiSummarizerOptions,
): RoundSummarizer {
  const apiKey = options.apiKey.trim();
  if (apiKey.length === 0) {
    throw new TypeError("Gemini summarizer requires an API key");
  }
  const model = options.model?.trim() || DEFAULT_GEMINI_MODEL;
  const baseUrl = options.baseUrl?.trim() || DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const endpoint = `${baseUrl}/models/${model}:generateContent`;

  return {
    async summarize(input) {
      if (input.commentary.trim().length === 0) return "";

      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const request = (async (): Promise<string> => {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            contents: [
              { role: "user", parts: [{ text: buildRoundSummaryPrompt(input) }] },
            ],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
            },
          }),
        });
        if (!response.ok) return "";
        return enforceRoundSummary(candidateText(await response.json()));
      })();

      try {
        // Raced rather than left to the abort signal alone, so a transport that
        // ignores the signal still cannot hold up the round job.
        return await Promise.race([
          request,
          new Promise<string>((resolve) => {
            timeout = setTimeout(() => {
              controller.abort();
              resolve("");
            }, timeoutMs);
          }),
        ]);
      } catch {
        return "";
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  };
}

/** Used in fixture mode and whenever no key is configured. */
export function createDisabledSummarizer(): RoundSummarizer {
  return {
    async summarize() {
      return "";
    },
  };
}
