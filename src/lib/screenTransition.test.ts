import { describe, expect, it } from "vitest";
import { directionBetween } from "./screenTransition.ts";

const DEPTH: Record<string, number> = {
  "event:list": 0,
  "event:drilled": 1,
  "fight:live": 1,
};
const depthOf = (key: string) => DEPTH[key] ?? 0;

describe("directionBetween", () => {
  it("is none for the very first screen (no previous key)", () => {
    expect(directionBetween(null, "event:list", depthOf)).toBe("none");
  });

  it("is forward when depth increases", () => {
    expect(
      directionBetween("event:list", "event:drilled", depthOf),
    ).toBe("forward");
  });

  it("is backward when depth decreases", () => {
    expect(
      directionBetween("event:drilled", "event:list", depthOf),
    ).toBe("backward");
  });

  it("is none when the key doesn't change", () => {
    expect(
      directionBetween("event:drilled", "event:drilled", depthOf),
    ).toBe("none");
  });

  it("treats equal depth across different keys as forward", () => {
    expect(
      directionBetween("event:drilled", "fight:live", depthOf),
    ).toBe("forward");
  });
});
