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

/**
 * The length the prompt actually asks for. Models count words far better than
 * they count characters, and asking in characters produced summaries a third
 * shorter than the box: 246 and 253 against a stated 300 floor. At roughly
 * 5.8 characters a word these bracket the character budget above.
 */
export const ROUND_SUMMARY_MIN_WORDS = 52;
export const ROUND_SUMMARY_MAX_WORDS = 62;

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

  const scoreless = dashed
    // A judge's scorecard number the model restated despite rule 8 (e.g.
    // "10-9 Coria" or "30-27"). Strip the score token and, when a fighter or
    // corner name immediately follows it, that too, then close up whatever
    // punctuation and whitespace it leaves behind.
    .replace(/\b\d{1,2}-\d{1,2}\b(\s+[A-Z][\p{L}'-]*)?/gu, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([,.!?;:)])/g, "$1")
    .replace(/([([])\s+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/,\s*,+/g, ",")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/^[\s,]+/, "")
    .trim();

  return scoreless.length <= ROUND_SUMMARY_MAX_CHARS
    ? scoreless
    : truncateToBudget(scoreless);
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
    `1. Length: four or five sentences, ${ROUND_SUMMARY_MIN_WORDS} to ${ROUND_SUMMARY_MAX_WORDS} words. Use the space; a two or three sentence answer leaves the box half empty. The hard ceiling is ${ROUND_SUMMARY_MAX_CHARS} characters, and the dashboard cuts off anything past it, so do not run beyond ${ROUND_SUMMARY_MAX_WORDS} words.`,
    `2. Never use an em dash or an en dash. Use commas, semicolons, or separate sentences instead. This is a hard requirement.`,
    `3. Write plain prose in one paragraph. No markdown, no bullet points, no headings, no quotation marks around the whole answer, no preamble like "Here is the summary".`,
    `4. Use only what the play-by-play states. Never invent strikes, takedowns, knockdowns, damage, or scores. If the round was short or the detail is thin, write a shorter summary rather than padding it.`,
    `5. Refer to the fighters by surname.`,
    `6. Present tense, neutral reporting voice. No hype, no second-person address, no speculation about later rounds.`,
    `7. Lead with what decided the round: knockdowns, takedowns, control, damage, or the clearest sustained advantage. Close with who got the better of the round when the play-by-play supports it.`,
    `8. Do not restate the judges' numeric scores.`,
    `9. Summarize only what happens between the horns. The play-by-play often runs past the end of the fight into the scorecards being read, the post-fight interview, callouts, title talk, and the writer signing off. Ignore all of it.`,
    `10. A first round often opens with scene setting: records, rankings, the referee's name, how the fighters got here. That is context, not action. Do not spend the summary on it.`,
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
