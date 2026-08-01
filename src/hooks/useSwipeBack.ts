import { useEffect, useRef } from "react";
import {
  DEFAULT_SWIPE_CONFIG,
  isBackSwipe,
  type SwipePoint,
} from "../lib/swipeGesture.ts";

/**
 * Attaches a swipe-right-to-go-back gesture to `ref`'s element. A no-op
 * (no listeners attached) whenever `onBack` is undefined, i.e. whenever the
 * current screen has no back target.
 */
export function useSwipeBack(
  ref: React.RefObject<HTMLElement | null>,
  onBack: (() => void) | undefined,
): void {
  const startRef = useRef<SwipePoint | null>(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  const hasBack = Boolean(onBack);

  useEffect(() => {
    const el = ref.current;
    if (!el || !hasBack) return;

    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      startRef.current = { x: touch.clientX, y: touch.clientY };
    };

    const handleTouchEnd = (e: TouchEvent) => {
      const start = startRef.current;
      startRef.current = null;
      if (!start) return;
      const touch = e.changedTouches[0];
      if (!touch) return;
      const end = { x: touch.clientX, y: touch.clientY };
      if (isBackSwipe(start, end, el.clientWidth, DEFAULT_SWIPE_CONFIG)) {
        onBackRef.current?.();
      }
    };

    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchend", handleTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchend", handleTouchEnd);
    };
  }, [ref, hasBack]);
}
