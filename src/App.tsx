import { useEffect, useState } from "react";
import { useDashboard } from "./store/useDashboard.ts";
import { BottomNav, type AppTab } from "./ui/BottomNav.tsx";
import { BoutHeader } from "./ui/BoutHeader.tsx";
import { CardRail } from "./ui/CardRail.tsx";
import { FightSummary } from "./ui/FightSummary.tsx";
import { FighterProfile } from "./ui/FighterProfile.tsx";
import { MarketStrip } from "./ui/MarketStrip.tsx";
import { OddsPanel } from "./ui/OddsPanel.tsx";
import { RecentForm } from "./ui/RecentForm.tsx";
import { RoundGrid } from "./ui/RoundGrid.tsx";
import {
  RoundSelector,
  type RoundSelection,
} from "./ui/RoundSelector.tsx";
import { RoundStatsPanel } from "./ui/RoundStatsPanel.tsx";
import { ScorecardFeed } from "./ui/ScorecardFeed.tsx";
import {
  SectionTabs,
  type FightSection,
} from "./ui/SectionTabs.tsx";
import { SourceStatus } from "./ui/SourceStatus.tsx";
import { TopBar } from "./ui/TopBar.tsx";
import "./ui/dashboard.css";

function latestRound(view: NonNullable<ReturnType<typeof useDashboard>>["boutViews"][string]) {
  const completed = Object.values(view.rounds)
    .flat()
    .map((round) => round.round);
  return completed.length ? Math.max(...completed) : 1;
}

export default function App() {
  const state = useDashboard();
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<AppTab>("fight");
  const [section, setSection] = useState<FightSection>("summary");
  const [round, setRound] = useState<RoundSelection>(1);

  useEffect(() => {
    if (!state) return;
    const active = state.event.bouts.find(
      (bout) =>
        bout.status === "in-round" || bout.status === "between-rounds",
    );
    const id = selected ?? active?.id ?? state.event.bouts[0]?.id;
    const nextView = id ? state.boutViews[id] : undefined;
    if (nextView) setRound(latestRound(nextView));
  }, [selected, state]);

  if (!state) {
    return (
      <div className="app-state loading" role="status" aria-live="polite">
        <span className="loading-mark" aria-hidden="true" />
        <strong>Loading fight data</strong>
        <span>Assembling the latest valid source snapshots…</span>
      </div>
    );
  }

  const { event, boutViews } = state;
  const live = event.bouts.find(
    (b) => b.status === "in-round" || b.status === "between-rounds",
  );
  const selectedId = selected ?? live?.id ?? event.bouts[0]?.id;
  const view = selectedId ? boutViews[selectedId] : undefined;

  const selectBout = (id: string) => {
    setSelected(id);
    setTab("fight");
    setSection("summary");
  };

  return (
    <div className="app">
      <TopBar event={event} />
      <div className="desktop-tabs">
        <BottomNav active={tab} onChange={setTab} />
      </div>
      <div className="app-body">
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
                    <FightSummary view={view} selection={round} />
                    <ScorecardFeed
                      view={view}
                      accounts={state.scorecardAccounts}
                    />
                  </>
                )}
                {section === "stats" && (
                  <>
                    <RoundStatsPanel view={view} />
                    <RoundGrid view={view} />
                  </>
                )}
                {section === "odds" && <OddsPanel view={view} />}
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
                <span className="num page-count">{event.bouts.length} bouts</span>
              </div>
              <CardRail
                bouts={event.bouts}
                selectedId={selectedId ?? ""}
                onSelect={selectBout}
              />
            </section>
          )}
          {tab === "sources" && <SourceStatus state={state} />}
        </main>
      </div>
      <div className="mobile-nav">
        <BottomNav active={tab} onChange={setTab} />
      </div>
    </div>
  );
}
