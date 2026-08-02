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
import { ScreenTransition } from "./ui/ScreenTransition.tsx";
import {
  defaultRoundSelection,
  RoundSelector,
  type RoundSelection,
} from "./ui/RoundSelector.tsx";
import { ScheduledCardRail } from "./ui/ScheduledCardRail.tsx";
import {
  boutToScheduledFight,
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

// Orders every screen along a single forward/backward axis so the slide
// transition's direction is always correct, including for back navigation
// (swipe or button) landing on a screen that a naive two-bucket depth would
// tie with its own destination. The three bottom-nav tabs are ordered
// event < fight < data to match their left-to-right position in the nav bar,
// with generous spacing between tiers so a tab can still hold its own
// internal drill levels (e.g. the Event tab's list vs. drilled-in screen)
// without colliding with the next tab's tier.
// Matches SectionTabs.tsx's own default tab order (Fight, Stats, Odds,
// Tale) so the section content slides in the same left-to-right direction
// the tab strip itself implies, regardless of which subset of tabs a given
// bout status actually renders (e.g. a final bout drops the Odds tab).
const SECTION_ORDER: FightSection[] = ["summary", "stats", "odds", "tale"];

function sectionDepth(key: string): number {
  return SECTION_ORDER.indexOf(key as FightSection);
}

function screenDepth(key: string): number {
  if (key === "event:list") return 0;
  if (key.startsWith("event:drilled:")) return 1;
  if (key.startsWith("fight:")) return 100;
  if (key === "data") return 200;
  return 0;
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

  // Reset scroll position whenever the visible screen changes — otherwise
  // .app-content keeps its previous scroll offset and a freshly drilled-into
  // screen (e.g. an event's bout order) can load already scrolled past its
  // own heading.
  useEffect(() => {
    mainContentRef.current?.scrollTo({ top: 0 });
  }, [tab, scheduleSelection, selected, selectedFutureFight]);

  // Back arrow from the Fight tab: returns to the fight's own event's
  // drilled bout-order screen. When the fight was reached by drilling in
  // from the Event tab, scheduleSelection already names that event, so it's
  // left as-is. When the Fight tab was opened directly (e.g. from the
  // bottom nav), scheduleSelection may still be null or point elsewhere, so
  // it's set to the current live event — the only event a directly-opened
  // fight can belong to. Defined here (above the loading/error early
  // returns) and reading `state?.event.id` rather than the later-destructured
  // `event` so the hooks below it — and useSwipeBack itself — run
  // unconditionally on every render, as React's Rules of Hooks require. It's
  // only ever invoked once `state` is loaded (both the back button and the
  // swipe gesture are gated on `activeBackHandler`, which is `undefined`
  // while `state` is null), so `state` is guaranteed non-null at call time.
  const backToEventFromFight = () => {
    setTab("event");
    setScheduleSelection((prev) => prev ?? state?.event.id ?? prev);
    setSelectedFutureFight(null);
    // Otherwise the bout row you just came from is still shown selected
    // when you land back on the event's bout list.
    setSelected(null);
  };

  // Back arrow within the Event tab's drilled fight-list screen: returns to
  // the top-level events list.
  const backToEventList = () => {
    setScheduleSelection(null);
  };

  const activeBackHandler = !state
    ? undefined
    : tab === "fight"
      ? backToEventFromFight
      : tab === "event" && scheduleSelection !== null
        ? backToEventList
        : undefined;

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

  // Screen key/direction for ScreenTransition's slide animation. Computed
  // here (above the loading/error early returns, like activeBackHandler
  // above) so the hooks it feeds — useRef and useEffect below — run
  // unconditionally on every render. Null-tolerant on selectedFutureFight
  // and selected so it's safe to compute before `state` has loaded.
  const screenKey =
    tab === "event"
      ? scheduleSelection === null
        ? "event:list"
        : `event:drilled:${scheduleSelection}`
      : tab === "fight"
        ? `fight:${selectedFutureFight?.competitionId ?? selected ?? "current"}`
        : "data";

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
  const selectedId = selected ?? live?.id ?? event.bouts[0]?.id;
  const view = selectedId ? boutViews[selectedId] : undefined;
  const selectedRound =
    view === undefined
      ? undefined
      : round === "total"
        ? Math.max(
            0,
            ...(dashboard.collector?.unifiedRounds
              .filter((record) => record.boutId === view.bout.id)
              .map((record) => record.round) ?? []),
          )
        : round;
  const selectBout = (id: string) => {
    setSelected(id);
    setTab("fight");
    setSection("summary");
    setSelectedFutureFight(null);
  };

  const selectFutureFight = (fight: EspnScheduledFight) => {
    setSelectedFutureFight(fight);
    setTab("fight");
  };

  // Just switches tabs — the Fight tab keeps showing whichever bout (live
  // or a specific selectedFutureFight) was already selected, same as the
  // Event tab keeps its own drill state, regardless of how many times you
  // tap away and back. Previously also cleared selectedFutureFight
  // unconditionally, which fired even when re-tapping the tab you were
  // already on and evicted you from the exact future fight you'd drilled
  // into, back to the live event's default bout.
  const handleNavTabChange = (next: AppTab) => {
    setTab(next);
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

  // The Event tab's screen for a given drill state — extracted so the swipe-
  // back underlay below can render "what going back would show" from the
  // same code as the live screen, kept in sync rather than a second,
  // drifting copy. Only ever called with `null` (top list) or `event.id`
  // (the current event's own CardRail) for the underlay, since swipe-back
  // never targets an arbitrary ESPN future-event id — but it stays correct
  // for any `virtualSelection` since it's also what drives the live render.
  const renderEventScreen = (
    virtualSelection: string | null,
    // Drops the id/aria-labelledby pairing for the swipe-back underlay's
    // copy — otherwise, while it's mounted alongside the live main content
    // (both call this same function), the page ends up with two elements
    // sharing id="card-title", which is invalid HTML even though the
    // underlay's own aria-hidden="true" wrapper already keeps it out of the
    // accessibility tree.
    forUnderlay = false,
  ) => {
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
            onSelect={setScheduleSelection}
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
            selectedId={selectedId ?? ""}
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

  // Which virtual event-tab selection the swipe-back underlay should show,
  // if any — undefined means there's no swipe-revealable underlay for the
  // current screen (e.g. the Data tab).
  //
  // backToEventFromFight's own logic (above) keeps scheduleSelection as-is
  // when it's already set — a fight opened from a drilled-in *upcoming*
  // event leaves scheduleSelection pointing at that event, not the live
  // one — and only falls back to the live event when scheduleSelection was
  // null. Hardcoding event.id here (instead of mirroring that same
  // fallback) always showed the live event's own card in the underlay
  // regardless of which event the fight actually belonged to.
  const swipeUnderlaySelection: string | null | undefined =
    activeBackHandler === backToEventFromFight
      ? (scheduleSelection ?? event.id)
      : activeBackHandler === backToEventList
        ? null
        : undefined;

  return (
    <div className="app">
      <TopBar />
      <EventSubheader
        event={event}
        eventName={subheaderEventName}
        hideTitle={tab !== "fight"}
        leading={
          tab === "event" && scheduleSelection !== null ? (
            <BackButton onClick={backToEventList} />
          ) : tab === "fight" ? (
            <BackButton onClick={backToEventFromFight} />
          ) : undefined
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
        {swipeUnderlaySelection !== undefined && (
          <div className="app-content-underlay" ref={underlayRef} aria-hidden="true">
            {renderEventScreen(swipeUnderlaySelection, true)}
          </div>
        )}
        <main className="app-content" id="main-content" ref={mainContentRef}>
          <ScreenTransition
            screenKey={screenKey}
            direction={screenDirection}
            skipRemount={skipScreenRemount}
          >
          {tab === "fight" &&
            (selectedFutureFight ? (
              <ScheduledFightPreview
                fight={selectedFutureFight}
                upcoming={upcomingOdds}
              />
            ) : view ? (
              view.bout.status === "upcoming" ? (
                <ScheduledFightPreview
                  fight={boutToScheduledFight(view.bout)}
                  upcoming={upcomingOdds}
                  photosByCorner={photosByBoutId[view.bout.id]}
                />
              ) : (
                <div className="fight-screen">
                <BoutHeader
                  weightClassLabel={WEIGHT_LABEL[view.bout.weightClass] ?? ""}
                  titleFight={view.bout.titleFight}
                  scheduledRounds={view.bout.scheduledRounds}
                  fighters={view.bout.fighters}
                  status={view.bout.status}
                  currentRound={view.bout.currentRound}
                  result={view.bout.result}
                  clockSync={dashboard.collector?.clocks[view.bout.id]}
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
                      view.latestOdds,
                      state?.event.startsAt ?? "",
                    )}
                    preFightOdds={withoutSportsbookOnEventDay(
                      view.preFightOdds,
                      state?.event.startsAt ?? "",
                    )}
                    onOpen={() => setSection("odds")}
                    resultWinner={view.bout.status === "final" ? view.bout.result?.winner : undefined}
                />
                <SectionTabs
                  active={section}
                  onChange={setSection}
                  sections={
                    view.bout.status === "final"
                      ? ["summary", "stats", "tale"]
                      : undefined
                  }
                />
                <ScreenTransition screenKey={section} direction={sectionDirection}>
                  {section === "summary" && (
                    <RoundSelector
                      view={view}
                      value={round}
                      onChange={setRound}
                    />
                  )}
                  {section === "summary" && (
                    <>
                      <FightSummary
                        view={view}
                        eventStartsAt={state?.event.startsAt ?? ""}
                        selection={round}
                        collectorRounds={dashboard.collector?.unifiedRounds}
                      />
                      <ScorecardFeed
                        view={view}
                        records={
                          dashboard.collector?.unifiedRounds ?? []
                        }
                        round={selectedRound}
                      />
                    </>
                  )}
                  {section === "stats" && (
                    <>
                      <RoundSelector
                        view={view}
                        value={round}
                        onChange={setRound}
                      />
                      <LiveStatsPanel view={view} selection={round} />
                    </>
                  )}
                  {section === "odds" && view.bout.status !== "final" && (
                    <UpcomingOddsSection
                      fight={boutToScheduledFight(view.bout)}
                      upcoming={upcomingOdds}
                      liveView={view}
                    />
                  )}
                  {section === "tale" && (
                    <UpcomingTaleSection fighters={view.bout.fighters} />
                  )}
                </ScreenTransition>
                </div>
              )
            ) : (
              <div className="empty-state">
                <strong>No bouts on this card</strong>
                <span>Event data loaded without a selectable matchup.</span>
              </div>
            ))}
          {tab === "event" && renderEventScreen(scheduleSelection)}
          {tab === "data" && (
            <SourceStatus
              state={state}
              stale={dashboard.stale}
              collector={dashboard.collector}
            />
          )}
          </ScreenTransition>
        </main>
      </div>
      <div className="mobile-nav">
        <BottomNav active={tab} onChange={handleNavTabChange} />
      </div>
    </div>
  );
}
