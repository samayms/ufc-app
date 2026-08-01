import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoadingSplash } from "./LoadingSplash.tsx";

describe("LoadingSplash", () => {
  it("never renders the word loading (or a synonym) as visible text", () => {
    const markup = renderToStaticMarkup(<LoadingSplash />);
    const visibleText = markup
      .replace(/<[^>]*aria-hidden="true"[^>]*>.*?<\/[a-z]+>/gi, "")
      .toLowerCase();

    expect(visibleText).not.toContain("loading");
    expect(visibleText).not.toContain("please wait");
    expect(visibleText).not.toContain("fetching");
  });

  it("still announces status to screen readers via role/aria-live", () => {
    const markup = renderToStaticMarkup(<LoadingSplash />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
  });

  it("renders the UFC wordmark", () => {
    const markup = renderToStaticMarkup(<LoadingSplash />);
    expect(markup).toContain("<svg");
    expect(markup).toContain("loading-splash-mark");
  });
});
