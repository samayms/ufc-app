import { describe, expect, it, vi } from "vitest";
import type { Bout } from "../src/schema.ts";
import {
  SherdogForbiddenError,
  collectSherdogOutlookContent,
  extractSherdogPreviewSegments,
  matchSegmentToBout,
  withSherdogArticlePageNumber,
} from "./sherdogOutlookContent.ts";

function bout(id: string, red: string, blue: string, cardPosition: number): Bout {
  return {
    id,
    externalRefs: [],
    eventId: "evt-belgrade",
    cardPosition,
    segment: cardPosition <= 6 ? "main-card" : "prelims",
    weightClass: "welterweight",
    scheduledRounds: 3,
    titleFight: false,
    fighters: {
      red: {
        id: `${id}-red`,
        externalRefs: [],
        name: red,
        record: { wins: 0, losses: 0, draws: 0, noContests: 0 },
        provenance: { source: "fixture", fetchedAt: "2026-07-30T00:00:00Z", synthetic: true },
      },
      blue: {
        id: `${id}-blue`,
        externalRefs: [],
        name: blue,
        record: { wins: 0, losses: 0, draws: 0, noContests: 0 },
        provenance: { source: "fixture", fetchedAt: "2026-07-30T00:00:00Z", synthetic: true },
      },
    },
    status: "upcoming",
    provenance: { source: "fixture", fetchedAt: "2026-07-30T00:00:00Z", synthetic: true },
  };
}

const PAGE1_HTML = `
<html><body>
<article>
<h2>Welterweight Uros Medic (12-4-0) vs. Daniel Rodriguez (18-4-0) BETTING ODDS: Medic -150</h2>
<p>Medic brings heavy hands and looks to end this early.</p>
<p>Rodriguez wants to drag this into deep water and grind it out.</p>
</article>
<nav>Jump To &raquo; <a href="#">Round scoring</a></nav>
<aside>Related articles and a newsletter signup that should never be extracted.</aside>
</body></html>
`;

const PAGE2_HTML = `
<html><body>
<article>
<h2>Middleweight Ikram Aliskerov (16-2-0) vs. Robert Whittaker (25-7-0) BETTING ODDS: Whittaker -200</h2>
<p>Aliskerov is a dangerous grappler with knockout power in his hands too.</p>
<p>Whittaker counters beautifully and has faced this kind of pressure before.</p>
</article>
<nav>Jump To &raquo; <a href="#">Round scoring</a></nav>
</body></html>
`;

// Sherdog's prelims preview is a separate article, but (verified live
// 2026-07-31) it is paginated exactly like the main card, one bout per
// page, not one page covering every prelim bout back to back.
const PRELIMS_HTML = `
<html><body>
<article>
<h3>Lightweight Nasrat Haqparast (16-6-0) vs. Esteban Ribovics (13-1-0) BETTING ODDS: Haqparast -110</h3>
<p>Haqparast is durable and pushes a heavy pace from the opening bell.</p>
<p>Ribovics is a rangy kickboxer who likes to work from distance.</p>
<h3>Bantamweight Vinicius Oliveira (18-4-0) vs. Cameron Saaiman (10-1-0) BETTING ODDS: Saaiman -130</h3>
<p>Oliveira is aggressive and hunts for the finish from the first bell.</p>
<p>Saaiman is younger, faster, and comes forward behind a stiff jab.</p>
</article>
<nav>Jump To &raquo; <a href="#">Round scoring</a></nav>
<aside>Unrelated event history and the writer's sign-off.</aside>
</body></html>
`;

const PRELIM_PAGE1_HTML = `
<html><body>
<article>
<h3>Lightweight Nasrat Haqparast (16-6-0) vs. Esteban Ribovics (13-1-0) BETTING ODDS: Haqparast -110</h3>
<p>Haqparast is durable and pushes a heavy pace from the opening bell.</p>
<p>Ribovics is a rangy kickboxer who likes to work from distance.</p>
</article>
<nav>Jump To &raquo; <a href="#">Round scoring</a></nav>
</body></html>
`;

