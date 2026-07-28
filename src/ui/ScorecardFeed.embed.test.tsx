// @vitest-environment jsdom
//
// This file mounts real DOM (via react-dom/client) to exercise the widgets
// script injection path, which `renderToStaticMarkup` (used by
// dashboard.test.tsx) never runs effects for. jsdom does not fetch external
// script resources by default (no `resources: "usable"` is configured
// anywhere in this repo), so appending a <script src="https://platform...">
// tag here never issues a real network request — it only ever produces a
// DOM node we can assert on.
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScorecardEmbed } from "../schema.ts";
import { assembleDashboard } from "../store/useDashboard.ts";
import { X_WIDGETS_SCRIPT_SRC } from "./xWidgetsScript.ts";

// Tells React this environment supports `act(...)` batching (jsdom via
// vitest doesn't set this on its own).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// A test-only placeholder post id, used only inside this test file to
// exercise the render path — never shipped, never a real X post.
const TEST_POST_ID = "0000000000000000001";

function widgetScripts(): NodeListOf<HTMLScriptElement> {
  return document.head.querySelectorAll<HTMLScriptElement>(
    `script[src="${X_WIDGETS_SCRIPT_SRC}"]`,
  );
}

describe("ScorecardFeed embed rendering (DOM)", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(async () => {
    // Each test gets a clean module registry so the widgets-script loader's
    // module-level singleton state doesn't leak between test cases.
    vi.resetModules();
    document.head.querySelectorAll("script").forEach((node) => node.remove());
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = undefined;
    }
    container.remove();
  });

  it("keeps the honest empty state and injects no script when no posts are configured", async () => {
    const { createRoot } = await import("react-dom/client");
    const { ScorecardFeed } = await import("./ScorecardFeed.tsx");

    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;
    expect(view.scorecards).toEqual([]);

    root = createRoot(container);
    act(() => {
      root!.render(
        <ScorecardFeed view={view} accounts={state.scorecardAccounts} />,
      );
    });

    expect(container.textContent).toContain(
      "No configured X scorecard posts for this round.",
    );
    expect(container.querySelector(".official-x-embed")).toBeNull();
    expect(widgetScripts().length).toBe(0);
  });

  it("renders a real embed and loads the widgets script exactly once when a post id is supplied", async () => {
    const { createRoot } = await import("react-dom/client");
    const { ScorecardFeed } = await import("./ScorecardFeed.tsx");

    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;

    const embed: ScorecardEmbed = {
      boutId: view.bout.id,
      handle: "MMAJunkie",
      postId: TEST_POST_ID,
      round: 1,
      provenance: {
        source: "x-embed",
        fetchedAt: "2026-07-28T00:00:00Z",
        synthetic: false,
      },
    };
    const viewWithEmbed = { ...view, scorecards: [embed] };

    root = createRoot(container);
    act(() => {
      root!.render(
        <ScorecardFeed
          view={viewWithEmbed}
          accounts={state.scorecardAccounts}
        />,
      );
    });

    const blockquote = container.querySelector("blockquote.official-x-embed");
    expect(blockquote).not.toBeNull();
    expect(blockquote?.querySelector("a")?.getAttribute("href")).toBe(
      `https://x.com/MMAJunkie/status/${TEST_POST_ID}`,
    );
    expect(container.textContent).not.toContain(
      "No configured X scorecard posts for this round.",
    );

    // Exactly one script tag, no matter how many embed cards mounted.
    expect(widgetScripts().length).toBe(1);
  });

  it("injects only one widgets script when multiple embeds mount at once", async () => {
    const { createRoot } = await import("react-dom/client");
    const { ScorecardFeed } = await import("./ScorecardFeed.tsx");

    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;

    const embeds: ScorecardEmbed[] = [
      {
        boutId: view.bout.id,
        handle: "MMAJunkie",
        postId: TEST_POST_ID,
        round: 1,
        provenance: {
          source: "x-embed",
          fetchedAt: "2026-07-28T00:00:00Z",
          synthetic: false,
        },
      },
      {
        boutId: view.bout.id,
        handle: "arielhelwani",
        postId: "0000000000000000002",
        round: 1,
        provenance: {
          source: "x-embed",
          fetchedAt: "2026-07-28T00:00:01Z",
          synthetic: false,
        },
      },
    ];
    const viewWithEmbeds = { ...view, scorecards: embeds };

    root = createRoot(container);
    act(() => {
      root!.render(
        <ScorecardFeed
          view={viewWithEmbeds}
          accounts={state.scorecardAccounts}
        />,
      );
    });

    expect(container.querySelectorAll("blockquote.official-x-embed").length).toBe(
      2,
    );
    expect(widgetScripts().length).toBe(1);
  });

  it("shows a readable fallback note instead of a broken widget if the script fails to load", async () => {
    const { createRoot } = await import("react-dom/client");
    const { ScorecardFeed } = await import("./ScorecardFeed.tsx");

    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;

    const embed: ScorecardEmbed = {
      boutId: view.bout.id,
      handle: "MMAJunkie",
      postId: TEST_POST_ID,
      round: 1,
      provenance: {
        source: "x-embed",
        fetchedAt: "2026-07-28T00:00:00Z",
        synthetic: false,
      },
    };
    const viewWithEmbed = { ...view, scorecards: [embed] };

    root = createRoot(container);
    act(() => {
      root!.render(
        <ScorecardFeed
          view={viewWithEmbed}
          accounts={state.scorecardAccounts}
        />,
      );
    });

    expect(container.textContent).not.toContain("Live preview unavailable");

    const script = widgetScripts()[0];
    expect(script).toBeDefined();
    act(() => {
      script!.dispatchEvent(new Event("error"));
    });

    expect(container.textContent).toContain("Live preview unavailable");
    // The plain link fallback is still present and still readable.
    const link = container.querySelector("blockquote.official-x-embed a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe(
      `https://x.com/MMAJunkie/status/${TEST_POST_ID}`,
    );
  });

  it("unsubscribes on unmount so no state updates fire after the component is gone", async () => {
    const { createRoot } = await import("react-dom/client");
    const { ScorecardFeed } = await import("./ScorecardFeed.tsx");

    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;

    const embed: ScorecardEmbed = {
      boutId: view.bout.id,
      handle: "MMAJunkie",
      postId: TEST_POST_ID,
      round: 1,
      provenance: {
        source: "x-embed",
        fetchedAt: "2026-07-28T00:00:00Z",
        synthetic: false,
      },
    };
    const viewWithEmbed = { ...view, scorecards: [embed] };

    root = createRoot(container);
    act(() => {
      root!.render(
        <ScorecardFeed
          view={viewWithEmbed}
          accounts={state.scorecardAccounts}
        />,
      );
    });

    const script = widgetScripts()[0];
    expect(script).toBeDefined();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => {
      root!.unmount();
    });
    root = undefined;

    // Firing the script's error event after unmount must not warn about
    // updating state on an unmounted component — the effect cleanup should
    // have already unsubscribed.
    act(() => {
      script!.dispatchEvent(new Event("error"));
    });

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
