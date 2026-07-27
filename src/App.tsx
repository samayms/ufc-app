import { useState } from "react";
import { useDashboard } from "./store/useDashboard.ts";
import { BoutHeader } from "./ui/BoutHeader.tsx";
import { CardRail } from "./ui/CardRail.tsx";
import { OddsPanel } from "./ui/OddsPanel.tsx";
import { RecentForm } from "./ui/RecentForm.tsx";
import { RoundGrid } from "./ui/RoundGrid.tsx";
import { RoundStatsPanel } from "./ui/RoundStatsPanel.tsx";
import { ScorecardFeed } from "./ui/ScorecardFeed.tsx";
import { TopBar } from "./ui/TopBar.tsx";
import "./ui/dashboard.css";

export default function App() {
  const state = useDashboard();
  const [selected, setSelected] = useState<string | null>(null);

  if (!state) {
    return (
      <div className="loading" role="status">
        Loading fight data…
      </div>
    );
  }

  const { event, boutViews } = state;
  const live = event.bouts.find(
    (b) => b.status === "in-round" || b.status === "between-rounds",
  );
  const selectedId = selected ?? live?.id ?? event.bouts[0]?.id;
  const view = selectedId ? boutViews[selectedId] : undefined;

  return (
    <div className="app">
      <TopBar event={event} />
      <CardRail
        bouts={event.bouts}
        selectedId={selectedId ?? ""}
        onSelect={setSelected}
      />
      {view ? (
        <>
          <main className="center">
            <BoutHeader bout={view.bout} />
            <RoundGrid view={view} />
            <RoundStatsPanel view={view} />
            <RecentForm bout={view.bout} />
          </main>
          <aside className="side">
            <OddsPanel view={view} />
            <ScorecardFeed view={view} accounts={state.scorecardAccounts} />
          </aside>
        </>
      ) : (
        <main className="center">
          <p className="empty">No bouts on this card.</p>
        </main>
      )}
    </div>
  );
}
