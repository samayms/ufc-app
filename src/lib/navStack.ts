import type { EspnScheduledFight } from "../sources/espnSchedule.ts";
import type { AppTab } from "../ui/BottomNav.tsx";
import type { FightSection } from "../ui/SectionTabs.tsx";

/**
 * One screen's worth of navigation state — everything that decides *what*
 * the content area shows. Kept as a single value (rather than only as the
 * app's separate useState pieces) so a screen can be recorded, restored, or
 * rendered off-screen as a swipe-back preview without any of those three
 * paths re-deriving "where would back go" from scratch.
 */
export interface NavEntry {
  tab: AppTab;
  /** null = the Event tab's top-level list; otherwise the drilled event id. */
  scheduleSelection: string | null;
  /** A bout id on the current live event, or null for its default bout. */
  selected: string | null;
  /** A fight on some *other* (upcoming) event's card, if one was picked. */
  selectedFutureFight: EspnScheduledFight | null;
  section: FightSection;
}

/** Identity of the screen an entry shows: two entries with the same key are
 *  the same screen, whatever else differs between them. */
export function screenKeyOf(entry: NavEntry): string {
  if (entry.tab === "event") {
    return entry.scheduleSelection === null
      ? "event:list"
      : `event:drilled:${entry.scheduleSelection}`;
  }
  if (entry.tab === "fight") {
    return `fight:${
      entry.selectedFutureFight?.competitionId ?? entry.selected ?? "current"
    }`;
  }
  return "data";
}

// Orders every screen along a single forward/backward axis so the slide
// transition's direction is always correct, including for back navigation
// (swipe or button) landing on a screen that a naive two-bucket depth would
// tie with its own destination. The three bottom-nav tabs are ordered
// event < fight < data to match their left-to-right position in the nav bar,
// with generous spacing between tiers so a tab can still hold its own
// internal drill levels (e.g. the Event tab's list vs. drilled-in screen)
// without colliding with the next tab's tier.
export function screenDepth(key: string): number {
  if (key === "event:list") return 0;
  if (key.startsWith("event:drilled:")) return 1;
  if (key.startsWith("fight:")) return 100;
  if (key === "data") return 200;
  return 0;
}

/** Bounds the remembered stack so a long session can't grow it without
 *  limit; far deeper than any real back sequence anyone walks by hand. */
export const MAX_NAV_HISTORY = 24;

/**
 * History after navigating from `from` to `to` — i.e. what a later back
 * action should walk through.
 *
 * Revisiting a screen that's already remembered truncates back to it rather
 * than stacking a second copy: without that, ping-ponging between two
 * screens (Fight tab, Data tab, Fight tab, …) would build an arbitrarily
 * long chain of alternating entries that back then has to walk one by one.
 */
export function pushNav(
  history: NavEntry[],
  from: NavEntry,
  to: NavEntry,
): NavEntry[] {
  const toKey = screenKeyOf(to);
  // Re-selecting the screen you're already on isn't a navigation, so there's
  // nothing to remember — this is what makes tapping the bottom-nav tab you
  // already occupy (a scroll-to-top gesture) leave the stack alone.
  if (toKey === screenKeyOf(from)) return history;
  const revisited = history.findIndex((entry) => screenKeyOf(entry) === toKey);
  if (revisited >= 0) return history.slice(0, revisited);
  return [...history, from].slice(-MAX_NAV_HISTORY);
}

/**
 * Where back goes when nothing is remembered — the structural parent of the
 * current screen. A fight belongs to an event's bout order (its own event
 * when it was reached by drilling in, otherwise the live one), and a drilled
 * event belongs to the events list. Anything else is already top-level.
 */
export function structuralBackTarget(
  current: NavEntry,
  liveEventId: string | undefined,
): NavEntry | null {
  if (current.tab === "fight") {
    return {
      ...current,
      tab: "event",
      scheduleSelection: current.scheduleSelection ?? liveEventId ?? null,
      // Otherwise the bout row you just came from is still shown selected
      // when you land back on the event's bout list.
      selected: null,
      selectedFutureFight: null,
    };
  }
  if (current.tab === "event" && current.scheduleSelection !== null) {
    return { ...current, scheduleSelection: null };
  }
  return null;
}

/**
 * The single source of truth for back: the most recently remembered screen
 * if there is one, else the structural parent. Both the back button, the
 * swipe gesture, and the swipe-back underlay preview read this same value,
 * so the preview can never show a different destination than the one the
 * gesture actually lands on.
 */
export function backTargetOf(
  history: NavEntry[],
  current: NavEntry,
  liveEventId: string | undefined,
): NavEntry | null {
  return history.length > 0
    ? (history[history.length - 1] ?? null)
    : structuralBackTarget(current, liveEventId);
}

/** History after a back action consumed `backTargetOf`'s entry. */
export function popNav(history: NavEntry[]): NavEntry[] {
  return history.length > 0 ? history.slice(0, -1) : history;
}
