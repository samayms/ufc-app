import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackButton } from "./BackButton.tsx";

describe("BackButton", () => {
  it("renders a large, bold chevron with a generous icon-button size", () => {
    const markup = renderToStaticMarkup(<BackButton onClick={() => {}} />);

    expect(markup).toContain("size-6");
    expect(markup).toContain('stroke-width="2.5"');
    expect(markup).not.toContain("size-4");
  });

  it("still accepts a label and forwards onClick semantics unchanged", () => {
    const markup = renderToStaticMarkup(
      <BackButton onClick={() => {}} label="Events" />,
    );

    expect(markup).toContain("Events");
    expect(markup).toContain('aria-label="Events"');
  });
});
