import { useEffect, useRef } from "react";
import {
  DEFAULT_SWIPE_CONFIG,
  clampDragPx,
  isBackSwipe,
  isHorizontalDragCommit,
  type SwipePoint,
} from "../lib/swipeGesture.ts";

/** How long the two post-release animations take: snapping back to 0 when
 *  the drag didn't clear the threshold, or finishing the slide off-screen
 *  when it did. Short enough to feel like a continuation of the gesture
 *  rather than a separate, disconnected transition. */
const SNAP_BACK_MS = 200;
const COMPLETE_MS = 150;

/**
 * Attaches a swipe-right-to-go-back gesture to `ref`'s element. A no-op
 * (no listeners attached) whenever `onBack` is undefined, i.e. whenever the
 * current screen has no back target.
 *
 * The dragged element tracks the finger 1:1 during the gesture (no CSS
 * transition while a touch is active — only the two post-release snaps use
 * one), so the motion reads as directly connected to the thumb doing the
 * swiping rather than a canned animation that starts once you lift off.
 */
export function useSwipeBack(
  ref: React.RefObject<HTMLElement | null>,
  onBack: (() => void) | undefined,
): void {
  const startRef = useRef<SwipePoint | null>(null);
  const committedRef = useRef(false);
  const lastPointRef = useRef<SwipePoint | null>(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  const hasBack = Boolean(onBack);

  useEffect(() => {
    const el = ref.current;
    if (!el || !hasBack) return;

    const resetStyles = () => {
      el.style.transition = "";
      el.style.transform = "";
    };

    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      startRef.current = { x: touch.clientX, y: touch.clientY };
      lastPointRef.current = startRef.current;
      committedRef.current = false;
      el.style.transition = "none";
    };

    const handleTouchMove = (e: TouchEvent) => {
      const start = startRef.current;
      const touch = e.touches[0];
      if (!start || !touch) return;
      const point = { x: touch.clientX, y: touch.clientY };
      lastPointRef.current = point;
      const dx = point.x - start.x;
      const dy = point.y - start.y;

      if (!committedRef.current) {
        if (start.x > DEFAULT_SWIPE_CONFIG.edgeZonePx) return;
        if (!isHorizontalDragCommit(dx, dy)) return;
        if (dx <= 0) return;
        committedRef.current = true;
      }

      // Committed to a horizontal back-swipe — stop the page's own vertical
      // scroll/gesture handling from also engaging, and move the screen
      // exactly as far as the finger has, every frame.
      e.preventDefault();
      const clamped = clampDragPx(dx, el.clientWidth);
      el.style.transform = `translateX(${clamped}px)`;
    };

    const finishGesture = (committed: boolean) => {
      const width = el.clientWidth;
      if (committed) {
        el.style.transition = `transform ${COMPLETE_MS}ms ease-out`;
        el.style.transform = `translateX(${width}px)`;
        window.setTimeout(() => {
          resetStyles();
          onBackRef.current?.();
        }, COMPLETE_MS);
      } else {
        el.style.transition = `transform ${SNAP_BACK_MS}ms ease-out`;
        el.style.transform = "translateX(0)";
        window.setTimeout(resetStyles, SNAP_BACK_MS);
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      const start = startRef.current;
      const wasCommitted = committedRef.current;
      startRef.current = null;
      committedRef.current = false;
      if (!start) return;
      const touch = e.changedTouches[0] ?? lastPointRef.current;
      if (!touch) {
        resetStyles();
        return;
      }
      const end = "clientX" in touch
        ? { x: touch.clientX, y: touch.clientY }
        : touch;
      if (!wasCommitted) {
        resetStyles();
        return;
      }
      const qualifies = isBackSwipe(start, end, el.clientWidth, DEFAULT_SWIPE_CONFIG);
      finishGesture(qualifies);
    };

    const handleTouchCancel = () => {
      startRef.current = null;
      committedRef.current = false;
      resetStyles();
    };

    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    el.addEventListener("touchend", handleTouchEnd, { passive: true });
    el.addEventListener("touchcancel", handleTouchCancel, { passive: true });
    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
      el.removeEventListener("touchcancel", handleTouchCancel);
      resetStyles();
    };
  }, [ref, hasBack]);
}
