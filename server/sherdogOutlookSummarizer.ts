import {
  FIGHT_OUTLOOK_MAX_CHARS,
  buildFightOutlookPrompt,
  enforceFightOutlookSummary,
  type RawPreviewInput,
} from "../src/sources/fightOutlook.ts";
import { DEFAULT_GEMINI_MODEL } from "./geminiSummarizer.ts";

export interface FightOutlookSummarizer {
  /** Returns the outlook paragraph, or an empty string when none could be produced. */
  summarize(input: RawPreviewInput): Promise<string>;
}

export interface LiveFightOutlookSummarizerOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Roughly four characters per token, plus headroom, so the model is never cut
 * off mid-sentence before `enforceFightOutlookSummary` sees the text.
 */
const MAX_OUTPUT_TOKENS = Math.ceil(FIGHT_OUTLOOK_MAX_CHARS / 3) + 64;

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
 * Summarizing is decorative: a failed call just leaves `Bout.outlook`
 * undefined and the UI falls back to its placeholder. So every failure path
 * returns an empty string rather than throwing, mirroring
 * `createLiveGeminiSummarizer`'s philosophy for round summaries.
 */
export function createLiveFightOutlookSummarizer(
  options: LiveFightOutlookSummarizerOptions,
): FightOutlookSummarizer {
  const apiKey = options.apiKey.trim();
  if (apiKey.length === 0) {
    throw new TypeError("Fight outlook summarizer requires an API key");
  }
  const model = options.model?.trim() || DEFAULT_GEMINI_MODEL;
  const baseUrl = options.baseUrl?.trim() || DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const endpoint = `${baseUrl}/models/${model}:generateContent`;

  return {
    async summarize(input) {
      if (input.rawPreviewText.trim().length === 0) return "";

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
              { role: "user", parts: [{ text: buildFightOutlookPrompt(input) }] },
            ],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
            },
          }),
        });
        if (!response.ok) return "";
        return enforceFightOutlookSummary(candidateText(await response.json()));
      })();

      try {
        // Raced rather than left to the abort signal alone, so a transport
        // that ignores the signal still cannot hold up the import job.
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
export function createDisabledFightOutlookSummarizer(): FightOutlookSummarizer {
  return {
    async summarize() {
      return "";
    },
  };
}
