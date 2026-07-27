import type { DashboardState, SourceId } from "../schema/types.ts";
import { fmtTime } from "./format.ts";

const SOURCES: {
  id: SourceId;
  name: string;
  detail: string;
}[] = [
  { id: "espn", name: "ESPN FightCenter", detail: "fight state and round snapshots" },
  { id: "sherdog", name: "Sherdog live blog", detail: "round narrative and scores" },
  { id: "cito", name: "Cito", detail: "completed-round statistics" },
  { id: "kalshi", name: "Kalshi", detail: "prediction market contracts" },
  { id: "polymarket", name: "Polymarket", detail: "prediction market prices" },
  { id: "odds-api", name: "The Odds API", detail: "sportsbook moneylines" },
  { id: "x-embed", name: "Media embeds", detail: "optional scorecard posts" },
];

function sourceTimes(state: DashboardState, source: SourceId) {
  const times: string[] = [];
  for (const view of Object.values(state.boutViews)) {
    for (const round of view.rounds[source] ?? []) {
      times.push(round.provenance.fetchedAt);
    }
    for (const odds of Object.values(view.latestOdds)) {
      if (odds.provenance.source === source) times.push(odds.provenance.fetchedAt);
    }
  }
  return times.sort().at(-1);
}

export function SourceStatus({
  state,
  stale = false,
}: {
  state: DashboardState;
  stale?: boolean;
}) {
  return (
    <section className="source-panel" aria-labelledby="source-title">
      <div className="page-heading">
        <div>
          <span className="page-kicker">Data health</span>
          <h2 id="source-title">Sources</h2>
        </div>
        <span className="badge badge-synthetic">Fixture mode</span>
      </div>
      <p className="source-intro">
        Every adapter is isolated behind the normalized store. Missing data in one
        source does not clear the last valid completed-round snapshot.
      </p>
      <div className="source-list">
        {SOURCES.map((source) => {
          const fetchedAt = sourceTimes(state, source.id);
          const unavailable = fetchedAt == null;
          const status = unavailable
            ? "Unavailable"
            : stale
              ? "Stale"
              : "Fixture";
          return (
            <div className="source-row" key={source.id}>
              <div>
                <strong>{source.name}</strong>
                <span>{source.detail}</span>
                <span className="source-time num">
                  {fetchedAt ? `as of ${fmtTime(fetchedAt)}` : "no snapshot for selected card"}
                </span>
              </div>
              <span
                className={`source-state source-state-${status.toLowerCase()}`}
              >
                {status}
              </span>
            </div>
          );
        })}
      </div>
      <p className="privacy-note">
        Personal, non-commercial use only. No source data is shared or published.
      </p>
    </section>
  );
}
