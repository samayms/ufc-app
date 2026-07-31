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
// Fighter names use \p{L} (any Unicode letter), not a-z, because Balkan and
// other international names carry diacritics Sherdog's writers don't strip
// (verified live 2026-07-31: "Duško Todorović", "Rębecki" both broke the
// original ASCII-only class and silently dropped their bout's segment).
// The record itself sometimes carries a trailing no-contest note inside the
// same parenthesis, e.g. "(21-5, 1 NC)" (also verified live) — the optional
// group absorbs that without over-matching a normal "(21-5)" record.
const RECORD_RE = String.raw`\d+-\d+(?:-\d+)?(?:,\s*\d+\s*NC)?`;
const HEADER_RE = new RegExp(
  String.raw`([A-Za-z ]+weights?) ([\p{Lu}][\p{L}'.\- ]+)\((${RECORD_RE})\)\s*vs\.?\s*([\p{Lu}][\p{L}'.\- ]+)\((${RECORD_RE})\)\s*BETTING ODDS:`,
  "gu",
);

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
  /**
   * Number of prelim bouts; pages 1..N of the prelims article are fetched.
   * Verified live 2026-07-31: contrary to the original assumption that the
   * prelims preview runs every bout back to back on one page, Sherdog
   * paginates it exactly like the main card, one bout per page. Required
   * whenever `prelimsArticleUrl` is given.
   */
  prelimsBoutCount?: number;
  /** The real card, used to match each extracted segment to a bout. */
  bouts: readonly Bout[];
}

async function fetchArticlePages(
  articleUrl: string,
  pageCount: number,
  options: FetchSherdogOutlookContentOptions,
): Promise<SherdogPreviewSegment[]> {
  const segments: SherdogPreviewSegment[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    const pageUrl = withSherdogArticlePageNumber(articleUrl, page);
    const response = await fetchSherdogPage(pageUrl, options);
    if (response.status === 403) throw new SherdogForbiddenError(pageUrl);
    if (response.status < 200 || response.status >= 300) continue;
    segments.push(...extractSherdogPreviewSegments(response.html));
  }
  return segments;
}

/**
 * Fetches every main-card page and every prelims page (when given), splits
 * each into per-bout segments, and matches them against the real card.
 * Unmatched segments (a header the surname matcher can't place) are
 * silently dropped rather than guessed at — a missing outlook falls back to
 * the UI placeholder, which is the safe failure mode here.
 */
export async function collectSherdogOutlookContent(
  input: CollectSherdogOutlookContentInput,
  options: FetchSherdogOutlookContentOptions,
): Promise<SherdogOutlookMatch[]> {
  const allSegments = await fetchArticlePages(
    input.baseArticleUrl,
    input.mainCardBoutCount,
    options,
  );

  if (input.prelimsArticleUrl !== undefined) {
    allSegments.push(
      ...(await fetchArticlePages(
        input.prelimsArticleUrl,
        input.prelimsBoutCount ?? 1,
        options,
      )),
    );
  }

  const matches = new Map<string, SherdogOutlookMatch>();
  for (const segment of allSegments) {
    const bout = matchSegmentToBout(segment, input.bouts);
    if (bout === undefined || matches.has(bout.id)) continue;
    matches.set(bout.id, { bout, rawPreviewText: segment.rawText });
  }
  return [...matches.values()];
}
