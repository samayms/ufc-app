export interface SwipePoint {
  x: number;
  y: number;
}

export interface SwipeConfig {
  /** How close to the left edge the touch must start, in px. */
  edgeZonePx: number;
  /** Minimum rightward travel to count as a back-swipe, in px. */
  minDistancePx: number;
  /** Reject gestures whose vertical drift exceeds this many px — those are
   *  scrolls, not intentional horizontal back-swipes. */
  maxVerticalDriftPx: number;
}

export const DEFAULT_SWIPE_CONFIG: SwipeConfig = {
  edgeZonePx: 24,
  minDistancePx: 80,
  maxVerticalDriftPx: 60,
};

/**
 * Whether a touch gesture from `start` to `end` qualifies as an
 * iOS-style edge swipe-right-to-go-back, within a container of
 * `containerWidthPx`. Pure function — no DOM, so it's trivially unit
 * testable without jsdom.
 */
export function isBackSwipe(
  start: SwipePoint,
  end: SwipePoint,
  containerWidthPx: number,
  config: SwipeConfig = DEFAULT_SWIPE_CONFIG,
): boolean {
  void containerWidthPx;
  if (start.x > config.edgeZonePx) return false;
  const dx = end.x - start.x;
  const dy = Math.abs(end.y - start.y);
  if (dx < config.minDistancePx) return false;
  if (dy > config.maxVerticalDriftPx) return false;
  return true;
}

/**
 * Whether an in-progress drag has moved clearly enough, and clearly enough
 * horizontally rather than vertically, to commit to a live back-swipe
 * (as opposed to an ordinary vertical scroll that happened to start near
 * the left edge). Once committed, the caller live-tracks the finger via
 * `clampDragPx` instead of waiting for the gesture to end.
 */
export function isHorizontalDragCommit(
  dx: number,
  dy: number,
  minCommitPx = 10,
): boolean {
  return Math.abs(dx) > minCommitPx && Math.abs(dx) > Math.abs(dy) * 1.5;
}

/** Clamps a rightward drag distance to the visible range [0, maxPx] — a
 *  back-swipe never drags left of its start or past the screen's own width. */
export function clampDragPx(dx: number, maxPx: number): number {
  return Math.min(Math.max(dx, 0), maxPx);
}
