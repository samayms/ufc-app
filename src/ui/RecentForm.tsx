import type { Corner, Fighter, PastBout } from "../schema.ts";
import { fmtMethod } from "./format.ts";

const RESULT_LETTER: Record<PastBout["result"], string> = {
  win: "W",
  loss: "L",
  draw: "D",
  nc: "NC",
};

function FormColumn({ fighter, corner }: { fighter: Fighter; corner: Corner }) {
  const bouts = fighter.recentBouts ?? [];
  return (
    <div className={`form-col form-${corner}`}>
      <h3 className={`corner-${corner}`}>{fighter.name.split(" ").at(-1)}</h3>
      {bouts.length === 0 ? (
        <p className="empty">No fight history for this fighter.</p>
      ) : (
        <ul className="form-list">
          {bouts.map((pb, i) => (
            <li key={i}>
              <span className={`form-result form-result-${pb.result}`}>
                {RESULT_LETTER[pb.result]}
              </span>
              <span className="form-opp">{pb.opponentName}</span>
              <span className="form-method num">
                {fmtMethod(pb.method)}
                {pb.round ? ` R${pb.round}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Recent fight history for both corners. */
export function RecentForm({ fighters }: { fighters: Record<Corner, Fighter> }) {
  const hasAny =
    (fighters.red.recentBouts?.length ?? 0) > 0 ||
    (fighters.blue.recentBouts?.length ?? 0) > 0;
  if (!hasAny) return null;
  return (
    <section className="panel" aria-label="Recent form">
      <div className="form-grid">
        <FormColumn fighter={fighters.red} corner="red" />
        <FormColumn fighter={fighters.blue} corner="blue" />
      </div>
    </section>
  );
}
