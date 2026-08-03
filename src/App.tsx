import { useEffect, useRef, useState } from "react";
import { useDashboard } from "./store/useDashboard.ts";
import { BackButton } from "./ui/BackButton.tsx";
import { BottomNav, type AppTab } from "./ui/BottomNav.tsx";
import { BoutHeader } from "./ui/BoutHeader.tsx";
import { CardRail } from "./ui/CardRail.tsx";
import { EventList, type EventListEntry } from "./ui/EventList.tsx";
import { FightSummary } from "./ui/FightSummary.tsx";
import { useSwipeBack } from "./hooks/useSwipeBack.ts";
import { useBlockPullToTop } from "./hooks/useBlockPullToTop.ts";
import { LiveStatsPanel } from "./ui/LiveStatsPanel.tsx";
import { LoadingSplash } from "./ui/LoadingSplash.tsx";
import { withoutSportsbookOnEventDay } from "./lib/marketPriority.ts";
import { MarketStrip } from "./ui/MarketStrip.tsx";
import { directionBetween, type TransitionDirection } from "./lib/screenTransition.ts";
import {
  backTargetOf,
  popNav,
  pushNav,
  screenDepth,
  screenKeyOf,
  type NavEntry,
} from "./lib/navStack.ts";
import { ScreenTransition } from "./ui/ScreenTransition.tsx";
import {
  defaultRoundSelection,
  RoundSelector,
  type RoundSelection,
} from "./ui/RoundSelector.tsx";
import { ScheduledCardRail } from "./ui/ScheduledCardRail.tsx";
import {
  boutToScheduledFight,
  taleStatValues,
  UpcomingOddsSection,
  UpcomingTaleSection,
  ScheduledFightPreview,
} from "./ui/ScheduledFightPreview.tsx";
import { ScorecardFeed } from "./ui/ScorecardFeed.tsx";
import { SkeletonRows } from "./ui/Skeleton.tsx";
import {
  SectionTabs,
  type FightSection,
} from "./ui/SectionTabs.tsx";
import { SourceStatus } from "./ui/SourceStatus.tsx";
import { EventSubheader, TopBar } from "./ui/TopBar.tsx";
import { WEIGHT_LABEL } from "./ui/format.ts";
import {
  hasEventCompleted,
  hasEventStarted,
  sameEvent,
} from "./lib/eventIdentity.ts";
import { useEspnCard, useUpcomingEspnEvents } from "./store/useEspnSchedule.ts";
import { useUpcomingOdds } from "./store/useUpcomingOdds.ts";
import {
  fighterEspnAthleteId,
  useCurrentEventAthletePhotos,
  useUpcomingEventPhotos,
} from "./store/useEventPhotos.ts";
import type { BoutView } from "./schema.ts";
import type { EspnScheduledFight } from "./sources/espnSchedule.ts";
import "./ui/dashboard.css";

export function LiveOddsSection({
  view,
  upcomingOdds,
  deliveries,
}: {
  view: BoutView;
  upcomingOdds: ReturnType<typeof useUpcomingOdds>;
  /** Compatibility-only: metadata is no longer rendered in this surface. */
  deliveries?: unknown;
}) {
  void deliveries;
  return (
    <UpcomingOddsSection
      fight={boutToScheduledFight(view.bout)}
      upcoming={upcomingOdds}
      liveView={view}
    />
  );
}

// Matches SectionTabs.tsx's own default tab order (Fight, Stats, Odds,
// Tale) so the section content slides in the same left-to-right direction
// the tab strip itself implies, regardless of which subset of tabs a given
// bout status actually renders (e.g. a final bout drops the Odds tab).
const SECTION_ORDER: FightSection[] = ["summary", "stats", "odds", "tale"];

function sectionDepth(key: string): number {
  return SECTION_ORDER.indexOf(key as FightSection);
}

/** Finds the ESPN fightcenter fight matching a canonical bout id, if the card is loaded. */
function findEspnFight(
  card: { sections: { fights: EspnScheduledFight[] }[] } | null,
  boutId: string,
): EspnScheduledFight | undefined {
  if (!card) return undefined;
  for (const section of card.sections) {
    const match = section.fights.find((fight) => fight.competitionId === boutId);
    if (match) return match;
  }
  return undefined;
}

