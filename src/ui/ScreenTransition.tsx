import { type ReactNode, useEffect, useRef, useState } from "react";
import type { TransitionDirection } from "../lib/screenTransition.ts";
import "./screen-transition.css";

/**
 * Applies a slide-in animation to `children` whenever `screenKey` changes.
 * `direction` picks which edge the incoming screen slides in from —
 * computed by the caller via screenTransition.ts's `directionBetween`, since
 * only the caller knows the navigation stack shape (drill-in depth etc).
 */
export function ScreenTransition({
  screenKey,
  direction,
  children,
}: {
  screenKey: string;
  direction: TransitionDirection;
  children: ReactNode;
}) {
  const [animClass, setAnimClass] = useState("");
  const lastKey = useRef(screenKey);

  useEffect(() => {
    if (lastKey.current === screenKey) return;
    lastKey.current = screenKey;
    setAnimClass(
      direction === "forward"
        ? "screen-slide-in-forward"
        : direction === "backward"
          ? "screen-slide-in-backward"
          : "",
    );
  }, [screenKey, direction]);

  return (
    <div key={screenKey} className={`screen-transition ${animClass}`}>
      {children}
    </div>
  );
}
