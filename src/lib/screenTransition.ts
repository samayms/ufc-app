export type TransitionDirection = "forward" | "backward" | "none";

/**
 * Direction to animate a screen change in, using each screen key's "depth"
 * (0 = top-level, higher = deeper/more drilled-in) as the ordering signal.
 * Pure function — no DOM, no React — so it's unit testable directly.
 */
export function directionBetween(
  previousKey: string | null,
  nextKey: string,
  depthOf: (key: string) => number,
): TransitionDirection {
  if (previousKey === null || previousKey === nextKey) return "none";
  const prevDepth = depthOf(previousKey);
  const nextDepth = depthOf(nextKey);
  return nextDepth < prevDepth ? "backward" : "forward";
}
