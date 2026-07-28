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
}

export const parserVersion = "sherdog-live-blog-v2";
export const SHERDOG_MAX_PAYLOAD_BYTES = 1_000_000;
export const SHERDOG_MAX_COMMENTARY_LENGTH = 20_000;

const fixture = liveBlogFixture as SherdogFixture;
const boutEntries: Record<string, LiveBlogEntry> =
  fixture.boutEntries;

/** The live blog's own score line: read for the score, excluded from prose. */
const SCORE_LINE = /Sherdog scores the round/i;

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

function scoreForBout(
  scoreText: string,
  bout: Bout,
): Record<Corner, number> | undefined {
  const scoreMatch =
    /Sherdog scores the round\s+(\d+)\s*-\s*(\d+)\s+([^\s.,;:!?]+)/i.exec(
      scoreText,
    );

  if (!scoreMatch) {
    return undefined;
  }

  const highScore = Number(scoreMatch[1]);
  const lowScore = Number(scoreMatch[2]);
  const scoredLastName = normalizeName(scoreMatch[3] ?? "");
  const scoredCorner = (["red", "blue"] as const).find(
    (corner) =>
      normalizeName(lastName(bout.fighters[corner].name)) === scoredLastName,
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

function parseScorerCard(scoreText: string): SherdogScorerCard | undefined {
  const match =
    /(?<scorer>Sherdog|[^.]{1,80}?)\s+scores?(?:\s+the)?\s+round\s+(?<high>\d+)\s*-\s*(?<low>\d+)\s+(?<winner>[\p{Letter}\p{Mark}'’-]+)/iu.exec(
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

export async function parseSherdogRoundObservations(
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

  const headingPattern = /<h[1-6][^>]*>\s*Round\s+(\d+)\s*<\/h[1-6]>/gi;
  const headings = [...input.html.matchAll(headingPattern)];
  const observations = await Promise.all(
    headings.map(async (heading, index): Promise<SherdogRoundObservation | null> => {
      const round = Number(heading[1]);
      if (!Number.isSafeInteger(round) || round < 1 || round > 5) return null;
      const blockStart = (heading.index ?? 0) + heading[0].length;
      const blockEnd = headings[index + 1]?.index ?? input.html.length;
      const roundHtml = input.html.slice(blockStart, blockEnd);
      const paragraphs = [
        ...roundHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi),
      ]
        .map((match) => sanitizeExternalText(match[1] ?? ""))
        .filter(Boolean);
      const scoreTexts = paragraphs.filter((paragraph) =>
        SCORE_LINE.test(paragraph),
      );
      const commentary = sanitizeExternalText(
        paragraphs
          .filter((paragraph) => !SCORE_LINE.test(paragraph))
          .join(" "),
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
    throw new Error("sherdog live mode not available yet");
  }

  return {
    async getRoundUpdates(bout: Bout): Promise<RoundUpdate[]> {
      const entry = boutEntries[bout.id];
      return entry ? await parseRoundUpdates(entry.html, bout) : [];
    },
  };
}
