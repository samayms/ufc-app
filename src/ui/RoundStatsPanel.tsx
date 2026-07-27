import type { BoutView, Corner, RoundStats } from "../schema/types.ts";
import type { RoundSelection } from "./RoundSelector.tsx";
import { fmtTime } from "./format.ts";

/**
 * Cumulative fight stats across completed rounds, red vs blue as mirrored
 * bars from the center. Cito is the only source carrying per-round stats.
 */

type StatKey = keyof RoundStats;

const STAT_ROWS: { key: StatKey; label: string; fmt?: (n: number) => string }[] = [
  { key: "significantStrikes", label: "Significant strikes" },
  { key: "totalStrikes", label: "Total strikes" },
  { key: "takedowns", label: "Takedowns" },
  {
    key: "controlTimeSeconds",
    label: "Control time",
    fmt: (n) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`,
  },
  { key: "knockdowns", label: "Knockdowns" },
];

function totals(
  view: BoutView,
  corner: Corner,
  selection: RoundSelection,
): Required<RoundStats> {
  const sums: Required<RoundStats> = {
    significantStrikes: 0,
    totalStrikes: 0,
    takedowns: 0,
    controlTimeSeconds: 0,
    knockdowns: 0,
  };
  for (const update of view.rounds.cito ?? []) {
    if (selection !== "total" && update.round !== selection) continue;
    const s = update.stats?.[corner];
    if (!s) continue;
    for (const row of STAT_ROWS) {
      sums[row.key] += s[row.key] ?? 0;
    }
  }
  return sums;
}

export function RoundStatsPanel({
  view,
  selection = "total",
}: {
  view: BoutView;
  selection?: RoundSelection;
}) {
  const citoRounds = view.rounds.cito ?? [];
  const selectedUpdates =
    selection === "total"
      ? citoRounds
      : citoRounds.filter((update) => update.round === selection);
  const heading =
    selection === "total" ? "Fight totals" : `Round ${selection} stats`;

  if (!selectedUpdates.some((update) => update.stats)) {
    return (
      <section className="panel" aria-label={heading}>
        <div className="panel-head">
          <h2>{heading}</h2>
        </div>
        <p className="empty">
          {view.bout.status === "upcoming"
            ? "Detailed statistics unlock after a completed round."
            : "This source did not provide statistics for the selected round."}
        </p>
      </section>
    );
  }

  const red = totals(view, "red", selection);
  const blue = totals(view, "blue", selection);
  const through = selectedUpdates.at(-1);

  return (
    <section className="panel" aria-label="Fight stats">
      <div className="panel-head">
        <h2>{heading}</h2>
        <span className="freshness">
          Cito ·{" "}
          {selection === "total"
            ? `through R${through?.round}`
            : `R${through?.round}`}{" "}
          ·{" "}
          <span className="num">{fmtTime(through?.provenance.fetchedAt ?? "")}</span>
        </span>
      </div>
      <div className="stats">
        {STAT_ROWS.map(({ key, label, fmt }) => {
          const r = red[key];
          const b = blue[key];
          const max = Math.max(r, b, 1);
          return (
            <div key={key} className="stat-row">
              <span className="stat-val num">{fmt ? fmt(r) : r}</span>
              <span className="stat-bar stat-bar-red">
                <span style={{ width: `${(r / max) * 100}%` }} />
              </span>
              <span className="stat-label">{label}</span>
              <span className="stat-bar stat-bar-blue">
                <span style={{ width: `${(b / max) * 100}%` }} />
              </span>
              <span className="stat-val stat-val-blue num">{fmt ? fmt(b) : b}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
