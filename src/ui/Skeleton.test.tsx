import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Skeleton, SkeletonRows } from "./Skeleton.tsx";

describe("Skeleton", () => {
  it("renders a single shimmering, ARIA-hidden block with the caller's class", () => {
    const markup = renderToStaticMarkup(<Skeleton className="my-shape" />);
    expect(markup).toContain('class="skeleton my-shape"');
    expect(markup).toContain('aria-hidden="true"');
  });

  it("renders the requested number of rows, each carrying the row class", () => {
    const markup = renderToStaticMarkup(
      <SkeletonRows count={3} className="event-skeleton-row" />,
    );
    const matches = [...markup.matchAll(/event-skeleton-row/g)];
    expect(matches).toHaveLength(3);
  });
});
