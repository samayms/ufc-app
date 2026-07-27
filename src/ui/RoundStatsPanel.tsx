import type { BoutView, Corner, RoundStats } from "../schema/types.ts";
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

function totals(view: BoutView, corner: Corner): Required<RoundStats> {
  const sums: Required<RoundStats> = {
    significantStrikes: 0,
    totalStrikes: 0,
    takedowns: 0,
    controlTimeSeconds: 0,
    knockdowns: 0,
  };
  for (const update of view.rounds.cito ?? []) {
    const s = update.stats?.[corner];
    if (!s) continue;
    for (const row of STAT_ROWS) {
      sums[row.key] += s[row.key] ?? 0;
    }
  }
  return sums;
}

export function RoundStatsPanel({ view }: { view: BoutView }) {
  const citoRounds = view.rounds.cito ?? [];
  if (!citoRounds.some((u) => u.stats)) return null;

  const red = totals(view, "red");
  const blue = totals(view, "blue");
  const through = citoRounds.at(-1);

  return (
    <section className="panel" aria-label="Fight stats">
      <div className="panel-head">
        <h2>Fight stats</h2>
        <span className="freshness">
          Cito · through R{through?.round} ·{" "}
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
