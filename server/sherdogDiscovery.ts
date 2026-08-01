import {
  eventTokenScore,
  fetchSherdogNewsFeed,
  fighterSurname,
  normalizeSearchText,
  parseSherdogNewsFeed,
  SHERDOG_NEWS_FEED_PATH,
  type FetchSherdogNewsFeedOptions,
  type SherdogNewsItem,
} from "./sherdogFeed.ts";

export { SHERDOG_NEWS_FEED_PATH, parseSherdogNewsFeed };
export type { SherdogNewsItem };

export interface SherdogLiveBlogTarget {
  eventName: string;
  redFighter: string;
  blueFighter: string;
}

export type DiscoverSherdogLiveBlogOptions = FetchSherdogNewsFeedOptions;

function isSherdogLiveBlog(item: SherdogNewsItem): boolean {
  if (!/\bufc\b/iu.test(item.title)) return false;
  if (!/play\s*[-–—]?\s*by\s*[-–—]?\s*play/iu.test(item.title)) {
    return false;
  }

  try {
    const url = new URL(item.url);
    const host = url.hostname.toLocaleLowerCase("en-US");
    return (
      (host === "sherdog.com" || host === "www.sherdog.com") &&
      /^\/news\/news\/.+-\d+\/?$/iu.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function findSherdogLiveBlog(
  items: readonly SherdogNewsItem[],
  target: SherdogLiveBlogTarget,
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
          (isSherdogLiveBlog(item) && matchesFighters ? 100 : 0) +
          eventTokenScore(target.eventName, searchable),
      };
    })
    .filter(({ item, score }) => isSherdogLiveBlog(item) && score >= 100)
    .sort(
      (left, right) =>
        right.score - left.score || left.index - right.index,
    )[0]?.item;
}

export async function discoverSherdogLiveBlog(
  target: SherdogLiveBlogTarget,
  options: DiscoverSherdogLiveBlogOptions,
): Promise<SherdogNewsItem | undefined> {
  const items = await fetchSherdogNewsFeed(options);
  return findSherdogLiveBlog(items, target);
}
