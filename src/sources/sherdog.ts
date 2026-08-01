import liveBlogFixture from "../fixtures/sherdog.json" with { type: "json" };
import type {
  Bout,
  Corner,
  RoundUpdate,
  SherdogRoundObservation,
  SherdogScorerCard,
} from "../schema.ts";
import type {
  RoundCommentarySource,
  SourceConfig,
} from "./contract.ts";

interface LiveBlogEntry {
  html: string;
}

interface SherdogFixture {
  boutEntries: Record<string, LiveBlogEntry>;
  fetchedAt: string;
  publishedAt?: string;
  sourceUrl: string;
}

export interface SherdogParserInput {
  boutId: string;
  html: string;
  sourceUrl: string;
  fetchedAt: string;
  publishedAt?: string;
  /**
   * Names of the two fighters, used to pick this bout's block out of a page
   * that carries the whole card. Omit only when the HTML is already scoped to
   * one bout.
   */
  fighterNames?: { red: string; blue: string };
}

export const parserVersion = "sherdog-live-blog-v4";
export const SHERDOG_MAX_PAYLOAD_BYTES = 1_000_000;
export const SHERDOG_MAX_COMMENTARY_LENGTH = 20_000;

const fixture = liveBlogFixture as SherdogFixture;
const boutEntries: Record<string, LiveBlogEntry> =
  fixture.boutEntries;

/**
 * A scorer's line: read for the score, excluded from prose. The live page
 * scores each round on a named writer's line ("Ben Duffy scores the round:
 * 10-9 Coria"); the older shape credits Sherdog itself.
 */
const SCORE_LINE = /\bscores?\s+the\s+round\b/i;

/** The heading that introduces the scorer lines; not prose, not a score. */
const SCORE_HEADING = /^Sherdog Scores$/i;

/** Splits markup on the boundaries the live page uses between text lines. */
const LINE_BOUNDARY =
  /(?:<br\s*\/?>|<\/?(?:p|div|h[1-6]|li|ul|ol|blockquote)\b[^>]*>)/gi;

/** One bout's section of a full-card page. */
const EVENT_BLOCK_START = /<div\b[^>]*\bclass="[^"]*\bevent\b[^"]*"[^>]*>/gi;

const ROUND_HEADING = /<h[1-6][^>]*>\s*Round\s+(\d+)\s*<\/h[1-6]>/gi;

/**
 * A round runs to the next round, to a sibling heading such as "The Official
 * Result", or to the end of the bout — but not to the `<h4>` that introduces
 * the scorer lines, which belong to the round being read.
 */
function roundBlockEnd(
  html: string,
  blockStart: number,
  nextRoundIndex: number | undefined,
): number {
  const sibling = /<h[1-3]\b/i.exec(html.slice(blockStart));
  const siblingIndex =
    sibling === undefined || sibling === null
      ? html.length
      : blockStart + sibling.index;
  return Math.min(nextRoundIndex ?? html.length, siblingIndex);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

export function sanitizeExternalText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(?:script|style|template)\b[^>]*>[\s\S]*?<\/(?:script|style|template)>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SHERDOG_MAX_COMMENTARY_LENGTH);
}

function lastName(name: string): string {
  return name.trim().split(/\s+/).at(-1) ?? "";
}

function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]/gu, "")
    .toLocaleLowerCase("en");
}

/**
 * Whether a scorer's winner label names this fighter. Cards abbreviate to a
 * surname, and a surname can be several words ("Du Plessis"), so a suffix of
 * the full name counts — but only one long enough to be unambiguous, which
 * keeps a truncated "Du" from resolving to a corner.
 */
export function fighterNameMatches(
  fighterName: string,
  candidate: string,
): boolean {
  const target = normalizeName(candidate);
  if (target.length === 0) return false;
  const full = normalizeName(fighterName);
  return (
    target === full ||
    target === normalizeName(lastName(fighterName)) ||
    (target.length >= 4 && full.endsWith(target))
  );
}

