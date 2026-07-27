import type {
  BoutView,
  Corner,
  RoundStats,
  RoundUpdate,
  SourceId,
} from "../schema/types.ts";
import type { RoundSelection } from "./RoundSelector.tsx";
import { fmtTime } from "./format.ts";

const SOURCE_LABEL: Partial<Record<SourceId, string>> = {
  cito: "Cito",
  espn: "ESPN FightCenter",
  sherdog: "Sherdog",
};

const STAT_ROWS: {
  key: keyof RoundStats;
  label: string;
  format?: (value: number) => string;
}[] = [
  { key: "significantStrikes", label: "Sig. strikes" },
  { key: "takedowns", label: "Takedowns" },
  {
    key: "controlTimeSeconds",
    label: "Control",
    format: (value) =>
      `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`,
  },
  { key: "knockdowns", label: "Knockdowns" },
];

function updatesForSelection(
  updates: RoundUpdate[],
  selection: RoundSelection,
): RoundUpdate[] {
  return selection === "total"
    ? updates
    : updates.filter((update) => update.round === selection);
}

function statTotal(
  updates: RoundUpdate[],
  corner: Corner,
  key: keyof RoundStats,
): number | null {
  let found = false;
  const total = updates.reduce((sum, update) => {
    const value = update.stats?.[corner]?.[key];
    if (value == null) return sum;
    found = true;
    return sum + value;
  }, 0);
  return found ? total : null;
}

function preferredSummary(view: BoutView, selection: RoundSelection) {
  const ordered = [
    ...(view.rounds.sherdog ?? []),
    ...(view.rounds.espn ?? []),
    ...(view.rounds.cito ?? []),
  ];
  const candidates =
    selection === "total"
      ? ordered.filter((update) => update.summary)
      : ordered.filter(
          (update) => update.round === selection && update.summary,
        );
  return candidates.sort((a, b) => b.round - a.round)[0];
}

function scoreConsensus(view: BoutView, selection: RoundSelection) {
  const scored = Object.values(view.rounds)
    .flat()
    .filter(
      (update) =>
        update.score &&
        (selection === "total" || update.round === selection),
    );
  if (scored.length === 0) return null;

  const totals = scored.reduce(
    (sum, update) => ({
      red: sum.red + (update.score?.red ?? 0),
      blue: sum.blue + (update.score?.blue ?? 0),
    }),
    { red: 0, blue: 0 },
  );
  const redEdges = scored.filter(
    (update) => (update.score?.red ?? 0) > (update.score?.blue ?? 0),
  ).length;
  const blueEdges = scored.filter(
    (update) => (update.score?.blue ?? 0) > (update.score?.red ?? 0),
  ).length;
  const sourceScores = new Set(
    scored.map((update) => `${update.score?.red}-${update.score?.blue}`),
  );

  if (selection === "total") {
    return {
      line: `Unofficial ${totals.red}-${totals.blue}`,
      meta: `${scored.length} source rounds`,
      disagreement: sourceScores.size > 1,
    };
  }

  const edge: Corner | "split" =
    redEdges > blueEdges ? "red" : blueEdges > redEdges ? "blue" : "split";
  const edgeName =
    edge === "split"
      ? "scorers split"
      : view.bout.fighters[edge].name.split(" ").at(-1);
  return {
    line: `Unofficial 10-9 ${edgeName}`,
    meta: `${Math.max(redEdges, blueEdges)} of ${scored.length} sources`,
    disagreement: redEdges > 0 && blueEdges > 0,
  };
}

export function FightSummary({
  view,
  selection,
}: {
  view: BoutView;
  selection: RoundSelection;
}) {
  const stats = updatesForSelection(view.rounds.cito ?? [], selection);
  const rows = STAT_ROWS.map((row) => ({
    ...row,
    red: statTotal(stats, "red", row.key),
    blue: statTotal(stats, "blue", row.key),
  }));
  const hasStats = rows.some((row) => row.red != null || row.blue != null);
  const summary = preferredSummary(view, selection);
  const score = scoreConsensus(view, selection);
  const selectionLabel =
    selection === "total" ? "Fight totals" : `Round ${selection}`;

  return (
    <div className="fight-summary">
      <section className="compact-stats" aria-label={`${selectionLabel} statistics`}>
        <div className="compact-stats-head">
          <span>{selectionLabel}</span>
          <span className="freshness">
            {hasStats ? "Cito · landed counts" : "awaiting completed-round stats"}
          </span>
        </div>
        {hasStats ? (
          <div className="compact-stat-list">
            {rows.map((row) => {
              const red = row.red ?? 0;
              const blue = row.blue ?? 0;
              const total = Math.max(red + blue, 1);
              return (
                <div className="compact-stat" key={row.key}>
                  <div className="compact-stat-values">
                    <span className={`num${red >= blue ? " corner-red" : ""}`}>
                      {row.format ? row.format(red) : red}
                    </span>
                    <span>{row.label}</span>
                    <span className={`num${blue >= red ? " corner-blue" : ""}`}>
                      {row.format ? row.format(blue) : blue}
                    </span>
                  </div>
                  <div className="compact-stat-bars" aria-hidden="true">
                    <span>
                      <i
                        className="compact-bar-red"
                        style={{ width: `${(red / total) * 100}%` }}
                      />
                    </span>
                    <span>
                      <i
                        className="compact-bar-blue"
                        style={{ width: `${(blue / total) * 100}%` }}
                      />
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="empty">
            {view.bout.status === "upcoming"
              ? "Stats lock in after each completed round."
              : "The latest valid snapshot is temporarily unavailable."}
          </p>
        )}
      </section>

      {score && (
        <section
          className={`score-strip${score.disagreement ? " has-disagreement" : ""}`}
          aria-label="Unofficial score"
        >
          <strong>{score.line}</strong>
          <span className="num">{score.meta}</span>
          {score.disagreement && (
            <span className="score-disagreement">Sources disagree</span>
          )}
        </section>
      )}

      <section className="round-summary" aria-label="Round summary">
        <div className="round-summary-head">
          <span>Round summary</span>
          {summary && (
            <span className="freshness">
              {SOURCE_LABEL[summary.provenance.source] ??
                summary.provenance.source}{" "}
              · <span className="num">{fmtTime(summary.provenance.fetchedAt)}</span>
            </span>
          )}
        </div>
        <p>
          {summary?.summary ??
            (view.bout.status === "upcoming"
              ? "A grounded summary will appear after the round is complete."
              : "No narrative source has published this round yet.")}
        </p>
        <span className="summary-provenance">
          {summary
            ? "Source account shown; no actions are inferred beyond the supplied report."
            : "Completed snapshots remain visible while a source catches up."}
        </span>
      </section>
    </div>
  );
}
