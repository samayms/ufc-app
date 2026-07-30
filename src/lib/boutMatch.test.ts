import { describe, expect, it } from "vitest";

import {
  canonicalFighterKey,
  fighterNameSimilarity,
  matchBout,
  matchFighterPair,
  normalizeFighterName,
  scoreBoutCandidate,
  type MatchableBout,
} from "./boutMatch.ts";

const CARD_DATE = "2026-08-15T02:00:00.000Z";

const CARD: MatchableBout[] = [
  {
    boutId: "bout-main",
    redFighter: "Islam Makhachev",
    blueFighter: "Ian Machado Garry",
    startsAt: CARD_DATE,
    weightClass: "welterweight",
    promotion: "ufc",
  },
  {
    boutId: "bout-co-main",
    redFighter: "Merab Dvalishvili",
    blueFighter: "Petr Yan",
    startsAt: CARD_DATE,
    weightClass: "bantamweight",
    promotion: "ufc",
  },
];

describe("normalizeFighterName", () => {
  it("strips accents, punctuation, suffixes and word order", () => {
    expect(normalizeFighterName("José  Aldo, Jr.")).toBe("aldo jose");
    expect(normalizeFighterName("Aldo Jose")).toBe("aldo jose");
    expect(normalizeFighterName("Jiří Procházka")).toBe("jiri prochazka");
    expect(normalizeFighterName("Jan Błachowicz")).toBe("blachowicz jan");
    expect(normalizeFighterName("Jan Blachowicz")).toBe("blachowicz jan");
    expect(normalizeFighterName("Kevin Holland III")).toBe("holland kevin");
  });
});

describe("fighterNameSimilarity", () => {
  it("treats a dropped middle name as the same fighter", () => {
    expect(
      fighterNameSimilarity("Ian Garry", "Ian Machado Garry"),
    ).toBeGreaterThan(0.9);
  });

  it("requires two shared tokens before accepting a subset", () => {
    // A single surname is not enough — there are many Silvas.
    expect(fighterNameSimilarity("Silva", "Anderson Silva")).toBeLessThan(0.9);
  });

  it("tolerates a misspelling but not a different fighter", () => {
    expect(
      fighterNameSimilarity("Alexander Volkanovski", "Alexander Volkanovsky"),
    ).toBeGreaterThan(0.9);
    expect(
      fighterNameSimilarity("Alexander Volkanovski", "Alexander Volkov"),
    ).toBeLessThan(0.85);
  });

  it("applies the configured alias table", () => {
    expect(canonicalFighterKey("Ian Garry")).toBe(
      canonicalFighterKey("Ian Machado Garry"),
    );
    expect(fighterNameSimilarity("Ian Garry", "Ian Machado Garry")).toBe(1);
  });
});

describe("matchFighterPair", () => {
  it("detects reversed corners without losing confidence", () => {
    const direct = matchFighterPair(
      { redFighter: "Islam Makhachev", blueFighter: "Ian Machado Garry" },
      { redFighter: "Islam Makhachev", blueFighter: "Ian Machado Garry" },
    );
    const reversed = matchFighterPair(
      { redFighter: "Islam Makhachev", blueFighter: "Ian Machado Garry" },
      { redFighter: "Ian Machado Garry", blueFighter: "Islam Makhachev" },
    );

    expect(direct).toEqual({ confidence: 1, cornersReversed: false });
    expect(reversed).toEqual({ confidence: 1, cornersReversed: true });
  });
});

describe("scoreBoutCandidate", () => {
  const target = CARD[0] as MatchableBout;

  it("rejects a market from a different promotion outright", () => {
    expect(
      scoreBoutCandidate(target, {
        redFighter: "Islam Makhachev",
        blueFighter: "Ian Machado Garry",
        promotion: "pfl",
      }),
    ).toBeNull();
  });

  it("rejects a rematch listed outside the event-date window", () => {
    expect(
      scoreBoutCandidate(target, {
        redFighter: "Islam Makhachev",
        blueFighter: "Ian Machado Garry",
        startsAt: "2026-12-15T02:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("accepts a listing inside the event-date window", () => {
    const scored = scoreBoutCandidate(target, {
      redFighter: "Islam Makhachev",
      blueFighter: "Ian Machado Garry",
      startsAt: "2026-08-15T04:30:00.000Z",
    });
    expect(scored?.confidence).toBeGreaterThanOrEqual(1);
  });

  it("penalizes a weight-class disagreement", () => {
    const scored = scoreBoutCandidate(target, {
      redFighter: "Islam Makhachev",
      blueFighter: "Ian Machado Garry",
      weightClass: "lightweight",
    });
    expect(scored?.confidence).toBeLessThan(0.95);
  });
});

describe("matchBout", () => {
  it("matches a provider market with an alias and reversed corners", () => {
    const result = matchBout(CARD, {
      redFighter: "Ian Garry",
      blueFighter: "Islam Makhachev",
      startsAt: CARD_DATE,
      promotion: "ufc",
    });

    expect(result.status).toBe("matched");
    if (result.status !== "matched") return;
    expect(result.boutId).toBe("bout-main");
    expect(result.cornersReversed).toBe(true);
    expect(result.manual).toBe(false);
  });

  it("returns unmatched for a fight that is not on the card", () => {
    const result = matchBout(CARD, {
      redFighter: "Tom Aspinall",
      blueFighter: "Ciryl Gane",
      startsAt: CARD_DATE,
    });
    expect(result.status).toBe("unmatched");
  });

  it("returns ambiguous when two bouts score within the margin", () => {
    const twins: MatchableBout[] = [
      {
        boutId: "bout-a",
        redFighter: "Diego Lopes",
        blueFighter: "Movsar Evloev",
        startsAt: CARD_DATE,
      },
      {
        boutId: "bout-b",
        redFighter: "Diego Lopes",
        blueFighter: "Movsar Evloev",
        startsAt: CARD_DATE,
      },
    ];
    const result = matchBout(twins, {
      redFighter: "Diego Lopes",
      blueFighter: "Movsar Evloev",
      startsAt: CARD_DATE,
    });
    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
  });

  it("lets a manual override win over the name score", () => {
    const result = matchBout(
      CARD,
      {
        redFighter: "Completely Different",
        blueFighter: "Person Entirely",
      },
      { overrideBoutId: "bout-co-main" },
    );

    expect(result.status).toBe("matched");
    if (result.status !== "matched") return;
    expect(result.boutId).toBe("bout-co-main");
    expect(result.confidence).toBe(1);
    expect(result.manual).toBe(true);
  });

  it("ignores an override that names a bout outside the card", () => {
    const result = matchBout(
      CARD,
      { redFighter: "Islam Makhachev", blueFighter: "Ian Garry" },
      { overrideBoutId: "bout-not-here" },
    );
    expect(result.status).toBe("matched");
    if (result.status !== "matched") return;
    expect(result.boutId).toBe("bout-main");
    expect(result.manual).toBe(false);
  });
});
