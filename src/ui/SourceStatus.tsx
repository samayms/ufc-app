import type { DashboardState, SourceId } from "../schema.ts";
import type { CollectorSnapshot } from "../store/collectorClient.ts";
import { fmtTime } from "./format.ts";

const SOURCES: {
  id: SourceId;
  name: string;
  detail: string;
  cadence: string;
}[] = [
  {
    id: "espn",
    name: "ESPN FightCenter",
    detail: "Fight state and round snapshots",
    cadence: "On dashboard refresh",
  },
  {
    id: "sherdog",
    name: "Sherdog live blog",
    detail: "Round narrative and scores",
    cadence: "On dashboard refresh",
  },
  {
    id: "kalshi",
    name: "Kalshi",
    detail: "Prediction market contracts",
    cadence: "On dashboard refresh",
  },
  {
    id: "polymarket",
    name: "Polymarket",
    detail: "Prediction market prices",
    cadence: "On dashboard refresh",
  },
  {
    id: "odds-api",
    name: "The Odds API",
    detail: "Sportsbook moneylines",
    cadence: "On dashboard refresh",
  },
];

function sourceTimes(state: DashboardState, source: SourceId) {
  const times: string[] = [];
  if (state.event.provenance.source === source) {
    times.push(state.event.provenance.fetchedAt);
  }
  for (const view of Object.values(state.boutViews)) {
    if (view.bout.provenance.source === source) {
      times.push(view.bout.provenance.fetchedAt);
    }
    for (const fighter of Object.values(view.bout.fighters)) {
      if (fighter.provenance.source === source) {
        times.push(fighter.provenance.fetchedAt);
      }
    }
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
  collector,
}: {
  state: DashboardState;
  stale?: boolean;
  collector?: CollectorSnapshot;
}) {
  const sourceUpdates = SOURCES.map((source) => sourceTimes(state, source.id));
  const lastSyncedAt = [
    state.event.provenance.fetchedAt,
    ...sourceUpdates.filter((time): time is string => time != null),
  ]
    .sort()
    .at(-1);
  const fixtureMode = state.event.provenance.synthetic;
  const connectionLabel =
    collector?.connection === "unavailable"
      ? "Collector unavailable"
      : collector?.connection === "reconnecting"
        ? "Reconnecting"
        : stale
          ? "Stale"
          : "Synced";
  const connectionStale =
    stale ||
    (collector !== undefined && collector.connection !== "connected");
  const syncedAt = collector?.lastReceivedAt ?? lastSyncedAt;

  return (
    <section className="source-panel" aria-labelledby="source-title">
      <div className="page-heading">
        <div>
          <span className="page-kicker">Connection health</span>
          <h2 id="source-title">Data feeds</h2>
        </div>
      </div>
      <div className="data-overview" aria-label="Overall data status">
        <div className="data-overview-item">
          <span>Mode</span>
          <strong>{fixtureMode ? "Fixture data" : "Live data"}</strong>
        </div>
        <div className="data-overview-item">
          <span>Connection</span>
          <strong className={connectionStale ? "is-stale" : "is-synced"}>
            <span className="data-state-dot" aria-hidden="true" />
            {connectionLabel}
          </strong>
        </div>
        <div className="data-overview-item">
          <span>Last synced</span>
          <strong className="num">
            {syncedAt ? fmtTime(syncedAt) : "No snapshot"}
          </strong>
        </div>
      </div>
      <p className="source-intro">
        Feeds load independently. If one falls behind, completed-round data stays
        visible until its next valid snapshot.
      </p>
      <div className="source-list">
        {SOURCES.map((source, index) => {
          const fetchedAt = sourceUpdates[index];
          const sourceHealth = collector?.health[source.id];
          const unavailable =
            sourceHealth?.status === "unavailable" || fetchedAt == null;
          const sourceStale =
            sourceHealth !== undefined
              ? !sourceHealth.fresh
              : stale;
          const status = sourceHealth?.status === "unavailable"
            ? "Unavailable"
            : unavailable
              ? "Waiting"
              : sourceStale
                ? "Stale"
                : "Loaded";
          return (
            <div className="source-row" key={source.id}>
              <div className="source-row-copy">
                <strong>{source.name}</strong>
                <span>{source.detail}</span>
                <div className="source-meta">
                  <span>{source.cadence}</span>
                  <span className="source-time num">
                    {sourceHealth?.sourceUpdatedAt
                      ? `Source updated ${fmtTime(sourceHealth.sourceUpdatedAt)}`
                      : fetchedAt
                        ? `Updated ${fmtTime(fetchedAt)}`
                      : "No snapshot for this card"}
                  </span>
                  {sourceHealth && (
                    <span className="source-time num">
                      Received {fmtTime(sourceHealth.checkedAt)}
                    </span>
                  )}
                </div>
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
        Personal, non-commercial use only. Feed data is never shared or published.
      </p>
    </section>
  );
}
