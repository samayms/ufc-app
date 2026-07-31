/**
 * Fetches a Sherdog fight-outlook (preview) article and splits it into one
 * write-up per bout, matched against the real card by fighter surname.
 *
 * The main card is paginated (page N of the article is the bout at
 * `cardPosition` N); the prelims run back to back on a single separate
 * article. Both shapes carry the same per-bout header:
 *   "<Weight class> <Fighter A> (<record>) vs. <Fighter B> (<record>) BETTING ODDS: ..."
 * followed by prose, ending right before a "Jump To »" navigation marker.
 * Verified live against the real UFC Belgrade preview articles, 2026-07-30/31.
 */
import type { Bout } from "../src/schema.ts";
import { sanitizeExternalText } from "../src/sources/sherdog.ts";
import {
  fetchSherdogPage,
  fighterSurname,
  type FetchSherdogPageOptions,
} from "./sherdogFeed.ts";

export interface SherdogPreviewSegment {
  weightClassText: string;
  fighterAName: string;
  fighterARecord: string;
  fighterBName: string;
  fighterBRecord: string;
  /** Header through prose, up to the next header or the "Jump To" marker. */
  rawText: string;
}

/**
 * Matches the per-bout header. Captures the weight class label and both
 * fighters' names/records so segments can be matched to a real `Bout`
 * without depending on page order.
 */
const HEADER_RE =
  /([A-Za-z ]+weights?) ([A-Z][a-zA-Z'.\- ]+)\((\d+-\d+(?:-\d+)?)\)\s*vs\.?\s*([A-Z][a-zA-Z'.\- ]+)\((\d+-\d+(?:-\d+)?)\)\s*BETTING ODDS:/gu;

const JUMP_TO_RE = /Jump To/iu;

/**
 * Splits one preview page (main-card page or the prelims article) into its
 * per-bout segments. Works on the sanitized plain-text rendering of the page
 * so the header regex doesn't have to reckon with markup.
 */
export function extractSherdogPreviewSegments(
  pageHtml: string,
): SherdogPreviewSegment[] {
  const text = sanitizeExternalText(pageHtml);
  const headers = [...text.matchAll(HEADER_RE)];
  if (headers.length === 0) return [];

  const jumpToIndex = JUMP_TO_RE.exec(text)?.index ?? text.length;

  const segments: SherdogPreviewSegment[] = [];
  for (const [index, match] of headers.entries()) {
    const start = match.index ?? 0;
    const nextStart = headers[index + 1]?.index ?? text.length;
    const end = Math.min(nextStart, jumpToIndex < start ? text.length : jumpToIndex);
    const rawText = text.slice(start, end).trim();
    if (rawText.length === 0) continue;
    segments.push({
      weightClassText: (match[1] ?? "").trim(),
      fighterAName: (match[2] ?? "").trim(),
      fighterARecord: match[3] ?? "",
      fighterBName: (match[4] ?? "").trim(),
      fighterBRecord: match[5] ?? "",
      rawText,
    });
  }
  return segments;
}

/**
 * Matches an extracted segment to the real `Bout` it describes, by fighter
 * surname, order-independent (the header may list the fighters in either
 * corner order relative to `Bout.fighters.red`/`blue`).
 */
export function matchSegmentToBout(
  segment: SherdogPreviewSegment,
  bouts: readonly Bout[],
): Bout | undefined {
  const segmentRed = fighterSurname(segment.fighterAName);
  const segmentBlue = fighterSurname(segment.fighterBName);
  if (segmentRed === undefined || segmentBlue === undefined) return undefined;
  const segmentSurnames = new Set([segmentRed, segmentBlue]);

  return bouts.find((bout) => {
    const redSurname = fighterSurname(bout.fighters.red.name);
    const blueSurname = fighterSurname(bout.fighters.blue.name);
    return (
      redSurname !== undefined &&
      blueSurname !== undefined &&
      segmentSurnames.has(redSurname) &&
      segmentSurnames.has(blueSurname)
    );
  });
}

/**
 * Sherdog's hard rule (documented in WEEKEND_RUNBOOK.md): a 403 means stop
 * immediately. No retries, no user-agent or proxy rotation.
 */
export class SherdogForbiddenError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(
      `Sherdog responded 403 Forbidden for ${url}; stopping per policy (no retries, no UA/proxy rotation)`,
    );
    this.name = "SherdogForbiddenError";
    this.url = url;
  }
}

/** Inserts a page number into a Sherdog article URL's path, e.g. page 2 of
 * `.../news/articles/Preview-Foo-123` becomes `.../news/articles/2/Preview-Foo-123`. */
export function withSherdogArticlePageNumber(
  articleUrl: string,
  page: number,
): string {
  const url = new URL(articleUrl);
  const marker = "/news/articles/";
  const markerIndex = url.pathname.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Unexpected Sherdog article URL shape: ${articleUrl}`);
  }
  const prefixEnd = markerIndex + marker.length;
  url.pathname = `${url.pathname.slice(0, prefixEnd)}${page}/${url.pathname.slice(prefixEnd)}`;
  return url.toString();
}

export interface SherdogOutlookMatch {
  bout: Bout;
  rawPreviewText: string;
}

export type FetchSherdogOutlookContentOptions = FetchSherdogPageOptions;

export interface CollectSherdogOutlookContentInput {
  /** The canonical (unpaginated) main-card preview article URL. */
  baseArticleUrl: string;
  /** Number of main-card bouts; pages 1..N are fetched. */
  mainCardBoutCount: number;
  /** The separate prelims preview article, when it has been discovered. */
  prelimsArticleUrl?: string;
  /** The real card, used to match each extracted segment to a bout. */
  bouts: readonly Bout[];
}

/**
 * Fetches every main-card page and the prelims article (when given), splits
 * each into per-bout segments, and matches them against the real card.
 * Unmatched segments (a header the surname matcher can't place) are
 * silently dropped rather than guessed at — a missing outlook falls back to
 * the UI placeholder, which is the safe failure mode here.
 */
export async function collectSherdogOutlookContent(
  input: CollectSherdogOutlookContentInput,
  options: FetchSherdogOutlookContentOptions,
): Promise<SherdogOutlookMatch[]> {
  const allSegments: SherdogPreviewSegment[] = [];

  for (let page = 1; page <= input.mainCardBoutCount; page += 1) {
    const pageUrl = withSherdogArticlePageNumber(input.baseArticleUrl, page);
    const response = await fetchSherdogPage(pageUrl, options);
    if (response.status === 403) throw new SherdogForbiddenError(pageUrl);
    if (response.status < 200 || response.status >= 300) continue;
    allSegments.push(...extractSherdogPreviewSegments(response.html));
  }

  if (input.prelimsArticleUrl !== undefined) {
    const response = await fetchSherdogPage(input.prelimsArticleUrl, options);
    if (response.status === 403) {
      throw new SherdogForbiddenError(input.prelimsArticleUrl);
    }
    if (response.status >= 200 && response.status < 300) {
      allSegments.push(...extractSherdogPreviewSegments(response.html));
    }
  }

  const matches = new Map<string, SherdogOutlookMatch>();
  for (const segment of allSegments) {
    const bout = matchSegmentToBout(segment, input.bouts);
    if (bout === undefined || matches.has(bout.id)) continue;
    matches.set(bout.id, { bout, rawPreviewText: segment.rawText });
  }
  return [...matches.values()];
}
