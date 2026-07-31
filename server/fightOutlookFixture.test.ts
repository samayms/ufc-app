import { describe, expect, it } from "vitest";
import { loadFightOutlookFixture } from "./fightOutlookFixture.ts";

describe("loadFightOutlookFixture", () => {
  it("loads the on-disk fixture as a boutId -> outlook map without throwing", () => {
    const outlookByBoutId = loadFightOutlookFixture();
    expect(outlookByBoutId).toBeInstanceOf(Map);
  });
});