/** Whether the reader has asked the OS to keep motion to a minimum — the
 *  same signal screen-transition.css honours for its slide keyframes. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

export default function App() {
  const dashboard = useDashboard();
  const state = dashboard.data;
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<AppTab>("fight");
  const [section, setSection] = useState<FightSection>("summary");
  const [round, setRound] = useState<RoundSelection>(1);
  // null = the Event tab's top-level events list; the current event's own id
  // or an ESPN event id = drilled into that one event's fight list.
  const [scheduleSelection, setScheduleSelection] = useState<string | null>(
    null,
  );
  const [selectedFutureFight, setSelectedFutureFight] =
    useState<EspnScheduledFight | null>(null);
  // Screens already visited, oldest first — the back stack. Every navigation
  // that changes which screen is showing records the one being left (see
  // navigateTo), so back restores an actual previously-seen screen instead
  // of re-deriving a plausible parent from the current state. That
  // re-derivation is what made a bottom-nav Fight tap (which jumps to the
  // most recently completed bout) lose the fight you were reading: the only
  // record of it was the very state the jump overwrote.
  const [navHistory, setNavHistory] = useState<NavEntry[]>([]);
  const mainContentRef = useRef<HTMLElement>(null);
  // The swipe-back "underlay" — a live, already-rendered preview of the
  // screen a back gesture leads to, kept positioned just off-screen so it's
  // instantly there (not re-fetched or re-mounted) the moment a drag starts,
  // and revealed in lockstep with the finger rather than only appearing
  // once the gesture completes.
  const underlayRef = useRef<HTMLDivElement>(null);
  // One-shot override for screenDirection, consumed by the next screenKey
  // change then cleared — see the swipeBackHandler wrapper below, which
  // uses this to suppress ScreenTransition's own slide-in keyframe for a
  // swipe-completed navigation (the gesture itself already animated it).
  const forcedScreenDirectionRef = useRef<TransitionDirection | null>(null);
  // Paired with forcedScreenDirectionRef: also suppresses the remount
  // ScreenTransition's key change would otherwise trigger, which — even
  // with the slide-in class suppressed — still tore the whole screen's DOM
  // down and rebuilt it, reading as a brief "reload" flash right after a
  // swipe-completed navigation already finished its own animation.
  const forcedSkipRemountRef = useRef(false);

  const upcomingEspn = useUpcomingEspnEvents();
  // Loaded at the app level rather than per preview: one document covers every
  // upcoming card, so drilling between fights must not refetch it.
  const upcomingOdds = useUpcomingOdds();
  const currentEventId = state?.event.id;
  // scheduleSelection only names a real ESPN event id once it's neither the
  // list screen (null) nor the current event's own internal id.
  const futureEventId =
    scheduleSelection !== null && scheduleSelection !== currentEventId
      ? scheduleSelection
      : null;
  const espnCard = useEspnCard(futureEventId);
  // The current dashboard event's own ESPN fightcenter card — separate from
  // espnCard above (which only ever names a *different*, browsed-to event).
  // Bout/Fighter (the canonical, collector-fed shape entryView.bout carries)
  // has no career-stat field at all, so the Tale tab's stat rows need this
  // fetch even for the event already on screen.
  const currentEspnCard = useEspnCard(currentEventId ?? null);
  const upcomingEventPhotos = useUpcomingEventPhotos(
    upcomingEspn.status === "ready" ? upcomingEspn.events : [],
  );
  const currentEventAthletePhotos = useCurrentEventAthletePhotos(state?.event);

  useEffect(() => {
    if (!state) return;
    const active = state.event.bouts.find(
      (bout) =>
        bout.status === "in-round" || bout.status === "between-rounds",
    );
    const id = selected ?? active?.id ?? state.event.bouts[0]?.id;
    const nextView = id ? state.boutViews[id] : undefined;
    if (nextView) setRound(defaultRoundSelection(nextView));
  }, [selected, state]);

  // Everything that decides which screen the content area shows, as one
  // value — so it can be recorded on the back stack, restored from it, and
  // rendered off-screen as the swipe-back preview, all from the same shape.
  // Defined here (above the loading/error early returns) and null-tolerant
  // so the hooks below it — and useSwipeBack itself — run unconditionally
  // on every render, as React's Rules of Hooks require.
  const currentNav: NavEntry = {
    tab,
    scheduleSelection,
    selected,
    selectedFutureFight,
    section,
  };
  const screenKey = screenKeyOf(currentNav);

  // Reset scroll position whenever the visible screen changes — otherwise
  // .app-content keeps its previous scroll offset and a freshly drilled-into
  // screen (e.g. an event's bout order) can load already scrolled past its
  // own heading.
  useEffect(() => {
    mainContentRef.current?.scrollTo({ top: 0 });
  }, [screenKey]);

  const applyNav = (entry: NavEntry) => {
    setTab(entry.tab);
    setScheduleSelection(entry.scheduleSelection);
    setSelected(entry.selected);
    setSelectedFutureFight(entry.selectedFutureFight);
    setSection(entry.section);
  };

  // The single forward-navigation entry point: every screen change goes
  // through here so the screen being left is always recorded, without each
  // call site having to remember to do it.
  const navigateTo = (changes: Partial<NavEntry>) => {
    const next = { ...currentNav, ...changes };
    setNavHistory((history) => pushNav(history, currentNav, next));
    applyNav(next);
  };

  // Where back goes: the last recorded screen, or — when nothing's recorded
  // yet, e.g. on a fight the app opened straight into — that screen's
  // structural parent. Read once, here, and used for all three of the back
  // button, the swipe gesture, and the swipe-back underlay preview, so the
  // preview can't show a destination the gesture doesn't actually land on.
  const backEntry = !state
    ? null
    : backTargetOf(navHistory, currentNav, state.event.id);

  const goBack = () => {
    if (!backEntry) return;
    // Both screens can sit at the same depth (returning to the fight you
    // were reading before a Fight-tab jump, say), which directionBetween's
    // depth model reads as a forward move. A back action is never forward.
    forcedScreenDirectionRef.current = "backward";
    setNavHistory(popNav);
    applyNav(backEntry);
  };

  const activeBackHandler = backEntry ? goBack : undefined;

  // A swipe gesture already performs its own finger-tracked slide (see
  // useSwipeBack) — by the time it calls this, the underlay has already
  // visually settled into the new screen's exact final position. Without
  // suppressing both of these, ScreenTransition would then also remount
  // and play its own slide-in keyframe on top of that, reading as a
  // second, redundant "reload" flash right after the gesture already
  // finished. The back BUTTON has no such gesture to hand off from, so it
  // keeps using activeBackHandler directly and still gets the normal
  // remount + slide-in.
  const swipeBackHandler = activeBackHandler
    ? () => {
        activeBackHandler();
        forcedScreenDirectionRef.current = "none";
        forcedSkipRemountRef.current = true;
      }
    : undefined;

  useSwipeBack(mainContentRef, swipeBackHandler, underlayRef);
  useBlockPullToTop(mainContentRef, Boolean(state));

  // Direction for ScreenTransition's slide animation, from the screen key
  // computed above.
  const previousScreenKeyRef = useRef<string | null>(null);
  const screenDirection =
    forcedScreenDirectionRef.current ??
    directionBetween(previousScreenKeyRef.current, screenKey, screenDepth);
  const skipScreenRemount = forcedSkipRemountRef.current;
  useEffect(() => {
    previousScreenKeyRef.current = screenKey;
    forcedScreenDirectionRef.current = null;
    forcedSkipRemountRef.current = false;
  }, [screenKey]);

  const previousSectionRef = useRef<string | null>(null);
  const sectionDirection = directionBetween(
    previousSectionRef.current,
    section,
    sectionDepth,
  );
  useEffect(() => {
    previousSectionRef.current = section;
  }, [section]);

  if (dashboard.status === "loading") {
    return <LoadingSplash />;
  }

  if (dashboard.status === "error" || !state) {
    return (
      <div className="app-state error-state" role="alert">
        <span className="error-code num">SOURCE ERROR</span>
        <strong>Fight data is temporarily unavailable</strong>
        <span>
          {dashboard.message ??
            "The latest snapshot could not be loaded. Existing completed-round data was not cleared."}
        </span>
        <button type="button" className="retry-button" onClick={dashboard.reload}>
          Retry snapshot
        </button>
      </div>
    );
  }

  const { event, boutViews } = state;
  const live = event.bouts.find(
    (b) => b.status === "in-round" || b.status === "between-rounds",
  );
  // Which bout of the live event a nav entry resolves to: the one it names,
  // or — for an entry that never picked one — whatever's running now, or the
  // top of the card.
  const boutIdFor = (entry: NavEntry) =>
    entry.selected ?? live?.id ?? event.bouts[0]?.id;
  const selectedId = boutIdFor(currentNav);
  // "total" means the scorecard feed should show through the last round the
  // collector has actually recorded for that bout.
  const resolveRound = (
    boutView: BoutView,
    selection: RoundSelection,
  ): number =>
    selection === "total"
      ? Math.max(
          0,
          ...(dashboard.collector?.unifiedRounds
            .filter((record) => record.boutId === boutView.bout.id)
            .map((record) => record.round) ?? []),
        )
      : selection;
  const selectBout = (id: string) => {
    navigateTo({
      selected: id,
      tab: "fight",
      section: "summary",
      selectedFutureFight: null,
    });
  };

  const selectFutureFight = (fight: EspnScheduledFight) => {
    navigateTo({ selectedFutureFight: fight, tab: "fight" });
  };

  // Bottom-nav taps. Both of the "always land somewhere specific" tabs below
  // are non-destructive despite overwriting the current screen: the screen
  // they replace goes on the back stack (navigateTo), so back — button or
  // swipe — returns to the exact fight or drilled card that was showing.
  //
  // "Fight" jumps to whichever bout in the current live event finished most
  // recently (lowest cardPosition among final bouts — the card airs from the
  // highest cardPosition down to the main event, so that's the last one to
  // finish); if nothing's finished yet it keeps showing whatever it was.
  //
  // "Event" goes to the events list itself, not to whatever event was last
  // drilled into — the tab is named for that list, so tapping it should land
  // on it, at the top.
  const handleNavTabChange = (next: AppTab) => {
    const mostRecentCompleted = event.bouts
      .filter((bout) => bout.status === "final")
      .sort((a, b) => a.cardPosition - b.cardPosition)[0];
    const changes: Partial<NavEntry> =
      next === "event"
        ? { tab: "event", scheduleSelection: null }
        : next !== "fight"
          ? { tab: next }
          : mostRecentCompleted
            ? {
                tab: "fight",
                selected: mostRecentCompleted.id,
                section: "summary",
                selectedFutureFight: null,
              }
            : { tab: "fight" };
    const staysOnSameScreen =
      screenKeyOf({ ...currentNav, ...changes }) === screenKey;
    navigateTo(changes);
    // Tapping the tab you're already on leaves every piece of navigation
    // state untouched, so the screen-key scroll-reset effect never fires —
    // yet the tap should still take you to the top. Scroll it there
    // *animated*: nothing else on screen changes, so an instant jump reads
    // as the list teleporting, with no way to tell how far you moved.
    // Screen-CHANGING taps deliberately keep the effect's instant reset —
    // a screen you haven't seen yet should simply arrive at its top rather
    // than be watched scrolling to it.
    if (staysOnSameScreen) {
      mainContentRef.current?.scrollTo({
        top: 0,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    }
  };

  const mainBout = event.bouts.find((bout) => bout.cardPosition === 1);
  const mainBoutPhotoUrl = (corner: "red" | "blue") => {
    const fighter = mainBout?.fighters[corner];
    if (!fighter) return undefined;
    const athleteId = fighterEspnAthleteId(fighter.externalRefs);
    return athleteId ? currentEventAthletePhotos[athleteId] : undefined;
  };
  const eventStarted = hasEventStarted(event.startsAt);
  const eventCompleted = hasEventCompleted(event.bouts);

  const dashboardEventEntry: EventListEntry = {
    id: event.id,
    name: event.name,
    startsAt: event.startsAt,
    isComplete: eventCompleted,
    isLive: eventStarted &&
      !eventCompleted &&
      event.bouts.some(
        (bout) =>
          bout.status === "upcoming" ||
          bout.status === "in-round" ||
          bout.status === "between-rounds",
      ),
    ...(mainBout
      ? {
          redFighter: {
            name: mainBout.fighters.red.name,
            photoUrl: mainBoutPhotoUrl("red"),
          },
          blueFighter: {
            name: mainBout.fighters.blue.name,
            photoUrl: mainBoutPhotoUrl("blue"),
          },
        }
      : {}),
  };
  const currentEventEntry = eventStarted && !eventCompleted
    ? dashboardEventEntry
    : null;

  const scheduleEventEntries: EventListEntry[] = (
    upcomingEspn.status === "ready" ? upcomingEspn.events : []
  )
    .filter(
      (upcomingEvent) =>
        !sameEvent(
          { id: event.id, name: event.name },
          { id: upcomingEvent.eventId, name: upcomingEvent.name },
        ),
    )
    .map((upcomingEvent) => {
      const corners = upcomingEventPhotos[upcomingEvent.eventId];
      return {
        id: upcomingEvent.eventId,
        name: upcomingEvent.name,
        startsAt: upcomingEvent.startsAt,
        isComplete: upcomingEvent.status === "completed",
        isLive: upcomingEvent.status !== "completed" &&
          (upcomingEvent.status === "live" ||
            hasEventStarted(upcomingEvent.startsAt)),
        ...(corners?.red
          ? { redFighter: { name: corners.red.name, photoUrl: corners.red.headshotUrl } }
          : {}),
        ...(corners?.blue
          ? { blueFighter: { name: corners.blue.name, photoUrl: corners.blue.headshotUrl } }
          : {}),
      };
    });
  if (
    currentEventEntry === null &&
    !scheduleEventEntries.some((entry) => sameEvent(entry, dashboardEventEntry))
  ) {
    scheduleEventEntries.unshift(dashboardEventEntry);
  }

  const photosByBoutId: Record<string, { red?: string; blue?: string }> = {};
  for (const bout of event.bouts) {
    const redId = fighterEspnAthleteId(bout.fighters.red.externalRefs);
    const blueId = fighterEspnAthleteId(bout.fighters.blue.externalRefs);
    photosByBoutId[bout.id] = {
      red: redId ? currentEventAthletePhotos[redId] : undefined,
      blue: blueId ? currentEventAthletePhotos[blueId] : undefined,
    };
  }

  const selectedScheduleEventName =
    scheduleSelection === null
      ? undefined
      : scheduleSelection === event.id
        ? event.name
        : espnCard.card?.name ??
          scheduleEventEntries.find((entry) => entry.id === scheduleSelection)
            ?.name;

  const subheaderEventName =
    tab === "fight"
      ? selectedFutureFight
        ? (selectedScheduleEventName ?? event.name)
        : event.name
      : event.name;

  // The Event tab's screen for a given nav entry — extracted so the swipe-
  // back underlay below can render "what going back would show" from the
  // same code as the live screen, kept in sync rather than a second,
  // drifting copy.
  const renderEventScreen = (
    entry: NavEntry,
    // Drops the id/aria-labelledby pairing for the swipe-back underlay's
    // copy — otherwise, while it's mounted alongside the live main content
    // (both call this same function), the page ends up with two elements
    // sharing id="card-title", which is invalid HTML even though the
    // underlay's own aria-hidden="true" wrapper already keeps it out of the
    // accessibility tree.
    forUnderlay = false,
  ) => {
    const virtualSelection = entry.scheduleSelection;
    const titleId = forUnderlay ? undefined : "card-title";
    if (virtualSelection === null) {
      return (
        <section className="card-screen" aria-labelledby={titleId}>
          <div className="page-heading">
            <div>
              <h2 id={titleId} className="events-title">Events</h2>
            </div>
          </div>
          {upcomingEspn.status === "error" && (
            <div className="state-notice" role="status">
              <strong>ESPN unavailable</strong>
              <span>
                {upcomingEspn.message ??
                  "Upcoming ESPN events could not be loaded."}
              </span>
              <button
                type="button"
                className="retry-button"
                onClick={upcomingEspn.reload}
              >
                Retry
              </button>
            </div>
          )}
          {upcomingEspn.status === "loading" && (
            <SkeletonRows count={3} className="event-row-skeleton" />
          )}
          <EventList
            currentEvent={currentEventEntry}
            events={scheduleEventEntries}
            selectedId=""
            onSelect={(id) => navigateTo({ tab: "event", scheduleSelection: id })}
          />
        </section>
      );
    }
    const boutCount =
      virtualSelection === event.id
        ? event.bouts.length
        : espnCard.card
          ? espnCard.card.sections.reduce(
              (total, sec) => total + sec.fights.length,
              0,
            )
          : undefined;
    return (
      <section className="card-screen" aria-labelledby={titleId}>
        <div className="page-heading">
          <div>
            <span className="page-kicker">Bout order</span>
            <h2 id={titleId} className="event-title">
              {virtualSelection === event.id
                ? event.name
                : (espnCard.card?.name ?? "Event card")}
            </h2>
          </div>
          {boutCount !== undefined && (
            <span className="num page-count">{boutCount} bouts</span>
          )}
        </div>
        {virtualSelection === event.id ? (
          <CardRail
            bouts={event.bouts}
            selectedId={boutIdFor(entry) ?? ""}
            onSelect={selectBout}
            photosByBoutId={photosByBoutId}
          />
        ) : espnCard.status === "loading" || espnCard.status === "idle" ? (
          <SkeletonRows count={4} className="card-row-skeleton" />
        ) : espnCard.status === "error" ? (
          <div className="state-notice" role="status">
            <strong>Card unavailable</strong>
            <span>
              {espnCard.message ??
                "This event's fight card could not be loaded."}
            </span>
          </div>
        ) : espnCard.card ? (
          <ScheduledCardRail card={espnCard.card} onSelect={selectFutureFight} />
        ) : (
          <div className="empty-state">
            <strong>No fight card yet</strong>
            <span>ESPN hasn't published matchups for this event.</span>
          </div>
        )}
      </section>
    );
  };

  // The Fight tab's screen for a given nav entry — extracted for the same
  // reason as renderEventScreen above, and now necessary: back can land on a
  // fight (the one a bottom-nav Fight tap jumped away from), so the swipe-
  // back underlay has to be able to preview one, not just an event screen.
  const renderFightScreen = (entry: NavEntry, forUnderlay = false) => {
    // The underlay is inert (pointer-events: none) and about to be replaced
    // by the live screen, so its controls do nothing rather than reaching
    // into the live screen's state.
    const changeSection = forUnderlay ? () => {} : setSection;
    if (entry.selectedFutureFight) {
      return (
        <ScheduledFightPreview
          fight={entry.selectedFutureFight}
          upcoming={upcomingOdds}
        />
      );
    }
    const entryId = boutIdFor(entry);
    const entryView = entryId ? boutViews[entryId] : undefined;
    if (!entryView) {
      return (
        <div className="empty-state">
          <strong>No bouts on this card</strong>
          <span>Event data loaded without a selectable matchup.</span>
        </div>
      );
    }
    // Bout/Fighter never carries ESPN's career-average stats (the collector
    // pipeline that feeds it has no such field) — this fills that gap with
    // the same fightcenter fetch a browsed-to future event already uses,
    // matched back to this bout by its ESPN-rooted id.
    const matchedEspnFight = findEspnFight(currentEspnCard.card, entryView.bout.id);
    if (entryView.bout.status === "upcoming") {
      const canonicalFight = boutToScheduledFight(entryView.bout);
      return (
        <ScheduledFightPreview
          fight={
            matchedEspnFight
              ? { ...canonicalFight, red: matchedEspnFight.red, blue: matchedEspnFight.blue }
              : canonicalFight
          }
          upcoming={upcomingOdds}
          photosByCorner={photosByBoutId[entryView.bout.id]}
        />
      );
    }
    // `round` tracks the live screen and can name a round the previewed
    // bout never had, so the underlay uses that bout's own default — which
    // is also what the round-syncing effect above settles on once the
    // navigation actually lands.
    const entryRound = forUnderlay ? defaultRoundSelection(entryView) : round;
    return (
      <div className="fight-screen">
        <BoutHeader
          weightClassLabel={WEIGHT_LABEL[entryView.bout.weightClass] ?? ""}
          titleFight={entryView.bout.titleFight}
          scheduledRounds={entryView.bout.scheduledRounds}
          fighters={entryView.bout.fighters}
          status={entryView.bout.status}
          currentRound={entryView.bout.currentRound}
          result={entryView.bout.result}
          clockSync={dashboard.collector?.clocks[entryView.bout.id]}
          // Same headshots the bout list you tapped through was already
          // showing. Without this a live or finished bout dropped to the
          // no-photo placeholder even though the photos were loaded and on
          // screen a moment earlier — only the upcoming branch below ever
          // passed them through.
          photosByCorner={photosByBoutId[entryView.bout.id]}
        />
        {dashboard.stale && (
          <div className="state-notice" role="status">
            <strong>Stale snapshot</strong>
            <span>
              Showing the last valid completed-round data while sources reconnect.
            </span>
          </div>
        )}
        <MarketStrip
          latestOdds={withoutSportsbookOnEventDay(
            entryView.latestOdds,
            event.startsAt,
          )}
          preFightOdds={withoutSportsbookOnEventDay(
            entryView.preFightOdds,
            event.startsAt,
          )}
          {...(entryView.bout.status === "final"
            ? {}
            : { onOpen: () => changeSection("odds") })}
          resultWinner={
            entryView.bout.status === "final"
              ? entryView.bout.result?.winner
              : undefined
          }
        />
        <SectionTabs
          active={entry.section}
          onChange={changeSection}
          sections={
            entryView.bout.status === "final"
              ? ["summary", "stats", "tale"]
              : undefined
          }
        />
        <ScreenTransition
          screenKey={entry.section}
          direction={forUnderlay ? "none" : sectionDirection}
        >
          {entry.section === "summary" && (
            <>
              <RoundSelector
                view={entryView}
                value={entryRound}
                onChange={forUnderlay ? () => {} : setRound}
              />
              <FightSummary
                view={entryView}
                eventStartsAt={event.startsAt}
                selection={entryRound}
                collectorRounds={dashboard.collector?.unifiedRounds}
              />
              <ScorecardFeed
                view={entryView}
                records={dashboard.collector?.unifiedRounds ?? []}
                round={resolveRound(entryView, entryRound)}
                allRounds={entryRound === "total"}
              />
            </>
          )}
          {entry.section === "stats" && (
            <>
              <RoundSelector
                view={entryView}
                value={entryRound}
                onChange={forUnderlay ? () => {} : setRound}
              />
              <LiveStatsPanel view={entryView} selection={entryRound} />
            </>
          )}
          {entry.section === "odds" && entryView.bout.status !== "final" && (
            <UpcomingOddsSection
              fight={boutToScheduledFight(entryView.bout)}
              upcoming={upcomingOdds}
              liveView={entryView}
            />
          )}
          {entry.section === "tale" && (
            <UpcomingTaleSection
              fighters={entryView.bout.fighters}
              outlook={entryView.bout.outlook}
              {...(matchedEspnFight
                ? { statValues: taleStatValues(matchedEspnFight) }
                : {})}
            />
          )}
        </ScreenTransition>
      </div>
    );
  };

  // Any screen, from its nav entry alone — what makes the swipe-back
  // underlay able to preview whatever back leads to, rather than only the
  // event screens it used to hardcode.
  const renderScreen = (entry: NavEntry, forUnderlay = false) =>
    entry.tab === "fight"
      ? renderFightScreen(entry, forUnderlay)
      : entry.tab === "event"
        ? renderEventScreen(entry, forUnderlay)
        : (
            <SourceStatus
              state={state}
              stale={dashboard.stale}
              collector={dashboard.collector}
              forUnderlay={forUnderlay}
            />
          );

  return (
    <div className="app">
      <TopBar />
      <EventSubheader
        event={event}
        eventName={subheaderEventName}
        hideTitle={tab !== "fight"}
        leading={
          activeBackHandler ? <BackButton onClick={activeBackHandler} /> : undefined
        }
      />
      <div className="desktop-tabs">
        <BottomNav active={tab} onChange={handleNavTabChange} />
      </div>
      <div
        className={`app-body${tab === "fight" && !selectedFutureFight ? " has-rail" : ""}`}
      >
        {tab === "fight" && !selectedFutureFight && (
          <aside className="desktop-rail">
            <CardRail
              bouts={event.bouts}
              selectedId={selectedId ?? ""}
              onSelect={selectBout}
              photosByBoutId={photosByBoutId}
            />
          </aside>
        )}
        {backEntry && (
          <div className="app-content-underlay" ref={underlayRef} aria-hidden="true">
            {renderScreen(backEntry, true)}
          </div>
        )}
        <main className="app-content" id="main-content" ref={mainContentRef}>
          <ScreenTransition
            screenKey={screenKey}
            direction={screenDirection}
            skipRemount={skipScreenRemount}
          >
            {renderScreen(currentNav)}
          </ScreenTransition>
        </main>
      </div>
      <div className="mobile-nav">
        <BottomNav active={tab} onChange={handleNavTabChange} />
      </div>
    </div>
  );
}

