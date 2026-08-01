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
