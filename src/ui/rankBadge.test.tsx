import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Fighter } from "../schema.ts";
import { officialUfcRanking } from "../lib/ufcRankings.ts";
import { BoutHeader } from "./BoutHeader.tsx";

function fighter(name: string): Fighter {
  const ranking = officialUfcRanking(name);
  return {
    id: name.toLowerCase().replace(/\s+/g, "-"),
    externalRefs: [],
    name,
    record: { wins: 20, losses: 1, draws: 0, noContests: 0 },
    ...(ranking === undefined ? {} : { ranking }),
    provenance: {
      source: "espn",
      fetchedAt: "2026-08-14T12:00:00.000Z",
      synthetic: false,
    },
  };
}

function renderHeader(redName: string, blueName: string): string {
  return renderToStaticMarkup(
    <BoutHeader
      weightClassLabel="Welterweight"
      titleFight
      scheduledRounds={5}
      fighters={{ red: fighter(redName), blue: fighter(blueName) }}
      status="upcoming"
    />,
  );
}

describe("ranking badge", () => {
  it("shows C for the champion and 1 for the top contender", () => {
    const html = renderHeader("Islam Makhachev", "Ian Machado Garry");

    expect(html).toContain('class="rank-badge rank-badge-champion">C<');
    expect(html).toContain('class="rank-badge">1<');
  });

  it("renders no badge at all for an unranked fighter", () => {
    const html = renderHeader("Nobody Ranked", "Also Unranked");
    expect(html).not.toContain("rank-badge");
  });

  it("uses the champion badge only for the champion", () => {
    const html = renderHeader("Islam Makhachev", "Ian Machado Garry");
    expect(html.match(/rank-badge-champion/g)).toHaveLength(1);
  });
});

describe("ranking badge geometry", () => {
  it("is a fixed square with centered content and no padding distortion", async () => {
    const css = await readFile("src/ui/dashboard.css", "utf8");
    const rule = css.match(/\.rank-badge \{([\s\S]*?)\}/)?.[1];
    expect(rule).toBeDefined();
    const declarations = rule ?? "";

    // Equal fixed width and height, so a two-digit rank like "15" cannot
    // stretch the box wider than it is tall.
    const width = declarations.match(/(?:^|\s)width:\s*([^;]+);/)?.[1]?.trim();
    const height = declarations.match(/(?:^|\s)height:\s*([^;]+);/)?.[1]?.trim();
    expect(width).toBeDefined();
    expect(width).toBe(height);

    expect(declarations).toMatch(/aspect-ratio:\s*1\s*\/\s*1/);
    expect(declarations).toMatch(/align-items:\s*center/);
    expect(declarations).toMatch(/justify-content:\s*center/);
    // No flex shrinking, and padding cannot distort a content-box square.
    expect(declarations).toMatch(/flex:\s*none/);
    expect(declarations).toMatch(/padding:\s*0\s*;/);
    expect(declarations).toMatch(/box-sizing:\s*border-box/);
    // A min-width would let content win over the fixed size again.
    expect(declarations).not.toMatch(/min-width/);
  });
});
