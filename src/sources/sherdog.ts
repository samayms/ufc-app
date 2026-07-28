import liveBlogFixture from "../fixtures/sherdog.json" with { type: "json" };
import type { Bout, Corner, RoundUpdate } from "../schema.ts";
import type {
  RoundCommentarySource,
  SourceConfig,
} from "./contract.ts";

interface LiveBlogEntry {
  html: string;
}

const boutEntries: Record<string, LiveBlogEntry> =
  liveBlogFixture.boutEntries;

/** The live blog's own score line: read for the score, excluded from prose. */
const SCORE_LINE = /Sherdog scores the round/i;

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'");
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
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

function parseRoundUpdates(html: string, bout: Bout): RoundUpdate[] {
  const headingPattern = /<h[1-6][^>]*>\s*Round\s+(\d+)\s*<\/h[1-6]>/gi;
  const headings = [...html.matchAll(headingPattern)];

  return headings
    .map((heading, index): RoundUpdate => {
      const round = Number(heading[1]);
      const blockStart = (heading.index ?? 0) + heading[0].length;
      const blockEnd = headings[index + 1]?.index ?? html.length;
      const roundHtml = html.slice(blockStart, blockEnd);
      const paragraphs = [...roundHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
        .map((match) => stripTags(match[1] ?? ""))
        .filter(Boolean);
      const scoreText = paragraphs.find((paragraph) =>
        SCORE_LINE.test(paragraph),
      );
      const summary = paragraphs.find(
        (paragraph) => !SCORE_LINE.test(paragraph),
      );
      const score = scoreText ? scoreForBout(scoreText, bout) : undefined;
      const update: RoundUpdate = {
        boutId: bout.id,
        round,
        provenance: {
          source: "sherdog",
          fetchedAt: liveBlogFixture.fetchedAt,
          synthetic: true,
        },
      };

      if (summary) {
        update.summary = summary;
      }

      if (score) {
        update.score = score;
      }

      return update;
    })
    .sort((left, right) => left.round - right.round);
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
      return entry ? parseRoundUpdates(entry.html, bout) : [];
    },
  };
}
