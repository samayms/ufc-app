import type { SherdogScorerCard } from "../schema.ts";

/**
 * The dashboard renders a round summary in `.round-summary p`, which clamps to
 * five lines. At the phone width one line holds about 83 characters, so a
 * perfectly packed clamp is roughly 417. Prose never packs perfectly — word
 * wrap loses a few characters at the end of every line — so the ceiling is set
 * below that to guarantee the text is never cut off mid-thought by the clamp.
 */
export const ROUND_SUMMARY_LINE_CHARS = 83;
export const ROUND_SUMMARY_MAX_LINES = 5;

/** Hard ceiling: five lines of wrapped prose, with slack for the wrapping. */
export const ROUND_SUMMARY_MAX_CHARS = 380;

/** Floor that keeps a summary from shrinking to a single thin line. */
export const ROUND_SUMMARY_MIN_CHARS = 300;

export interface RoundSummaryInput {
  round: number;
  redName: string;
  blueName: string;
  commentary: string;
  scorerCards: readonly SherdogScorerCard[];
}

/**
 * Normalizes model output into the plain prose the dashboard expects: no em
 * dashes, no markdown, and never longer than the clamp can show.
 */
export function enforceRoundSummary(text: string): string {
  const flattened = text
    .replace(/\s+/g, " ")
    // Markdown emphasis and list markers the model may reach for.
    .replace(/\*\*|__|\*|`/g, "")
    .replace(/^\s*[-•]\s+/, "")
    .trim()
    // Surrounding quotes, straight or curly.
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();

  const dashed = flattened
    // A dash between digits is a scoreline, not punctuation.
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1-$2")
    .replace(/\s*(?:—|–|--)\s*/g, ", ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,+/g, ",")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  return dashed.length <= ROUND_SUMMARY_MAX_CHARS
    ? dashed
    : truncateToBudget(dashed);
}

/**
 * Cuts to the last complete sentence that fits, falling back to a whole word
 * when a single sentence overruns the budget on its own.
 */
function truncateToBudget(text: string): string {
  const window = text.slice(0, ROUND_SUMMARY_MAX_CHARS + 1);
  const lastSentence = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
  );
  if (lastSentence > 0) {
    return window.slice(0, lastSentence + 1).trim();
  }

  const clipped = text.slice(0, ROUND_SUMMARY_MAX_CHARS - 1);
  const lastSpace = clipped.lastIndexOf(" ");
  const body = (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped)
    .replace(/[\s,;:]+$/, "")
    .trim();
  return body.endsWith(".") ? body : `${body}.`;
}

function describeScorers(cards: readonly SherdogScorerCard[]): string {
  const described = cards
    .filter((card) => card.winner !== undefined)
    .map(
      (card) =>
        `${card.scorer} scored it ${card.roundScore ?? ""} for ${card.winner}`.replace(
          /\s+/g,
          " ",
        ),
    );
  return described.join("; ");
}

export function buildRoundSummaryPrompt(input: RoundSummaryInput): string {
  const scorers = describeScorers(input.scorerCards);

  return [
    `You are writing the round recap shown on a private UFC dashboard, for one viewer following the fight live.`,
    ``,
    `Bout: ${input.redName} (red corner) vs ${input.blueName} (blue corner).`,
    `Round ${input.round}.`,
    ``,
    `Below is the round's live play-by-play, written by a reporter watching the fight. Condense it into a single paragraph a viewer can read at a glance.`,
    ``,
    `Rules:`,
    `1. Length: between ${ROUND_SUMMARY_MIN_CHARS} and ${ROUND_SUMMARY_MAX_CHARS} characters. Never exceed ${ROUND_SUMMARY_MAX_CHARS}; the dashboard cuts off anything longer. Aim for the top of that range.`,
    `2. Never use an em dash or an en dash. Use commas, semicolons, or separate sentences instead. This is a hard requirement.`,
    `3. Write plain prose in one paragraph. No markdown, no bullet points, no headings, no quotation marks around the whole answer, no preamble like "Here is the summary".`,
    `4. Use only what the play-by-play states. Never invent strikes, takedowns, knockdowns, damage, or scores. If the round was short or the detail is thin, write a shorter summary rather than padding it.`,
    `5. Refer to the fighters by surname.`,
    `6. Present tense, neutral reporting voice. No hype, no second-person address, no speculation about later rounds.`,
    `7. Lead with what decided the round: knockdowns, takedowns, control, damage, or the clearest sustained advantage. Close with who got the better of the round when the play-by-play supports it.`,
    `8. Do not restate the judges' numeric scores.`,
    ...(scorers.length === 0
      ? []
      : [
          ``,
          `Ringside scorers read the round this way, as grounding for who came out ahead: ${scorers}.`,
        ]),
    ``,
    `Play-by-play:`,
    input.commentary,
    ``,
    `Return only the paragraph.`,
  ].join("\n");
}