const PRELIM_PAGE2_HTML = `
<html><body>
<article>
<h3>Bantamweight Vinicius Oliveira (18-4-0) vs. Cameron Saaiman (10-1-0) BETTING ODDS: Saaiman -130</h3>
<p>Oliveira is aggressive and hunts for the finish from the first bell.</p>
<p>Saaiman is younger, faster, and comes forward behind a stiff jab.</p>
</article>
<nav>Jump To &raquo; <a href="#">Round scoring</a></nav>
</body></html>
`;

describe("withSherdogArticlePageNumber", () => {
  it("inserts the page number right after /news/articles/", () => {
    expect(
      withSherdogArticlePageNumber(
        "https://www.sherdog.com/news/articles/Preview-UFC-Belgrade-Medic-vs-Rodriguez-202128",
        2,
      ),
    ).toBe(
      "https://www.sherdog.com/news/articles/2/Preview-UFC-Belgrade-Medic-vs-Rodriguez-202128",
    );
  });
});

describe("extractSherdogPreviewSegments", () => {
  it("extracts a single bout's header and prose from a main-card page", () => {
    const segments = extractSherdogPreviewSegments(PAGE1_HTML);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.fighterAName).toBe("Uros Medic");
    expect(segments[0]?.fighterBName).toBe("Daniel Rodriguez");
    expect(segments[0]?.weightClassText.trim()).toBe("Welterweight");
    expect(segments[0]?.rawText).toContain("heavy hands");
    expect(segments[0]?.rawText).toContain("deep water");
  });

  it("stops before the Jump To marker and drops trailing site chrome", () => {
    const segments = extractSherdogPreviewSegments(PAGE1_HTML);

    expect(segments[0]?.rawText).not.toContain("Jump To");
    expect(segments[0]?.rawText).not.toContain("newsletter signup");
  });

  it("splits a multi-bout prelims page into one segment per bout", () => {
    const segments = extractSherdogPreviewSegments(PRELIMS_HTML);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.fighterAName).toBe("Nasrat Haqparast");
    expect(segments[0]?.fighterBName).toBe("Esteban Ribovics");
    expect(segments[0]?.rawText).toContain("heavy pace");
    expect(segments[0]?.rawText).not.toContain("Oliveira is aggressive");

    expect(segments[1]?.fighterAName).toBe("Vinicius Oliveira");
    expect(segments[1]?.fighterBName).toBe("Cameron Saaiman");
    expect(segments[1]?.rawText).toContain("hunts for the finish");
    expect(segments[1]?.rawText).not.toContain("Jump To");
    expect(segments[1]?.rawText).not.toContain("sign-off");
  });

  it("matches fighter names carrying diacritics (verified live: ASCII-only broke on real Balkan names)", () => {
    const html = `
<h2>Lightweight Duško Todorović (11-4-0) vs. Mateusz Rębecki (20-3-0) BETTING ODDS: Todorovic -120</h2>
<p>Todorovic pressures behind volume and a granite chin.</p>
<p>Rebecki is durable and mixes in wrestling when the pace slows down.</p>
Jump To`;
    const segments = extractSherdogPreviewSegments(html);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.fighterAName).toBe("Duško Todorović");
    expect(segments[0]?.fighterBName).toBe("Mateusz Rębecki");
  });

  it("matches a record that carries a trailing no-contest note (verified live: \"(21-5, 1 NC)\" broke the plain record pattern)", () => {
    const html = `
<h2>Heavyweight Jovan Leka (13-2) vs. Alexander Poppeck (21-5, 1 NC) BETTING ODDS: Leka -220</h2>
<p>Leka is a heavy handed striker who wants this fight standing.</p>
<p>Poppeck brings size and a durable chin into the cage with him.</p>
Jump To`;
    const segments = extractSherdogPreviewSegments(html);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.fighterAName).toBe("Jovan Leka");
    expect(segments[0]?.fighterARecord).toBe("13-2");
    expect(segments[0]?.fighterBName).toBe("Alexander Poppeck");
    expect(segments[0]?.fighterBRecord).toBe("21-5, 1 NC");
  });

  it("returns nothing when the page has no matching header", () => {
    expect(extractSherdogPreviewSegments("<html><body>nothing here</body></html>")).toEqual(
      [],
    );
  });
});

