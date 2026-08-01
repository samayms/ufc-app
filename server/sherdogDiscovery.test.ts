import { describe, expect, it, vi } from "vitest";
import {
  discoverSherdogLiveBlog,
  findSherdogLiveBlog,
  parseSherdogNewsFeed,
} from "./sherdogDiscovery.ts";

const oklahomaUrl =
  "https://www.sherdog.com/news/news/UFC-Oklahoma-City-Du-Plessis-vs-Usman-playbyplay-results-round-scoring-201960";
const abuDhabiUrl =
  "https://www.sherdog.com/news/news/UFC-Abu-Dhabi-Ankalaev-vs-Guskov-playbyplay-results-round-scoring-202068";

const feed = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title><![CDATA[Unrelated UFC interview]]></title>
    <link>https://www.sherdog.com/news/news/Unrelated-UFC-interview-202069</link>
  </item>
  <item>
    <title><![CDATA[UFC Abu Dhabi ‘Ankalaev vs. Guskov’ play-by-play, results &amp; round scoring]]></title>
    <link>${abuDhabiUrl}</link>
    <pubDate>Sat, 25 Jul 2026 09:00:00 +0000</pubDate>
  </item>
  <item>
    <title><![CDATA[UFC Oklahoma City ‘Du Plessis vs. Usman’ play-by-play, results & round scoring]]></title>
    <link>${oklahomaUrl}</link>
  </item>
</channel></rss>`;

describe("Sherdog live-blog discovery", () => {
  it("parses the official RSS item shape", () => {
    expect(parseSherdogNewsFeed(feed)).toEqual([
      {
        title: "Unrelated UFC interview",
        url: "https://www.sherdog.com/news/news/Unrelated-UFC-interview-202069",
      },
      {
        title:
          "UFC Abu Dhabi ‘Ankalaev vs. Guskov’ play-by-play, results & round scoring",
        url: abuDhabiUrl,
        publishedAt: "Sat, 25 Jul 2026 09:00:00 +0000",
      },
      {
        title:
          "UFC Oklahoma City ‘Du Plessis vs. Usman’ play-by-play, results & round scoring",
        url: oklahomaUrl,
      },
    ]);
  });

  it("matches both supplied examples by main-event fighter names", () => {
    const items = parseSherdogNewsFeed(feed);
    expect(
      findSherdogLiveBlog(items, {
        eventName: "UFC Oklahoma City",
        redFighter: "Dricus Du Plessis",
        blueFighter: "Kamaru Usman",
      })?.url,
    ).toBe(oklahomaUrl);
    expect(
      findSherdogLiveBlog(items, {
        eventName: "UFC Abu Dhabi",
        redFighter: "Magomed Ankalaev",
        blueFighter: "Bogdan Guskov",
      })?.url,
    ).toBe(abuDhabiUrl);
  });

  it("normalizes accents when matching the upcoming main event", () => {
    const medicUrl =
      "https://www.sherdog.com/news/news/UFC-Belgrade-Medic-vs-Rodriguez-playbyplay-results-round-scoring-202100";
    expect(
      findSherdogLiveBlog(
        [
          {
            title:
              "UFC Belgrade ‘Medic vs. Rodriguez’ play-by-play, results & round scoring",
            url: medicUrl,
          },
        ],
        {
          eventName: "UFC Fight Night: Medić vs. Rodriguez",
          redFighter: "Uroš Medić",
          blueFighter: "Daniel Rodriguez",
        },
      )?.url,
    ).toBe(medicUrl);
  });

  it("returns undefined until the matching article is published", () => {
    expect(
      findSherdogLiveBlog(parseSherdogNewsFeed(feed), {
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
      discoverSherdogLiveBlog(
        {
          eventName: "UFC Abu Dhabi",
          redFighter: "Magomed Ankalaev",
          blueFighter: "Bogdan Guskov",
        },
        { permissionScope: "sherdog-read", fetchImpl },
      ),
    ).resolves.toMatchObject({ url: abuDhabiUrl });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://www.sherdog.com/rss/news.xml"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: expect.stringContaining("application/rss+xml"),
        }),
      }),
    );

    await expect(
      discoverSherdogLiveBlog(
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
