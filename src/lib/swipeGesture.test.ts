import { describe, expect, it } from "vitest";
import {
  DEFAULT_SWIPE_CONFIG,
  clampDragPx,
  isBackSwipe,
  isHorizontalDragCommit,
} from "./swipeGesture.ts";

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

describe("isHorizontalDragCommit", () => {
  it("commits once horizontal movement clearly dominates vertical", () => {
    expect(isHorizontalDragCommit(20, 2)).toBe(true);
  });

  it("does not commit while movement is still tiny (a tap, not a drag)", () => {
    expect(isHorizontalDragCommit(4, 1)).toBe(false);
  });

  it("does not commit when the drag is mostly vertical (a scroll)", () => {
    expect(isHorizontalDragCommit(12, 20)).toBe(false);
  });

  it("respects a custom minimum", () => {
    expect(isHorizontalDragCommit(15, 0, 20)).toBe(false);
  });
});

describe("clampDragPx", () => {
  it("passes an in-range value through unchanged", () => {
    expect(clampDragPx(120, 390)).toBe(120);
  });

  it("floors a leftward (negative) drag at 0", () => {
    expect(clampDragPx(-40, 390)).toBe(0);
  });

  it("caps a drag past the container width", () => {
    expect(clampDragPx(500, 390)).toBe(390);
  });
});
