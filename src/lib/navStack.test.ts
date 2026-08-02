import { describe, expect, it } from "vitest";
import type { EspnScheduledFight } from "../sources/espnSchedule.ts";
import {
  MAX_NAV_HISTORY,
  backTargetOf,
  popNav,
  pushNav,
  screenKeyOf,
  structuralBackTarget,
  type NavEntry,
} from "./navStack.ts";

const LIVE_EVENT = "evt-live";

function entry(overrides: Partial<NavEntry> = {}): NavEntry {
  return {
    tab: "fight",
    scheduleSelection: null,
    selected: null,
    selectedFutureFight: null,
    section: "summary",
    ...overrides,
  };
}

function futureFight(competitionId: string): EspnScheduledFight {
  return { competitionId } as EspnScheduledFight;
}

const eventList = entry({ tab: "event" });
const drilled330 = entry({ tab: "event", scheduleSelection: "ufc-330" });
const makhachevGarry = entry({
  selectedFutureFight: futureFight("makhachev-garry"),
  scheduleSelection: "ufc-330",
});
const recentlyCompleted = entry({
  selected: "bout-9",
  scheduleSelection: "ufc-330",
});

describe("screenKeyOf", () => {
  it("separates the events list, a drilled event, each fight, and data", () => {
    expect(screenKeyOf(eventList)).toBe("event:list");
    expect(screenKeyOf(drilled330)).toBe("event:drilled:ufc-330");
    expect(screenKeyOf(makhachevGarry)).toBe("fight:makhachev-garry");
    expect(screenKeyOf(entry({ selected: "bout-3" }))).toBe("fight:bout-3");
    expect(screenKeyOf(entry())).toBe("fight:current");
    expect(screenKeyOf(entry({ tab: "data" }))).toBe("data");
  });

  it("ignores state the screen doesn't show, so a section change isn't a screen change", () => {
    expect(screenKeyOf(entry({ selected: "bout-3", section: "stats" }))).toBe(
      screenKeyOf(entry({ selected: "bout-3", section: "tale" })),
    );
  });
});

describe("pushNav", () => {
  it("remembers the screen being left", () => {
    expect(pushNav([], eventList, drilled330)).toEqual([eventList]);
  });

  it("stacks a full drill-in path", () => {
    const afterDrill = pushNav([], eventList, drilled330);
    expect(pushNav(afterDrill, drilled330, makhachevGarry)).toEqual([
      eventList,
      drilled330,
    ]);
  });

  it("remembers a picked fight that a bottom-nav Fight tap jumps away from", () => {
    // The reported bug: events list -> UFC 330 card -> Makhachev vs. Garry ->
    // tap Fight (which jumps to the most recently completed bout). The fight
    // that was showing has to survive that jump as the back destination.
    const history = pushNav(
      pushNav([], eventList, drilled330),
      drilled330,
      makhachevGarry,
    );
    expect(pushNav(history, makhachevGarry, recentlyCompleted)).toEqual([
      eventList,
      drilled330,
      makhachevGarry,
    ]);
  });

  it("records nothing when the destination is the screen already showing", () => {
    // Tapping the bottom-nav tab you're already on: a scroll-to-top gesture,
    // not a navigation, so back must not start walking self-referential
    // entries.
    expect(pushNav([eventList], drilled330, drilled330)).toEqual([eventList]);
  });

  it("truncates back to a revisited screen instead of stacking a second copy", () => {
    const history = [eventList, drilled330, makhachevGarry];
    expect(pushNav(history, recentlyCompleted, drilled330)).toEqual([eventList]);
  });

  it("keeps ping-ponging between two screens from growing the stack", () => {
    const data = entry({ tab: "data" });
    let history: NavEntry[] = [];
    let current = recentlyCompleted;
    for (let i = 0; i < 10; i += 1) {
      const next = current === recentlyCompleted ? data : recentlyCompleted;
      history = pushNav(history, current, next);
      current = next;
    }
    expect(history.length).toBeLessThanOrEqual(1);
  });

  it("bounds how much it remembers", () => {
    let history: NavEntry[] = [];
    let current = eventList;
    for (let i = 0; i < MAX_NAV_HISTORY + 8; i += 1) {
      const next = entry({ selected: `bout-${i}` });
      history = pushNav(history, current, next);
      current = next;
    }
    expect(history).toHaveLength(MAX_NAV_HISTORY);
  });
});

describe("structuralBackTarget", () => {
  it("sends a fight reached without history to its own event's bout order", () => {
    expect(structuralBackTarget(makhachevGarry, LIVE_EVENT)).toEqual(
      entry({ tab: "event", scheduleSelection: "ufc-330" }),
    );
  });

  it("falls back to the live event for a fight opened directly", () => {
    expect(structuralBackTarget(entry({ selected: "bout-3" }), LIVE_EVENT))
      .toEqual(entry({ tab: "event", scheduleSelection: LIVE_EVENT }));
  });

  it("sends a drilled event back to the events list", () => {
    expect(structuralBackTarget(drilled330, LIVE_EVENT)).toEqual(eventList);
  });

  it("has no target from the top-level screens", () => {
    expect(structuralBackTarget(eventList, LIVE_EVENT)).toBeNull();
    expect(structuralBackTarget(entry({ tab: "data" }), LIVE_EVENT)).toBeNull();
  });
});

describe("backTargetOf", () => {
  it("prefers the remembered screen over the structural parent", () => {
    expect(
      backTargetOf([eventList, drilled330, makhachevGarry], recentlyCompleted, LIVE_EVENT),
    ).toEqual(makhachevGarry);
  });

  it("uses the structural parent once nothing is remembered", () => {
    expect(backTargetOf([], drilled330, LIVE_EVENT)).toEqual(eventList);
  });

  it("walks the whole recorded path one screen at a time", () => {
    let history = [eventList, drilled330, makhachevGarry];
    let current = recentlyCompleted;

    const visited: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const target = backTargetOf(history, current, LIVE_EVENT);
      expect(target).not.toBeNull();
      history = popNav(history);
      current = target as NavEntry;
      visited.push(screenKeyOf(current));
    }

    expect(visited).toEqual([
      "fight:makhachev-garry",
      "event:drilled:ufc-330",
      "event:list",
    ]);
    expect(backTargetOf(history, current, LIVE_EVENT)).toBeNull();
  });
});