function scoreForBout(
  scoreText: string,
  bout: Bout,
): Record<Corner, number> | undefined {
  const card = parseScorerCard(scoreText);
  const roundScore = card?.roundScore?.split("-");
  if (card?.winner === undefined || roundScore === undefined) {
    return undefined;
  }

  const highScore = Number(roundScore[0]);
  const lowScore = Number(roundScore[1]);
  const scoredCorner = (["red", "blue"] as const).find((corner) =>
    fighterNameMatches(bout.fighters[corner].name, card.winner ?? ""),
  );

  if (!scoredCorner) {
    return undefined;
  }

  return scoredCorner === "red"
    ? { red: highScore, blue: lowScore }
    : { red: lowScore, blue: highScore };
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Splits one bout's section out of a page that carries the whole card. Pages
 * already scoped to a single bout have no event blocks, so they are returned
 * whole; a page with blocks but no match for these fighters yields nothing.
 */
function selectBoutBlock(
  html: string,
  fighterNames: { red: string; blue: string },
): string | undefined {
  const starts = [...html.matchAll(EVENT_BLOCK_START)];
  if (starts.length === 0) return html;

  const red = normalizeName(lastName(fighterNames.red));
  const blue = normalizeName(lastName(fighterNames.blue));
  if (red.length === 0 || blue.length === 0) return undefined;

  for (const [index, start] of starts.entries()) {
    const blockStart = (start.index ?? 0) + start[0].length;
    const blockEnd = starts[index + 1]?.index ?? html.length;
    const block = html.slice(blockStart, blockEnd);
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block);
    if (!heading) continue;
    const headingText = normalizeName(sanitizeExternalText(heading[1] ?? ""));
    if (headingText.includes(red) && headingText.includes(blue)) {
      return block;
    }
  }

  return undefined;
}

/**
 * The live page separates commentary, the scores heading, and each scorer's
 * line with `<br>` and headings rather than wrapping them in elements, so
 * lines are recovered from those boundaries instead of from `<p>` contents.
 */
function textLines(html: string): string[] {
  return html
    .split(LINE_BOUNDARY)
    .map((line) => sanitizeExternalText(line))
    .filter((line) => line.length > 0 && !SCORE_HEADING.test(line));
}

function parseScorerCard(scoreText: string): SherdogScorerCard | undefined {
  const match =
    /(?<scorer>Sherdog|[^.]{1,80}?)\s+scores?(?:\s+the)?\s+round\s*:?\s*(?<high>\d+)\s*-\s*(?<low>\d+)\s+(?<winner>[\p{Letter}\p{Mark}'’-]+(?:[ \t]+[\p{Letter}\p{Mark}'’-]+){0,2})/iu.exec(
      scoreText,
    );
  if (!match?.groups) return undefined;
  const scorePairs = [
    ...scoreText.matchAll(/\b(\d+)\s*-\s*(\d+)\b/g),
  ];
  const cumulative = scorePairs[1];

  return {
    scorer: sanitizeExternalText(match.groups.scorer ?? "Sherdog"),
    winner: sanitizeExternalText(match.groups.winner ?? ""),
    roundScore: `${match.groups.high}-${match.groups.low}`,
    ...(cumulative === undefined
      ? {}
      : {
          cumulativeScore: `${cumulative[1]}-${cumulative[2]}`,
        }),
  };
}

/**
 * Parses every round block, including Sherdog's empty pre-fight placeholders.
 * Boundary polling uses these hashes as a bout-local baseline; normal callers
 * should use parseSherdogRoundObservations(), which returns reported rounds.
 */
