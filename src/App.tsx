import { useEffect, useState } from "react";
import { useDashboard } from "./store/useDashboard.ts";
import {
  getCollectorMarketDelivery,
  getCollectorRoundDelivery,
  type CollectorValueDelivery,
} from "./store/collectorClient.ts";
import { BottomNav, type AppTab } from "./ui/BottomNav.tsx";
import { BoutHeader } from "./ui/BoutHeader.tsx";
import { CardRail } from "./ui/CardRail.tsx";
import { DeliveryFreshness } from "./ui/DeliveryFreshness.tsx";
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
import { ScorecardFeed } from "./ui/ScorecardFeed.tsx";
import {
  SectionTabs,
  type FightSection,
} from "./ui/SectionTabs.tsx";
import { SourceStatus } from "./ui/SourceStatus.tsx";
import { EventSubheader, TopBar } from "./ui/TopBar.tsx";
import { UpcomingEventRail } from "./ui/UpcomingEventRail.tsx";
import { useEspnCard, useUpcomingEspnEvents } from "./store/useEspnSchedule.ts";
import "./ui/dashboard.css";

export default function App() {
  const dashboard = useDashboard();
  const state = dashboard.data;
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<AppTab>("fight");
  const [section, setSection] = useState<FightSection>("summary");
  const [round, setRound] = useState<RoundSelection>(1);
  // null = the app's current in-memory event (default); otherwise an ESPN event id.
  const [scheduleSelection, setScheduleSelection] = useState<string | null>(
    null,
  );
  const upcomingEspn = useUpcomingEspnEvents();
  const espnCard = useEspnCard(scheduleSelection);

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

  const selectBout = (id: string) => {
    setSelected(id);
    setTab("fight");
    setSection("summary");
  };

  // Reflects whichever card the Card tab is currently showing. Undefined while a
  // future ESPN card is still loading or failed, so the header omits the count
  // rather than reporting the previous card's.
  const cardBoutCount =
    scheduleSelection === null
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
      <EventSubheader event={event} />
      <div className="desktop-tabs">
        <BottomNav active={tab} onChange={setTab} />
      </div>
      <div className={`app-body${tab === "fight" ? " has-rail" : ""}`}>
        {tab === "fight" && (
          <aside className="desktop-rail">
            <CardRail
              bouts={event.bouts}
              selectedId={selectedId ?? ""}
              onSelect={selectBout}
            />
          </aside>
        )}
        <main className="app-content" id="main-content">
          {tab === "fight" &&
            (view ? (
              <div className="fight-screen">
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
          {tab === "card" && (
            <section className="card-screen" aria-labelledby="card-title">
              <div className="page-heading">
                <div>
                  <span className="page-kicker">Bout order</span>
                  <h2 id="card-title">Event card</h2>
                </div>
                {cardBoutCount !== undefined && (
                  <span className="num page-count">{cardBoutCount} bouts</span>
                )}
              </div>
              <UpcomingEventRail
                currentEvent={{
                  id: event.id,
                  name: event.name,
                  startsAt: event.startsAt,
                }}
                events={
                  upcomingEspn.status === "ready" ? upcomingEspn.events : []
                }
                selectedId={scheduleSelection ?? event.id}
                onSelect={(id) =>
                  setScheduleSelection(id === event.id ? null : id)
                }
              />
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
              {scheduleSelection === null ? (
                <CardRail
                  bouts={event.bouts}
                  selectedId={selectedId ?? ""}
                  onSelect={selectBout}
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
                <ScheduledCardRail card={espnCard.card} />
              ) : (
                <div className="empty-state">
                  <strong>No fight card yet</strong>
                  <span>ESPN hasn't published matchups for this event.</span>
                </div>
              )}
            </section>
          )}
          {tab === "sources" && (
            <SourceStatus
              state={state}
              stale={dashboard.stale}
              collector={dashboard.collector}
            />
          )}
        </main>
      </div>
      <div className="mobile-nav">
        <BottomNav active={tab} onChange={setTab} />
      </div>
    </div>
  );
}