describe("matchSegmentToBout", () => {
  const bouts = [
    bout("bout-main", "Uros Medic", "Daniel Rodriguez", 1),
    bout("bout-comain", "Ikram Aliskerov", "Robert Whittaker", 2),
  ];

  it("matches a segment to its bout by surname, regardless of corner order", () => {
    const [segment] = extractSherdogPreviewSegments(PAGE2_HTML);
    expect(matchSegmentToBout(segment!, bouts)?.id).toBe("bout-comain");
  });

  it("returns undefined when no bout has both surnames", () => {
    const [segment] = extractSherdogPreviewSegments(PRELIMS_HTML);
    expect(matchSegmentToBout(segment!, bouts)).toBeUndefined();
  });
});

describe("collectSherdogOutlookContent", () => {
  const bouts = [
    bout("bout-main", "Uros Medic", "Daniel Rodriguez", 1),
    bout("bout-comain", "Ikram Aliskerov", "Robert Whittaker", 2),
    bout("bout-prelim-1", "Nasrat Haqparast", "Esteban Ribovics", 7),
    bout("bout-prelim-2", "Vinicius Oliveira", "Cameron Saaiman", 8),
  ];

  it("fetches every main-card page and every prelims page, and matches every bout", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = input.toString();
      if (url.includes("prelims")) {
        if (url.includes("/news/articles/1/")) {
          return new Response(PRELIM_PAGE1_HTML, { status: 200 });
        }
        if (url.includes("/news/articles/2/")) {
          return new Response(PRELIM_PAGE2_HTML, { status: 200 });
        }
        return new Response("", { status: 404 });
      }
      if (url.includes("/news/articles/1/")) return new Response(PAGE1_HTML, { status: 200 });
      if (url.includes("/news/articles/2/")) return new Response(PAGE2_HTML, { status: 200 });
      return new Response("", { status: 404 });
    });

    const matches = await collectSherdogOutlookContent(
      {
        baseArticleUrl:
          "https://www.sherdog.com/news/articles/Preview-UFC-Belgrade-Medic-vs-Rodriguez-202128",
        mainCardBoutCount: 2,
        prelimsArticleUrl:
          "https://www.sherdog.com/news/articles/Preview-UFC-Belgrade-prelims-202127",
        prelimsBoutCount: 2,
        bouts,
      },
      { permissionScope: "sherdog-read", fetchImpl },
    );

    expect(matches).toHaveLength(4);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const byId = new Map(matches.map((match) => [match.bout.id, match.rawPreviewText]));
    expect(byId.get("bout-main")).toContain("heavy hands");
    expect(byId.get("bout-comain")).toContain("dangerous grappler");
    expect(byId.get("bout-prelim-1")).toContain("heavy pace");
    expect(byId.get("bout-prelim-2")).toContain("hunts for the finish");
  });

  it("skips the prelims fetch when no prelims article was discovered", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(PAGE1_HTML, { status: 200 }));

    await collectSherdogOutlookContent(
      {
        baseArticleUrl:
          "https://www.sherdog.com/news/articles/Preview-UFC-Belgrade-Medic-vs-Rodriguez-202128",
        mainCardBoutCount: 1,
        bouts,
      },
      { permissionScope: "sherdog-read", fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops immediately on an HTTP 403 rather than retrying", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("", { status: 403 }));

    await expect(
      collectSherdogOutlookContent(
        {
          baseArticleUrl:
            "https://www.sherdog.com/news/articles/Preview-UFC-Belgrade-Medic-vs-Rodriguez-202128",
          mainCardBoutCount: 3,
          bouts,
        },
        { permissionScope: "sherdog-read", fetchImpl },
      ),
    ).rejects.toBeInstanceOf(SherdogForbiddenError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses to fetch without a permitting scope", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      collectSherdogOutlookContent(
        {
          baseArticleUrl:
            "https://www.sherdog.com/news/articles/Preview-UFC-Belgrade-Medic-vs-Rodriguez-202128",
          mainCardBoutCount: 1,
          bouts,
        },
        { permissionScope: "none", fetchImpl },
      ),
    ).rejects.toThrow("SHERDOG_PERMISSION_SCOPE");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
