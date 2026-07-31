import { describe, expect, it, vi } from "vitest";
import { parseSherdogNewsFeed, SHERDOG_ARTICLES_FEED_PATH } from "./sherdogFeed.ts";
import {
  discoverSherdogOutlookPreview,
  discoverSherdogPrelimsOutlookPreview,
  findSherdogOutlookPreview,
  findSherdogPrelimsOutlookPreview,
  isSherdogOutlookPreview,
  isSherdogPrelimsOutlookPreview,
} from "./sherdogOutlookDiscovery.ts";

// Canonical shape as published by Sherdog's real /rss/articles.xml feed
// (verified live 2026-07-30): the RSS link omits the page number entirely.
const belgradeUrl =
  "https://www.sherdog.com/news/articles/Preview-UFC-Belgrade-Medic-vs-Rodriguez-202128";
const belgradePage1Url =
  "https://www.sherdog.com/news/articles/1/Preview-UFC-Belgrade-Medic-vs-Rodriguez-202128";
const abuDhabiUrl =
  "https://www.sherdog.com/news/articles/Preview-UFC-Abu-Dhabi-Ankalaev-vs-Guskov-202042";

const feed = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title><![CDATA[Preview: UFC Belgrade prelims]]></title>
    <link>https://www.sherdog.com/news/articles/Preview-UFC-Belgrade-prelims-202127</link>
  </item>
  <item>
    <title><![CDATA[Preview: UFC Abu Dhabi 'Ankalaev vs. Guskov']]></title>
    <link>${abuDhabiUrl}</link>
    <pubDate>Wed, 22 Jul 2026 09:00:00 +0000</pubDate>
  </item>
  <item>
    <title><![CDATA[UFC Abu Dhabi 'Ankalaev vs. Guskov' play-by-play, results & round scoring]]></title>
    <link>https://www.sherdog.com/news/news/UFC-Abu-Dhabi-Ankalaev-vs-Guskov-playbyplay-results-round-scoring-202071</link>
  </item>
</channel></rss>`;

describe("Sherdog fight-outlook discovery", () => {
  it("recognizes preview articles under /news/articles/ with no page number", () => {
    const items = parseSherdogNewsFeed(feed);
    expect(items.filter(isSherdogOutlookPreview).map((item) => item.url)).toEqual(
      [
        "https://www.sherdog.com/news/articles/Preview-UFC-Belgrade-prelims-202127",
        abuDhabiUrl,
      ],
    );
  });

  it("also recognizes a page-numbered /news/articles/<page>/ URL", () => {
    expect(
      isSherdogOutlookPreview({
        title: "Preview: UFC Belgrade 'Medic vs. Rodriguez'",
        url: belgradePage1Url,
      }),
    ).toBe(true);
  });

  it("does not treat a play-by-play article as a preview", () => {
    const items = parseSherdogNewsFeed(feed);
    const playByPlay = items.find((item) => item.url.includes("playbyplay"));
    expect(playByPlay).toBeDefined();
    expect(isSherdogOutlookPreview(playByPlay!)).toBe(false);
  });

  it("matches the preview by main-event fighter surnames", () => {
    const items = parseSherdogNewsFeed(feed);
    expect(
      findSherdogOutlookPreview(items, {
        eventName: "UFC Abu Dhabi",
        redFighter: "Magomed Ankalaev",
        blueFighter: "Bogdan Guskov",
      })?.url,
    ).toBe(abuDhabiUrl);
  });

  it("normalizes accents when matching the upcoming main event", () => {
    expect(
      findSherdogOutlookPreview(
        [
          {
            title: "Preview: UFC Belgrade 'Medic vs. Rodriguez'",
            url: belgradeUrl,
          },
        ],
        {
          eventName: "UFC Fight Night: Medić vs. Rodriguez",
          redFighter: "Uroš Medić",
          blueFighter: "Daniel Rodriguez",
        },
      )?.url,
    ).toBe(belgradeUrl);
  });

  it("returns undefined until the matching preview is published", () => {
    expect(
      findSherdogOutlookPreview(parseSherdogNewsFeed(feed), {
        eventName: "UFC Fight Night: Medić vs. Rodriguez",
        redFighter: "Uroš Medić",
        blueFighter: "Daniel Rodriguez",
      }),
    ).toBeUndefined();
  });

  it("fetches the dedicated articles feed only when Sherdog reads are permission-enabled", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(feed, { status: 200 }));

    await expect(
      discoverSherdogOutlookPreview(
        {
          eventName: "UFC Abu Dhabi",
          redFighter: "Magomed Ankalaev",
          blueFighter: "Bogdan Guskov",
        },
        { permissionScope: "sherdog-read", fetchImpl },
      ),
    ).resolves.toMatchObject({ url: abuDhabiUrl });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL(`https://www.sherdog.com${SHERDOG_ARTICLES_FEED_PATH}`),
      expect.anything(),
    );

    await expect(
      discoverSherdogOutlookPreview(
        {
          eventName: "UFC Abu Dhabi",
          redFighter: "Magomed Ankalaev",
          blueFighter: "Bogdan Guskov",
        },
        { permissionScope: "none", fetchImpl },
      ),
    ).rejects.toThrow("SHERDOG_PERMISSION_SCOPE");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("Sherdog prelims outlook discovery", () => {
  const prelimsUrl =
    "https://www.sherdog.com/news/articles/Preview-UFC-Belgrade-prelims-202127";

  it("identifies the prelims preview by its title", () => {
    const items = parseSherdogNewsFeed(feed);
    const prelims = items.find((item) => item.url === prelimsUrl);
    expect(prelims).toBeDefined();
    expect(isSherdogPrelimsOutlookPreview(prelims!)).toBe(true);
  });

  it("does not treat the main-card preview as the prelims preview", () => {
    expect(
      isSherdogPrelimsOutlookPreview({
        title: "Preview: UFC Abu Dhabi 'Ankalaev vs. Guskov'",
        url: abuDhabiUrl,
      }),
    ).toBe(false);
  });

  it("matches the prelims preview by event tokens alone (no fighter pair)", () => {
    const items = parseSherdogNewsFeed(feed);
    expect(
      findSherdogPrelimsOutlookPreview(items, {
        eventName: "UFC Fight Night: Medić vs. Rodriguez",
      })?.url,
    ).toBe(prelimsUrl);
  });

  it("fetches the dedicated articles feed only when Sherdog reads are permission-enabled", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(feed, { status: 200 }));

    await expect(
      discoverSherdogPrelimsOutlookPreview(
        { eventName: "UFC Fight Night: Medić vs. Rodriguez" },
        { permissionScope: "sherdog-read", fetchImpl },
      ),
    ).resolves.toMatchObject({ url: prelimsUrl });

    await expect(
      discoverSherdogPrelimsOutlookPreview(
        { eventName: "UFC Fight Night: Medić vs. Rodriguez" },
        { permissionScope: "none", fetchImpl },
      ),
    ).rejects.toThrow("SHERDOG_PERMISSION_SCOPE");
  });
});
