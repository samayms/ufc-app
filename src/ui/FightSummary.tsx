import type {
  BoutView,
  Corner,
  RoundStats,
  RoundUpdate,
} from "../schema/types.ts";
import type { RoundSelection } from "./RoundSelector.tsx";

const STAT_ROWS: {
  key: keyof RoundStats;
  totalKey?: keyof RoundStats;
  label: string;
  format?: (value: number) => string;
}[] = [
  { key: "significantStrikes", totalKey: "totalStrikes", label: "Sig. strikes" },
  { key: "takedowns", totalKey: "takedownsAttempted", label: "Takedowns" },
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
    redTotal: row.totalKey ? statTotal(stats, "red", row.totalKey) : null,
    blueTotal: row.totalKey ? statTotal(stats, "blue", row.totalKey) : null,
  }));
  const hasStats = rows.some((row) => row.red != null || row.blue != null);
  const summary = preferredSummary(view, selection);
  const selectionLabel =
    selection === "total" ? "Fight totals" : `Round ${selection}`;

  return (
    <div className="fight-summary">
      <section className="compact-stats" aria-label={`${selectionLabel} statistics`}>
        <div className="compact-stats-head">
          <span>{selectionLabel}</span>
          {!hasStats && (
            <span className="freshness">awaiting completed-round stats</span>
          )}
        </div>
        {hasStats ? (
          <div className="compact-stat-list">
            {rows.map((row) => {
              const red = row.red ?? 0;
              const blue = row.blue ?? 0;
              const total = Math.max(red + blue, 1);
              const redDisplay = row.format
                ? row.format(red)
                : row.redTotal != null
                  ? `${red}/${row.redTotal}`
                  : red;
              const blueDisplay = row.format
                ? row.format(blue)
                : row.blueTotal != null
                  ? `${blue}/${row.blueTotal}`
                  : blue;
              return (
                <div className="compact-stat" key={row.key}>
                  <div className="compact-stat-values">
                    <span className={`num${red >= blue ? " corner-red" : ""}`}>
                      {redDisplay}
                    </span>
                    <span>{row.label}</span>
                    <span className={`num${blue >= red ? " corner-blue" : ""}`}>
                      {blueDisplay}
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
            {view.bout.status === "canceled" ||
            view.bout.status === "postponed"
              ? `This bout was ${view.bout.status}; no round statistics are expected.`
              : view.bout.status === "upcoming"
              ? "Stats lock in after each completed round."
              : "The latest valid snapshot is temporarily unavailable."}
          </p>
        )}
      </section>

      <section className="round-summary" aria-label="Round summary">
        <p>
          {summary?.summary ??
            (view.bout.status === "canceled" ||
            view.bout.status === "postponed"
              ? `This bout was ${view.bout.status}; no round summary is expected.`
              : view.bout.status === "upcoming"
              ? "A grounded summary will appear after the round is complete."
              : "No narrative source has published this round yet.")}
        </p>
      </section>
    </div>
  );
}
