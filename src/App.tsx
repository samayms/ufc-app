import { useEffect, useState } from "react";
import { useDashboard } from "./store/useDashboard.ts";
import {
  getCollectorMarketDelivery,
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
import { FighterProfile } from "./ui/FighterProfile.tsx";
import { MarketStrip } from "./ui/MarketStrip.tsx";
import { OddsPanel } from "./ui/OddsPanel.tsx";
import { RecentForm } from "./ui/RecentForm.tsx";
import { RoundGrid } from "./ui/RoundGrid.tsx";
import {
  defaultRoundSelection,
  RoundSelector,
  type RoundSelection,
} from "./ui/RoundSelector.tsx";
import { RoundStatsPanel } from "./ui/RoundStatsPanel.tsx";
import { ScheduledCardRail } from "./ui/ScheduledCardRail.tsx";
import { ScheduledFightPreview } from "./ui/ScheduledFightPreview.tsx";
import { ScorecardFeed } from "./ui/ScorecardFeed.tsx";
import {
  SectionTabs,
  type FightSection,
} from "./ui/SectionTabs.tsx";
import { SourceStatus } from "./ui/SourceStatus.tsx";
import { EventSubheader, TopBar } from "./ui/TopBar.tsx";
import { useEspnCard, useUpcomingEspnEvents } from "./store/useEspnSchedule.ts";
import {
  fighterEspnAthleteId,
  useCurrentEventAthletePhotos,
  useUpcomingEventPhotos,
} from "./store/useEventPhotos.ts";
import type { EspnScheduledFight } from "./sources/espnSchedule.ts";
import "./ui/dashboard.css";

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
  // Whether the currently open Fight tab was reached by drilling into an
  // event from the Event tab (shows a back arrow) vs. opened directly from
  // the bottom nav (no "back" to go to).
  const [cameFromEvent, setCameFromEvent] = useState(false);
  const [selectedFutureFight, setSelectedFutureFight] =
    useState<EspnScheduledFight | null>(null);

  const upcomingEspn = useUpcomingEspnEvents();
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
  const marketDeliveries = view
    ? {
        kalshi: getCollectorMarketDelivery(
          dashboard.collector,
          view.bout.id,
          "kalshi",
        ),
        polymarket: getCollectorMarketDelivery(
          dashboard.collector,
          view.bout.id,
          "polymarket",
        ),
        sportsbook: getCollectorMarketDelivery(
          dashboard.collector,
          view.bout.id,
          "sportsbook",
        ),
      }
    : undefined;

  const selectBout = (id: string, opts?: { fromEvent?: boolean }) => {
    setSelected(id);
    setTab("fight");
    setSection("summary");
    setSelectedFutureFight(null);
    setCameFromEvent(opts?.fromEvent ?? false);
  };

  const selectFutureFight = (fight: EspnScheduledFight) => {
    setSelectedFutureFight(fight);
    setTab("fight");
    setCameFromEvent(true);
  };

  // Back arrow from the Fight tab: returns to the event's drilled fight
  // list (scheduleSelection is left as-is, so Event tab shows the same
  // drilled-in list rather than jumping back to the top-level events list).
  const backToEventFromFight = () => {
    setTab("event");
    setSelectedFutureFight(null);
    setCameFromEvent(false);
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
    setCameFromEvent(false);
    setSelectedFutureFight(null);
  };

  const mainBout = event.bouts.find((bout) => bout.cardPosition === 1);
  const mainBoutPhotoUrl = (corner: "red" | "blue") => {
    const fighter = mainBout?.fighters[corner];
    if (!fighter) return undefined;
    const athleteId = fighterEspnAthleteId(fighter.externalRefs);
    return athleteId ? currentEventAthletePhotos[athleteId] : undefined;
  };

  const currentEventEntry: EventListEntry = {
    id: event.id,
    name: event.name,
    startsAt: event.startsAt,
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

  const upcomingEventEntries: EventListEntry[] = (
    upcomingEspn.status === "ready" ? upcomingEspn.events : []
  ).map((upcomingEvent) => {
    const corners = upcomingEventPhotos[upcomingEvent.eventId];
    return {
      id: upcomingEvent.eventId,
      name: upcomingEvent.name,
      startsAt: upcomingEvent.startsAt,
      ...(corners?.red
        ? { redFighter: { name: corners.red.name, photoUrl: corners.red.headshotUrl } }
        : {}),
      ...(corners?.blue
        ? { blueFighter: { name: corners.blue.name, photoUrl: corners.blue.headshotUrl } }
        : {}),
    };
  });

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

  return (
    <div className="app">
      <TopBar />
      <EventSubheader
        event={event}
        leading={
          tab === "event" && scheduleSelection !== null ? (
            <BackButton onClick={backToEventList} />
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
        <main className="app-content" id="main-content">
          {tab === "fight" &&
            (selectedFutureFight ? (
              <ScheduledFightPreview
                fight={selectedFutureFight}
                onBack={backToEventFromFight}
              />
            ) : view ? (
              <div className="fight-screen">
                {cameFromEvent && (
                  <BackButton onClick={backToEventFromFight} label="Back to card" />
                )}
                <BoutHeader bout={view.bout} />
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
                <MarketStrip view={view} onOpen={() => setSection("odds")} />
                <SectionTabs active={section} onChange={setSection} />
                {(section === "summary" || section === "stats") && (
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
                      selection={round}
                      delivery={roundDelivery}
                    />
                    <ScorecardFeed
                      view={view}
                      accounts={state.scorecardAccounts}
                      records={
                        dashboard.collector?.unifiedRounds ?? []
                      }
                      round={selectedRound}
                      collector={dashboard.collector}
                    />
                  </>
                )}
                {section === "stats" && (
                  <>
                    <RoundStatsPanel
                      view={view}
                      selection={round}
                      delivery={roundDelivery}
                    />
                    <RoundGrid view={view} />
                  </>
                )}
                {section === "odds" && (
                  <OddsPanel view={view} deliveries={marketDeliveries} />
                )}
                {section === "tale" && (
                  <>
                    <FighterProfile bout={view.bout} />
                    <RecentForm bout={view.bout} />
                  </>
                )}
              </div>
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
                    <span className="page-kicker">Browse</span>
                    <h2 id="card-title">Events</h2>
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
                    <h2 id="card-title">
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
                    onSelect={(id) => selectBout(id, { fromEvent: true })}
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
