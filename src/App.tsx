import { useEffect, useRef, useState } from "react";
import { useDashboard } from "./store/useDashboard.ts";
import {
  getCollectorRoundDelivery,
  type CollectorValueDelivery,
} from "./store/collectorClient.ts";
import { BackButton } from "./ui/BackButton.tsx";
import { BottomNav, type AppTab } from "./ui/BottomNav.tsx";
import { BoutHeader } from "./ui/BoutHeader.tsx";
import { CardRail } from "./ui/CardRail.tsx";
import { DeliveryFreshness } from "./ui/DeliveryFreshness.tsx";
import { EventList, type EventListEntry } from "./ui/EventList.tsx";
import { FightSummary } from "./ui/FightSummary.tsx";
import { withoutSportsbookOnEventDay } from "./lib/marketPriority.ts";
import { MarketStrip } from "./ui/MarketStrip.tsx";
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
import {
  SectionTabs,
  type FightSection,
} from "./ui/SectionTabs.tsx";
import { SourceStatus } from "./ui/SourceStatus.tsx";
import { EventSubheader, TopBar } from "./ui/TopBar.tsx";
import { WEIGHT_LABEL } from "./ui/format.ts";
import { hasEventStarted, sameEvent } from "./lib/eventIdentity.ts";
import { useEspnCard, useUpcomingEspnEvents } from "./store/useEspnSchedule.ts";
import { useUpcomingOdds } from "./store/useUpcomingOdds.ts";
import {
  fighterEspnAthleteId,
  useCurrentEventAthletePhotos,
  useUpcomingEventPhotos,
} from "./store/useEventPhotos.ts";
import type { BoutView, OddsSnapshot } from "./schema.ts";
import type { EspnScheduledFight } from "./sources/espnSchedule.ts";
import "./ui/dashboard.css";

