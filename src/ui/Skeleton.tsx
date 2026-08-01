import "./skeleton.css";

/**
 * A single shimmering placeholder shape. Callers own sizing/shape entirely
 * through `className` — this component contributes only the shimmer
 * animation, matching the reserved-slot pattern used elsewhere in src/ui.
 */
export function Skeleton({ className }: { className?: string }): JSX.Element {
  return (
    <span
      className={`skeleton${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    />
  );
}

/** `count` repeated Skeleton rows, each also carrying `className`. */
export function SkeletonRows({
  count,
  className,
}: {
  count: number;
  className?: string;
}): JSX.Element {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={className} />
      ))}
    </>
  );
}
