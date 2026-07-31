import {
  eventTokenScore,
  fetchSherdogNewsFeed,
  fighterSurname,
  normalizeSearchText,
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
      /^\/news\/articles\/\d+\/.+-\d+\/?$/iu.test(url.pathname)
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
  const items = await fetchSherdogNewsFeed(options);
  return findSherdogOutlookPreview(items, target);
}
