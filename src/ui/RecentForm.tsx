import type { Bout, Corner, Fighter, PastBout } from "../schema/types.ts";
import { fmtMethod, fmtTime } from "./format.ts";

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
        <p className="empty">No cached history for this fighter.</p>
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

/** Cached recent history for both corners — fetch-once data, no polling. */
export function RecentForm({ bout }: { bout: Bout }) {
  const hasAny =
    (bout.fighters.red.recentBouts?.length ?? 0) > 0 ||
    (bout.fighters.blue.recentBouts?.length ?? 0) > 0;
  if (!hasAny) return null;
  return (
    <section className="panel" aria-label="Recent form">
      <div className="panel-head">
        <h2>Recent form</h2>
        <span className="freshness">
          cached fighter history · fetched{" "}
          <span className="num">{fmtTime(bout.fighters.red.provenance.fetchedAt)}</span>
        </span>
      </div>
      <div className="form-grid">
        <FormColumn fighter={bout.fighters.red} corner="red" />
        <FormColumn fighter={bout.fighters.blue} corner="blue" />
      </div>
    </section>
  );
}
