import { describe, expect, it, vi } from "vitest";
import { parseSherdogNewsFeed } from "./sherdogFeed.ts";
import {
  discoverSherdogOutlookPreview,
  findSherdogOutlookPreview,
  isSherdogOutlookPreview,
} from "./sherdogOutlookDiscovery.ts";

const belgradeUrl =
  "https://www.sherdog.com/news/articles/1/Preview-UFC-Belgrade-Medic-vs-Rodriguez-202128";
const abuDhabiUrl =
  "https://www.sherdog.com/news/articles/1/Preview-UFC-Abu-Dhabi-Ankalaev-vs-Guskov-202070";

const feed = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title><![CDATA[Unrelated UFC interview]]></title>
    <link>https://www.sherdog.com/news/news/Unrelated-UFC-interview-202069</link>
  </item>
  <item>
    <title><![CDATA[UFC Abu Dhabi ‘Ankalaev vs. Guskov’ Preview]]></title>
    <link>${abuDhabiUrl}</link>
    <pubDate>Wed, 22 Jul 2026 09:00:00 +0000</pubDate>
  </item>
  <item>
    <title><![CDATA[UFC Abu Dhabi ‘Ankalaev vs. Guskov’ play-by-play, results & round scoring]]></title>
    <link>https://www.sherdog.com/news/news/UFC-Abu-Dhabi-Ankalaev-vs-Guskov-playbyplay-results-round-scoring-202071</link>
  </item>
</channel></rss>`;

describe("Sherdog fight-outlook discovery", () => {
  it("recognizes preview articles under /news/articles/<page>/", () => {
    const items = parseSherdogNewsFeed(feed);
    expect(items.filter(isSherdogOutlookPreview)).toEqual([
      {
        title: "UFC Abu Dhabi ‘Ankalaev vs. Guskov’ Preview",
        url: abuDhabiUrl,
        publishedAt: "Wed, 22 Jul 2026 09:00:00 +0000",
      },
    ]);
  });

  it("does not treat a play-by-play article as a preview", () => {
    const items = parseSherdogNewsFeed(feed);
    const playByPlay = items.find((item) =>
      item.url.includes("playbyplay"),
    );
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
            title: "UFC Belgrade ‘Medic vs. Rodriguez’ Preview",
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

  it("fetches only when Sherdog reads are permission-enabled", async () => {
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
