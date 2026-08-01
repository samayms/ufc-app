/**
 * Fight-outlook prompt and post-processing: the pre-fight analog of
 * `roundSummary.ts`. Same box, same failure philosophy (decorative text; a
 * failed summarization just leaves the placeholder up), different budget —
 * validated by hand against real Gemini output on two real bouts from this
 * card, both landing at 397-398 chars / 55-62 words.
 */

export const FIGHT_OUTLOOK_MIN_WORDS = 50;
export const FIGHT_OUTLOOK_MAX_WORDS = 68;
export const FIGHT_OUTLOOK_MAX_CHARS = 460;
export const FIGHT_OUTLOOK_MIN_CHARS = 320;

export interface RawPreviewInput {
  redName: string;
  blueName: string;
  weightClass: string;
  titleFight: boolean;
  rawPreviewText: string;
}

/**
 * Normalizes model output into the plain prose the dashboard expects: no em
 * dashes, no markdown, and never longer than the clamp can show. Mirrors
 * `enforceRoundSummary`'s dash-stripping/markdown-stripping/truncate-to-last-
 * sentence behavior against the fight-outlook budget.
 */
export function enforceFightOutlookSummary(text: string): string {
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

  return dashed.length <= FIGHT_OUTLOOK_MAX_CHARS
    ? dashed
    : truncateToBudget(dashed);
}

/**
 * Cuts to the last complete sentence that fits, falling back to a whole word
 * when a single sentence overruns the budget on its own.
 */
function truncateToBudget(text: string): string {
  const window = text.slice(0, FIGHT_OUTLOOK_MAX_CHARS + 1);
  const lastSentence = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
  );
  if (lastSentence > 0) {
    return window.slice(0, lastSentence + 1).trim();
  }

  const clipped = text.slice(0, FIGHT_OUTLOOK_MAX_CHARS - 1);
  const lastSpace = clipped.lastIndexOf(" ");
  const body = (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped)
    .replace(/[\s,;:]+$/, "")
    .trim();
  return body.endsWith(".") ? body : `${body}.`;
}

export function buildFightOutlookPrompt(input: RawPreviewInput): string {
  return [
    `You are writing the pre-fight outlook shown on a private UFC dashboard, for one viewer previewing the card before it starts.`,
    ``,
    `Bout: ${input.redName} (red corner) vs ${input.blueName} (blue corner), ${input.weightClass}${input.titleFight ? ", title fight" : ""}.`,
    ``,
    `Below is Sherdog's written preview of this fight, by a beat reporter. Condense it into a single paragraph a viewer can read at a glance before the fight begins.`,
    ``,
    `Rules:`,
    `1. Length: four to six sentences, ${FIGHT_OUTLOOK_MIN_WORDS} to ${FIGHT_OUTLOOK_MAX_WORDS} words. Use the space; a short answer leaves the box half empty. The hard ceiling is ${FIGHT_OUTLOOK_MAX_CHARS} characters, and the dashboard cuts off anything past it, so do not run beyond ${FIGHT_OUTLOOK_MAX_WORDS} words.`,
    `2. Never use an em dash or an en dash. Use commas, semicolons, or separate sentences instead. This is a hard requirement.`,
    `3. Write plain prose in one paragraph. No markdown, no bullet points, no headings, no quotation marks around the whole answer, no preamble like "Here is the outlook".`,
    `4. Use only what the preview states. Never invent records, rankings, injuries, or storylines not in the text.`,
    `5. Refer to fighters by surname.`,
    `6. Present tense, neutral analyst voice. No hype, no second-person address.`,
    `7. Lead with the stylistic matchup: each fighter's game and how the styles clash. Close with the writer's stated pick or expected path to victory, if the preview gives one.`,
    `8. Do not restate the betting odds numbers; the dashboard already shows live odds elsewhere.`,
    `9. Ignore anything not about this specific fight: other bouts on the card, the writer's personal reflections, event history, or newsletter and ad content.`,
    ``,
    `Preview text:`,
    input.rawPreviewText,
    ``,
    `Return only the paragraph.`,
  ].join("\n");
}
