import type { BoutView, Corner, RoundStats, RoundUpdate } from "../schema.ts";
import type { RoundSelection } from "./RoundSelector.tsx";
import { fmtTime } from "./format.ts";

type StatKey = keyof RoundStats;

type StatRow = {
  key: StatKey;
  attemptedKey?: StatKey;
  legacyKey?: StatKey;
  legacyAttemptedKey?: StatKey;
  label: string;
  format?: (value: number) => string;
};

const STAT_ROWS: StatRow[] = [
  { key: "significantStrikesLanded", attemptedKey: "significantStrikesAttempted", legacyKey: "significantStrikes", legacyAttemptedKey: "totalStrikes", label: "Sig. strikes" },
  { key: "totalStrikesLanded", attemptedKey: "totalStrikesAttempted", legacyKey: "totalStrikes", label: "Total strikes" },
  { key: "headStrikesLanded", attemptedKey: "headStrikesAttempted", legacyKey: "headStrikes", label: "Head" },
  { key: "bodyStrikesLanded", attemptedKey: "bodyStrikesAttempted", legacyKey: "bodyStrikes", label: "Body" },
  { key: "legStrikesLanded", attemptedKey: "legStrikesAttempted", legacyKey: "legStrikes", label: "Leg" },
  { key: "takedownsLanded", attemptedKey: "takedownsAttempted", legacyKey: "takedowns", label: "Takedowns" },
  { key: "submissionsAttempted", legacyKey: "submissionAttempts", label: "Submission attempts" },
  {
    key: "controlTimeSeconds",
    label: "Control",
    format: (value) => `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`,
  },
  { key: "knockdowns", label: "Knockdowns" },
  { key: "reversals", label: "Reversals" },
];

function updatesForStats(view: BoutView, selection: RoundSelection): RoundUpdate[] {
  // ESPN is authoritative for the live app. Cito remains a fixture-compatible
  // fallback until all stored fixture snapshots have been migrated.
  const source = (view.rounds.espn ?? []).some((update) => update.stats)
    ? view.rounds.espn ?? []
    : view.rounds.cito ?? [];
  return selection === "total"
    ? source
    : source.filter((update) => update.round === selection);
}

function total(updates: readonly RoundUpdate[], corner: Corner, key: StatKey, legacyKey?: StatKey): number | undefined {
  let present = false;
  const value = updates.reduce((sum, update) => {
    const next = update.stats?.[corner]?.[key] ?? (legacyKey ? update.stats?.[corner]?.[legacyKey] : undefined);
    if (next === undefined) return sum;
    present = true;
    return sum + next;
  }, 0);
  return present ? value : undefined;
}

function value(value: number | undefined, attempted: number | undefined, format?: (value: number) => string) {
  if (value === undefined) return "—";
  if (format) return format(value);
  return attempted === undefined ? value : `${value}/${attempted}`;
}

/** Expanded ESPN-derived breakdown for the live-fight Stats tab. */
export function LiveStatsPanel({ view, selection }: { view: BoutView; selection: RoundSelection }) {
  const updates = updatesForStats(view, selection);
  const rows = STAT_ROWS.map((row) => {
    const red = total(updates, "red", row.key, row.legacyKey);
    const blue = total(updates, "blue", row.key, row.legacyKey);
    return {
      ...row,
      red,
      blue,
      redAttempted: row.attemptedKey ? total(updates, "red", row.attemptedKey, row.legacyAttemptedKey) : undefined,
      blueAttempted: row.attemptedKey ? total(updates, "blue", row.attemptedKey, row.legacyAttemptedKey) : undefined,
    };
  });
  const hasStats = rows.some((row) => row.red !== undefined || row.blue !== undefined);
  const latest = updates.at(-1);
  const heading = selection === "total" ? "Fight statistics" : `Round ${selection} statistics`;

  return (
    <section className="compact-stats live-stats" aria-label={heading}>
      <div className="compact-stats-head">
        <span>{heading}</span>
        {latest ? <span className="freshness">{latest.provenance.source.toUpperCase()} · <span className="num">{fmtTime(latest.provenance.fetchedAt)}</span></span> : null}
      </div>
      {hasStats ? (
        <div className="compact-stat-list">
          {rows.map((row) => {
            const red = row.red ?? 0;
            const blue = row.blue ?? 0;
            const max = Math.max(red, blue, 1);
            return (
              <div className="compact-stat" key={row.key}>
                <div className="compact-stat-values">
                  <span className={`num${red > blue ? " corner-red" : ""}`}>{value(row.red, row.redAttempted, row.format)}</span>
                  <span>{row.label}</span>
                  <span className={`num${blue > red ? " corner-blue" : ""}`}>{value(row.blue, row.blueAttempted, row.format)}</span>
                </div>
                <div className="compact-stat-bars" aria-hidden="true">
                  <span><i className="compact-bar-red" style={{ width: `${(red / max) * 100}%` }} /></span>
                  <span><i className="compact-bar-blue" style={{ width: `${(blue / max) * 100}%` }} /></span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="empty">
          {view.bout.status === "final"
            ? "ESPN did not publish a detailed statistical breakdown for this bout."
            : "Detailed ESPN statistics will appear as the fight progresses."}
        </p>
      )}
    </section>
  );
}
