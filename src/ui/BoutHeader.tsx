import type { Bout, Corner, Fighter } from "../schema/types.ts";
import { fmtMethod, fmtRecord, fmtTime, WEIGHT_LABEL } from "./format.ts";

function FighterBlock({ fighter, corner }: { fighter: Fighter; corner: Corner }) {
  return (
    <div className={`tot-fighter tot-${corner}`}>
      <span className={`tot-name corner-${corner}`}>{fighter.name}</span>
      {fighter.nickname && <span className="tot-nick">“{fighter.nickname}”</span>}
      <span className="tot-record num">{fmtRecord(fighter.record)}</span>
      <span className="tot-meta">
        {[fighter.country, fighter.stance, fighter.age ? `${fighter.age} yrs` : null]
          .filter(Boolean)
          .join(" · ")}
      </span>
      {fighter.heightCm && fighter.reachCm && (
        <span className="tot-meta num">
          {fighter.heightCm} cm · reach {fighter.reachCm} cm
        </span>
      )}
    </div>
  );
}

function CenterStatus({ bout }: { bout: Bout }) {
  if (bout.status === "final" && bout.result) {
    const { winner, method, round, time } = bout.result;
    const name =
      winner === "draw" || winner === "nc"
        ? null
        : bout.fighters[winner as Corner].name.split(" ").at(-1);
    return (
      <>
        <span className="tot-live-label">Final</span>
        <span className="tot-round-label">
          {name ? `${name} wins` : winner.toUpperCase()}
        </span>
        <span className="tot-substate num">
          {fmtMethod(method)}
          {round ? ` · R${round}` : ""}
          {time ? ` ${time}` : ""}
        </span>
      </>
    );
  }
  if (bout.status === "between-rounds" || bout.status === "in-round") {
    return (
      <>
        <span className="tot-live-label">
          <span className="live-dot" aria-hidden="true" />
          {bout.status === "in-round" ? "Live" : "Between rounds"}
        </span>
        <span className="tot-round-label num">
          {bout.status === "in-round" ? `R${bout.currentRound}` : `End R${bout.currentRound}`}
        </span>
        <span className="tot-substate">of {bout.scheduledRounds}</span>
      </>
    );
  }
  return (
    <>
      <span className="tot-live-label">Upcoming</span>
      <span className="tot-round-label num">{fmtTime(bout.provenance.fetchedAt)}</span>
      <span className="tot-substate">{bout.scheduledRounds} rounds</span>
    </>
  );
}

export function BoutHeader({ bout }: { bout: Bout }) {
  return (
    <section className="tot" aria-label="Tale of the tape">
      <div className="tot-class">
        {WEIGHT_LABEL[bout.weightClass]}
        {bout.titleFight ? " · Title fight" : ""}
      </div>
      <div className="tot-grid">
        <FighterBlock fighter={bout.fighters.red} corner="red" />
        <div className="tot-center">
          <CenterStatus bout={bout} />
        </div>
        <FighterBlock fighter={bout.fighters.blue} corner="blue" />
      </div>
    </section>
  );
}