export async function parseSherdogRoundSnapshots(
  input: SherdogParserInput,
): Promise<SherdogRoundObservation[]> {
  if (
    input.boutId.trim().length === 0 ||
    input.sourceUrl.trim().length === 0 ||
    !Number.isFinite(Date.parse(input.fetchedAt)) ||
    (input.publishedAt !== undefined &&
      !Number.isFinite(Date.parse(input.publishedAt)))
  ) {
    throw new TypeError("Sherdog parser requires valid identity, URL, and timestamps");
  }
  if (new TextEncoder().encode(input.html).byteLength > SHERDOG_MAX_PAYLOAD_BYTES) {
    throw new RangeError("Sherdog payload exceeds the maximum response size");
  }

  const scoped =
    input.fighterNames === undefined
      ? input.html
      : selectBoutBlock(input.html, input.fighterNames);
  if (scoped === undefined) return [];

  const headings = [...scoped.matchAll(ROUND_HEADING)];
  const observations = await Promise.all(
    headings.map(async (heading, index): Promise<SherdogRoundObservation | null> => {
      const round = Number(heading[1]);
      if (!Number.isSafeInteger(round) || round < 1 || round > 5) return null;
      const blockStart = (heading.index ?? 0) + heading[0].length;
      const roundHtml = scoped.slice(
        blockStart,
        roundBlockEnd(scoped, blockStart, headings[index + 1]?.index),
      );
      const lines = textLines(roundHtml);
      const scoreTexts = lines.filter((line) => SCORE_LINE.test(line));
      const commentary = sanitizeExternalText(
        lines.filter((line) => !SCORE_LINE.test(line)).join(" "),
      );
      const scorerCards = scoreTexts
        .map(parseScorerCard)
        .filter((card): card is SherdogScorerCard => card !== undefined);

      return {
        boutId: input.boutId,
        round,
        commentary,
        scorerCards,
        sourceUrl: input.sourceUrl,
        ...(input.publishedAt === undefined
          ? {}
          : { publishedAt: input.publishedAt }),
        fetchedAt: input.fetchedAt,
        parserVersion,
        payloadHash: await sha256(roundHtml),
      };
    }),
  );

  return observations
    .filter(
      (observation): observation is SherdogRoundObservation =>
        observation !== null,
    )
    .sort((left, right) => left.round - right.round);
}

export async function parseSherdogRoundObservations(
  input: SherdogParserInput,
): Promise<SherdogRoundObservation[]> {
  return (await parseSherdogRoundSnapshots(input)).filter(
    // Sherdog pre-renders every future round with empty scorer lines. A
    // heading alone is therefore not evidence that the round was reported.
    // Commentary also keeps finish rounds valid, since a bout that ends
    // inside the round has no 10-9 cards.
    (observation) =>
      observation.commentary.length > 0 ||
      observation.scorerCards.length > 0,
  );
}

async function parseRoundUpdates(html: string, bout: Bout): Promise<RoundUpdate[]> {
  const observations = await parseSherdogRoundObservations({
    boutId: bout.id,
    html,
    sourceUrl: fixture.sourceUrl,
    fetchedAt: fixture.fetchedAt,
    ...(fixture.publishedAt === undefined
      ? {}
      : { publishedAt: fixture.publishedAt }),
  });
  const headingPattern = /<h[1-6][^>]*>\s*Round\s+(\d+)\s*<\/h[1-6]>/gi;
  const headings = [...html.matchAll(headingPattern)];
  return observations.map((observation): RoundUpdate => {
      const headingIndex = headings.findIndex(
        (heading) => Number(heading[1]) === observation.round,
      );
      const heading = headings[headingIndex];
      const blockStart =
        heading === undefined ? 0 : (heading.index ?? 0) + heading[0].length;
      const blockEnd = headings[headingIndex + 1]?.index ?? html.length;
      const scoreText = sanitizeExternalText(
        html.slice(blockStart, blockEnd),
      );
      const score = scoreText ? scoreForBout(scoreText, bout) : undefined;
      const update: RoundUpdate = {
        boutId: bout.id,
        round: observation.round,
        provenance: {
          source: "sherdog",
          fetchedAt: observation.fetchedAt,
          synthetic: true,
        },
      };

      if (observation.commentary) {
        update.summary = observation.commentary;
      }

      if (score) {
        update.score = score;
      }

      return update;
    });
}

export function createSherdogSource(
  config: SourceConfig,
): RoundCommentarySource {
  if (config.mode === "live") {
    return {
      async getRoundUpdates() {
        return [];
      },
    };
  }

  return {
    async getRoundUpdates(bout: Bout): Promise<RoundUpdate[]> {
      const entry = boutEntries[bout.id];
      return entry ? await parseRoundUpdates(entry.html, bout) : [];
    },
  };
}
