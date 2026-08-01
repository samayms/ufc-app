import {
  eventTokenScore,
  fetchSherdogNewsFeed,
  fighterSurname,
  normalizeSearchText,
  SHERDOG_ARTICLES_FEED_PATH,
  type FetchSherdogNewsFeedOptions,
  type SherdogNewsItem,
} from "./sherdogFeed.ts";

export interface SherdogOutlookTarget {
  eventName: string;
  redFighter: string;
  blueFighter: string;
}

export type DiscoverSherdogOutlookOptions = FetchSherdogNewsFeedOptions;

export function isSherdogOutlookPreview(item: SherdogNewsItem): boolean {
  if (!/\bufc\b/iu.test(item.title)) return false;
  if (!/\bpreview\b/iu.test(item.title)) return false;

  try {
    const url = new URL(item.url);
    const host = url.hostname.toLocaleLowerCase("en-US");
    return (
      (host === "sherdog.com" || host === "www.sherdog.com") &&
      // The RSS feed links to the canonical article (no page number); the
      // browser adds a leading page number when reading a specific page
      // (page 1 = main event, page 2 = co-main, ...). Both are accepted.
      /^\/news\/articles\/(?:\d+\/)?.+-\d+\/?$/iu.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function findSherdogOutlookPreview(
  items: readonly SherdogNewsItem[],
  target: SherdogOutlookTarget,
): SherdogNewsItem | undefined {
  const redSurname = fighterSurname(target.redFighter);
  const blueSurname = fighterSurname(target.blueFighter);
  if (redSurname === undefined || blueSurname === undefined) return undefined;

  return items
    .map((item, index) => {
      const searchable = normalizeSearchText(`${item.title} ${item.url}`);
      const tokens = new Set(searchable.split(/\s+/u));
      const matchesFighters =
        tokens.has(redSurname) && tokens.has(blueSurname);
      return {
        item,
        index,
        score:
          (isSherdogOutlookPreview(item) && matchesFighters ? 100 : 0) +
          eventTokenScore(target.eventName, searchable),
      };
    })
    .filter(({ item, score }) => isSherdogOutlookPreview(item) && score >= 100)
    .sort(
      (left, right) =>
        right.score - left.score || left.index - right.index,
    )[0]?.item;
}

export async function discoverSherdogOutlookPreview(
  target: SherdogOutlookTarget,
  options: DiscoverSherdogOutlookOptions,
): Promise<SherdogNewsItem | undefined> {
  const items = await fetchSherdogNewsFeed({
    feedPath: SHERDOG_ARTICLES_FEED_PATH,
    ...options,
  });
  return findSherdogOutlookPreview(items, target);
}

export interface SherdogPrelimsOutlookTarget {
  eventName: string;
}

/**
 * The prelims preview is a second, separate article in the same feed (e.g.
 * "Preview: UFC Belgrade prelims") that covers every prelim bout on one
 * page, so it has no single fighter pair to match on — only the event name.
 */
export function isSherdogPrelimsOutlookPreview(item: SherdogNewsItem): boolean {
  return isSherdogOutlookPreview(item) && /\bprelims\b/iu.test(item.title);
}

export function findSherdogPrelimsOutlookPreview(
  items: readonly SherdogNewsItem[],
  target: SherdogPrelimsOutlookTarget,
): SherdogNewsItem | undefined {
  return items
    .map((item, index) => ({
      item,
      index,
      score: eventTokenScore(
        target.eventName,
        normalizeSearchText(`${item.title} ${item.url}`),
      ),
    }))
    .filter(({ item }) => isSherdogPrelimsOutlookPreview(item))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]
    ?.item;
}

export async function discoverSherdogPrelimsOutlookPreview(
  target: SherdogPrelimsOutlookTarget,
  options: DiscoverSherdogOutlookOptions,
): Promise<SherdogNewsItem | undefined> {
  const items = await fetchSherdogNewsFeed({
    feedPath: SHERDOG_ARTICLES_FEED_PATH,
    ...options,
  });
  return findSherdogPrelimsOutlookPreview(items, target);
}