export function LiveOddsSection({
  view,
  upcomingOdds,
  deliveries,
}: {
  view: BoutView;
  upcomingOdds: ReturnType<typeof useUpcomingOdds>;
  deliveries?: Partial<Record<OddsSnapshot["market"], CollectorValueDelivery>>;
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

  if (dashboard.status === "loading") {
    return (
      <div className="app-state loading" role="status" aria-live="polite">
        <span className="loading-mark" aria-hidden="true" />
        <strong>Loading fight data</strong>
        <span>Assembling the latest valid source snapshots…</span>
      </div>
    );
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
  const roundDelivery =
    view === undefined || selectedRound === undefined || selectedRound < 1
      ? undefined
      : getCollectorRoundDelivery(
          dashboard.collector,
          view.bout.id,
          selectedRound,
        );
  const lifecycle = view
    ? dashboard.collector?.lifecycle[view.bout.id]
    : undefined;
  const lifecycleDelivery: CollectorValueDelivery | undefined =
    lifecycle === undefined
      ? undefined
      : {
          source: lifecycle.source,
          sourceUpdatedAt: lifecycle.sourceUpdatedAt,
          receivedAt: lifecycle.receivedAt,
          stale: dashboard.collector?.connection !== "connected",
          provisional: lifecycle.provisional,
        };
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

  // Back arrow from the Fight tab: returns to the fight's own event's
  // drilled bout-order screen. When the fight was reached by drilling in
  // from the Event tab, scheduleSelection already names that event, so it's
  // left as-is. When the Fight tab was opened directly (e.g. from the
  // bottom nav), scheduleSelection may still be null or point elsewhere, so
  // it's set to the current live event — the only event a directly-opened
  // fight can belong to.
  const backToEventFromFight = () => {
    setTab("event");
    setScheduleSelection((prev) => prev ?? event.id);
    setSelectedFutureFight(null);
  };

  // Back arrow within the Event tab's drilled fight-list screen: returns to
  // the top-level events list.
  const backToEventList = () => {
    setScheduleSelection(null);
  };

  // Bottom nav is the only "start fresh" entry point — clears any
  // drill-down/back-arrow state left over from the Event tab.
  const handleNavTabChange = (next: AppTab) => {
    setTab(next);
    setSelectedFutureFight(null);
  };

  const mainBout = event.bouts.find((bout) => bout.cardPosition === 1);
  const mainBoutPhotoUrl = (corner: "red" | "blue") => {
    const fighter = mainBout?.fighters[corner];
    if (!fighter) return undefined;
    const athleteId = fighterEspnAthleteId(fighter.externalRefs);
    return athleteId ? currentEventAthletePhotos[athleteId] : undefined;
  };
  const eventStarted = hasEventStarted(event.startsAt);

  const dashboardEventEntry: EventListEntry = {
    id: event.id,
    name: event.name,
    startsAt: event.startsAt,
    isLive: eventStarted &&
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
  const currentEventEntry = eventStarted ? dashboardEventEntry : null;

  const upcomingEventEntries: EventListEntry[] = (
    upcomingEspn.status === "ready" ? upcomingEspn.events : []
  )
    .filter(
      (upcomingEvent) =>
        !eventStarted ||
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
        isLive: hasEventStarted(upcomingEvent.startsAt),
        ...(corners?.red
          ? { redFighter: { name: corners.red.name, photoUrl: corners.red.headshotUrl } }
          : {}),
        ...(corners?.blue
          ? { blueFighter: { name: corners.blue.name, photoUrl: corners.blue.headshotUrl } }
          : {}),
      };
    });
  if (
    !eventStarted &&
    !upcomingEventEntries.some((entry) => sameEvent(entry, dashboardEventEntry))
  ) {
    upcomingEventEntries.unshift(dashboardEventEntry);
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

  // Reflects whichever card the drilled-in Event tab screen is currently
  // showing. Undefined on the top-level list screen (no single event's bout
  // count applies) or while a future ESPN card is still loading or failed.
  const cardBoutCount =
    scheduleSelection === null
      ? undefined
      : scheduleSelection === event.id
        ? event.bouts.length
        : espnCard.card
          ? espnCard.card.sections.reduce(
              (total, sec) => total + sec.fights.length,
              0,
            )
          : undefined;

  const selectedScheduleEventName =
    scheduleSelection === null
      ? undefined
      : scheduleSelection === event.id
        ? event.name
        : espnCard.card?.name ??
          upcomingEventEntries.find((entry) => entry.id === scheduleSelection)
            ?.name;

  const subheaderEventName =
    tab === "fight"
      ? selectedFutureFight
        ? (selectedScheduleEventName ?? event.name)
        : event.name
      : event.name;

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
        <main className="app-content" id="main-content" ref={mainContentRef}>
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
                {lifecycleDelivery && (
                  <div className="delivery-notice" role="status">
                    <DeliveryFreshness delivery={lifecycleDelivery} />
                  </div>
                )}
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
                />
                <SectionTabs active={section} onChange={setSection} />
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
                      delivery={roundDelivery}
                      collectorRounds={dashboard.collector?.unifiedRounds}
                    />
                    <ScorecardFeed
                      view={view}
                      records={
                        dashboard.collector?.unifiedRounds ?? []
                      }
                      round={selectedRound}
                      collector={dashboard.collector}
                    />
                  </>
                )}
                {section === "odds" && (
                  <UpcomingOddsSection
                    fight={boutToScheduledFight(view.bout)}
                    upcoming={upcomingOdds}
                    liveView={view}
                  />
                )}
                {section === "tale" && (
                  <UpcomingTaleSection fighters={view.bout.fighters} />
                )}
                </div>
              )
            ) : (
              <div className="empty-state">
                <strong>No bouts on this card</strong>
                <span>Event data loaded without a selectable matchup.</span>
              </div>
            ))}
          {tab === "event" &&
            (scheduleSelection === null ? (
              <section className="card-screen" aria-labelledby="card-title">
                <div className="page-heading">
                  <div>
                    <h2 id="card-title" className="events-title">Events</h2>
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
                <EventList
                  currentEvent={currentEventEntry}
                  events={upcomingEventEntries}
                  selectedId=""
                  onSelect={setScheduleSelection}
                />
              </section>
            ) : (
              <section className="card-screen" aria-labelledby="card-title">
                <div className="page-heading">
                  <div>
                    <span className="page-kicker">Bout order</span>
                    <h2 id="card-title" className="event-title">
                      {scheduleSelection === event.id
                        ? event.name
                        : (espnCard.card?.name ?? "Event card")}
                    </h2>
                  </div>
                  {cardBoutCount !== undefined && (
                    <span className="num page-count">{cardBoutCount} bouts</span>
                  )}
                </div>
                {scheduleSelection === event.id ? (
                  <CardRail
                    bouts={event.bouts}
                    selectedId={selectedId ?? ""}
                    onSelect={selectBout}
                    photosByBoutId={photosByBoutId}
                  />
                ) : espnCard.status === "loading" || espnCard.status === "idle" ? (
                  <div className="empty-state">
                    <strong>Loading card…</strong>
                    <span>Fetching the ESPN fight card.</span>
                  </div>
                ) : espnCard.status === "error" ? (
                  <div className="state-notice" role="status">
                    <strong>Card unavailable</strong>
                    <span>
                      {espnCard.message ??
                        "This event's fight card could not be loaded."}
                    </span>
                  </div>
                ) : espnCard.card ? (
                  <ScheduledCardRail
                    card={espnCard.card}
                    onSelect={selectFutureFight}
                  />
                ) : (
                  <div className="empty-state">
                    <strong>No fight card yet</strong>
                    <span>ESPN hasn't published matchups for this event.</span>
                  </div>
                )}
              </section>
            ))}
          {tab === "data" && (
            <SourceStatus
              state={state}
              stale={dashboard.stale}
              collector={dashboard.collector}
            />
          )}
        </main>
      </div>
      <div className="mobile-nav">
        <BottomNav active={tab} onChange={handleNavTabChange} />
      </div>
    </div>
  );
}
