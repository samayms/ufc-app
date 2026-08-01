import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackButton } from "./BackButton.tsx";

describe("BackButton", () => {
  it("renders a large, bold chevron with a generous icon-button size", () => {
    const markup = renderToStaticMarkup(<BackButton onClick={() => {}} />);

    const svgClass = markup.match(/<svg[^>]*class="([^"]*)"/)?.[1] ?? "";
    expect(svgClass.split(" ")).toContain("size-6");
    expect(svgClass.split(" ")).not.toContain("size-4");
    expect(markup).toContain('stroke-width="2.5"');
  });

  it("still accepts a label and forwards onClick semantics unchanged", () => {
    const markup = renderToStaticMarkup(
      <BackButton onClick={() => {}} label="Events" />,
    );

    expect(markup).toContain("Events");
    expect(markup).toContain('aria-label="Events"');
  });
});
