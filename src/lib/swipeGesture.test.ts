import { describe, expect, it } from "vitest";
import { DEFAULT_SWIPE_CONFIG, isBackSwipe } from "./swipeGesture.ts";

describe("isBackSwipe", () => {
  it("qualifies a rightward swipe starting near the left edge", () => {
    expect(
      isBackSwipe({ x: 10, y: 200 }, { x: 120, y: 205 }, 390),
    ).toBe(true);
  });

  it("rejects a swipe that doesn't start near the left edge", () => {
    expect(
      isBackSwipe({ x: 200, y: 200 }, { x: 320, y: 205 }, 390),
    ).toBe(false);
  });

  it("rejects a swipe that doesn't travel far enough right", () => {
    expect(
      isBackSwipe({ x: 5, y: 200 }, { x: 20, y: 200 }, 390),
    ).toBe(false);
  });

  it("rejects a mostly-vertical gesture (a scroll, not a back-swipe)", () => {
    expect(
      isBackSwipe({ x: 10, y: 100 }, { x: 130, y: 260 }, 390),
    ).toBe(false);
  });

  it("respects a custom config", () => {
    const looseConfig = {
      ...DEFAULT_SWIPE_CONFIG,
      edgeZonePx: 200,
      minDistancePx: 10,
    };
    expect(
      isBackSwipe({ x: 150, y: 200 }, { x: 165, y: 200 }, 390, looseConfig),
    ).toBe(true);
  });
});
