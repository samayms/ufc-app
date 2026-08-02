import { type ReactNode, useEffect, useRef, useState } from "react";
import type { TransitionDirection } from "../lib/screenTransition.ts";
import "./screen-transition.css";

/**
 * Applies a slide-in animation to `children` whenever `screenKey` changes.
 * `direction` picks which edge the incoming screen slides in from —
 * computed by the caller via screenTransition.ts's `directionBetween`, since
 * only the caller knows the navigation stack shape (drill-in depth etc).
 *
 * `skipRemount`, when true for the render where `screenKey` changes, keeps
 * the wrapper's own React `key` unchanged instead of adopting the new
 * `screenKey` — `children` still updates normally (it's driven by the
 * caller's own state, not by this component's key), but React patches the
 * existing DOM in place rather than tearing it down and rebuilding it. Use
 * this when something else (e.g. a swipe gesture) already animated the
 * visual transition — the usual remount-to-replay-a-CSS-keyframe trick
 * would otherwise still fire here, reading as a redundant reload flash.
 */
export function ScreenTransition({
  screenKey,
  direction,
  skipRemount = false,
  children,
}: {
  screenKey: string;
  direction: TransitionDirection;
  skipRemount?: boolean;
  children: ReactNode;
}) {
  const [animClass, setAnimClass] = useState("");
  const lastKey = useRef(screenKey);
  const mountKey = useRef(screenKey);

  useEffect(() => {
    if (lastKey.current === screenKey) return;
    lastKey.current = screenKey;
    if (!skipRemount) {
      mountKey.current = screenKey;
    }
    setAnimClass(
      skipRemount || direction === "none"
        ? ""
        : direction === "forward"
          ? "screen-slide-in-forward"
          : "screen-slide-in-backward",
    );
  }, [screenKey, direction, skipRemount]);

  const renderKey = skipRemount ? mountKey.current : screenKey;

  return (
    <div key={renderKey} className={`screen-transition ${animClass}`}>
      {children}
    </div>
  );
}
