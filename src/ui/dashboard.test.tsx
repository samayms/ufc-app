import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  assembleDashboard,
  dashboardDemoState,
} from "../store/useDashboard.ts";
import { FightSummary } from "./FightSummary.tsx";
import {
  completedRounds,
  defaultRoundSelection,
  RoundSelector,
} from "./RoundSelector.tsx";
import { SourceStatus } from "./SourceStatus.tsx";

describe("dashboard state surfaces", () => {
  it("parses only supported visual demo states", () => {
    expect(dashboardDemoState("?demo=stale")).toBe("stale");
    expect(dashboardDemoState("?demo=error")).toBe("error");
    expect(dashboardDemoState("?demo=unknown")).toBe("default");
  });

  it("switches the selected round without enabling future rounds", async () => {
    const state = await assembleDashboard();
    const view = state.boutViews["bout-main"];
    expect(view).toBeDefined();
    if (!view) return;

    expect(completedRounds(view)).toEqual([1, 2]);
    expect(defaultRoundSelection(view)).toBe(2);

    const roundOne = renderToStaticMarkup(
      <RoundSelector view={view} value={1} onChange={() => undefined} />,
    );
    const totals = renderToStaticMarkup(
      <RoundSelector view={view} value="total" onChange={() => undefined} />,
    );
    expect(roundOne).toContain('aria-selected="true"');
    expect(roundOne).toContain(">R1</button>");
    expect(roundOne).toContain(">R3</button>");
    expect(roundOne).toContain("disabled");
    expect(totals).toContain("round-tab-total is-active");
  });

  it("renders honest missing-round and stale-source states", async () => {
    const state = await assembleDashboard();
    const upcoming = state.boutViews["bout-3"];
    expect(upcoming).toBeDefined();
    if (!upcoming) return;

    const missing = renderToStaticMarkup(
      <FightSummary view={upcoming} selection={1} />,
    );
    expect(missing).toContain("Stats lock in after each completed round.");
    expect(missing).toContain(
      "A grounded summary will appear after the round is complete.",
    );

    const stale = renderToStaticMarkup(
      <SourceStatus state={state} stale />,
    );
    expect(stale).toContain("Stale");
    expect(stale).toContain("last valid completed-round snapshot");
  });
});
