import { useEffect, useRef } from "react";

/**
 * Blocks the rubber-band pull specifically at the TOP of `ref`'s scrollable
 * element (dragging down while already scrolled to top), while leaving the
 * bounce at the bottom (dragging up while already scrolled to the end)
 * alone. CSS's `overscroll-behavior` can't express this — it applies to
 * both edges of an axis together — so this tracks touch position directly
 * and only calls `preventDefault()` for the specific top-edge case.
 *
 * `ready` must flip from false to true once the caller's `ref` element has
 * actually mounted. A ref object's identity never changes, so an effect
 * keyed only on `[ref]` runs exactly once and never again — if that one run
 * happens before the element exists (e.g. while a caller is still on an
 * earlier early-return branch that doesn't render it), the listeners never
 * attach at all. `ready` gives the effect a real second dependency that
 * changes when the element becomes available, so it re-runs at that point.
 */
export function useBlockPullToTop(
  ref: React.RefObject<HTMLElement | null>,
  ready: boolean,
): void {
  const lastYRef = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !ready) return;

    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      lastYRef.current = touch ? touch.clientY : null;
    };

    const handleTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      const lastY = lastYRef.current;
      if (!touch || lastY === null) return;
      const dy = touch.clientY - lastY;
      lastYRef.current = touch.clientY;

      // dy > 0 is a downward drag — at scrollTop 0, that's a pull past the
      // real top with nothing above it to reveal, not a genuine scroll.
      if (el.scrollTop <= 0 && dy > 0) {
        e.preventDefault();
      }
    };

    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
    };
  }, [ref, ready]);
}
