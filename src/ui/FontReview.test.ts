import { describe, expect, it } from "vitest";
import { FONT_VARIANTS, fontVariantFromSearch } from "./FontReview.tsx";

describe("font review", () => {
  it("offers distinct, uniquely addressable directions", () => {
    expect(FONT_VARIANTS).toHaveLength(8);
    expect(new Set(FONT_VARIANTS.map((variant) => variant.id)).size).toBe(8);
    expect(new Set(FONT_VARIANTS.map((variant) => variant.display)).size).toBe(
      8,
    );
  });

  it("selects a requested direction and safely falls back to the control", () => {
    expect(fontVariantFromSearch("?font=editorial").id).toBe("editorial");
    expect(fontVariantFromSearch("?font=unknown").id).toBe("baseline");
    expect(fontVariantFromSearch("").id).toBe("baseline");
  });

  it("uses swapping Google Fonts stylesheets for exploratory directions", () => {
    for (const variant of FONT_VARIANTS.slice(1)) {
      expect(variant.stylesheet).toContain("fonts.googleapis.com");
      expect(variant.stylesheet).toContain("display=swap");
    }
  });
});
