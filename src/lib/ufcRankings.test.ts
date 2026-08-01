import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { officialUfcRanking } from "./ufcRankings.ts";

describe("official UFC ranking overlay", () => {
  it("shows the welterweight champion as a champion, not a number", () => {
    // The specific case ESPN gets wrong: its own endpoint still has Usman
    // here. "C" is what the badge derives from the word "Champion".
    expect(officialUfcRanking("Islam Makhachev")).toBe("Welterweight Champion");
  });

  it("ranks Ian Machado Garry #1 at welterweight", () => {
    expect(officialUfcRanking("Ian Machado Garry")).toBe("#1 Welterweight");
  });

  it("matches ESPN's ASCII spelling of Jan Blachowicz to UFC's #4 ranking", () => {
    expect(officialUfcRanking("Jan Blachowicz")).toBe("#4 Light Heavyweight");
  });

  it("resolves an aliased spelling to the same fighter", () => {
    expect(officialUfcRanking("Ian Garry")).toBe(
      officialUfcRanking("Ian Machado Garry"),
    );
  });

  it("ignores accents and word order", () => {
    expect(officialUfcRanking("Jiří Procházka")).toBe(
      officialUfcRanking("Jiri Prochazka"),
    );
    expect(officialUfcRanking("Prochazka, Jiri")).toBe(
      officialUfcRanking("Jiri Prochazka"),
    );
  });

  it("returns undefined for an unranked fighter rather than a label", () => {
    expect(officialUfcRanking("Someone Entirely Unranked")).toBeUndefined();
    expect(officialUfcRanking("Marcin Tybura")).toBeUndefined();
    expect(officialUfcRanking("Aleksandar Rakic")).toBeUndefined();
  });

  it("prefers the champion label over a numbered entry in the same division", () => {
    // ufc.com lists some champions inside their own numbered list too; the
    // champion label must win.
    const ranking = officialUfcRanking("Alexander Volkanovski");
    expect(ranking).toBe("Featherweight Champion");
  });

  it("covers every men's and women's division", async () => {
    const raw = await readFile("src/data/ufcRankings.json", "utf8");
    const snapshot = JSON.parse(raw) as {
      divisions: Record<string, { ranked: unknown[] }>;
    };

    // Eight men's plus three women's divisions; pound-for-pound is excluded
    // on purpose since it is not a divisional rank.
    expect(Object.keys(snapshot.divisions)).toHaveLength(11);
    for (const division of Object.values(snapshot.divisions)) {
      expect(division.ranked.length).toBeGreaterThan(0);
    }
  });
});
