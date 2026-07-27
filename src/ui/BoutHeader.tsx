import type { Bout, Corner, Fighter } from "../schema/types.ts";
import { fmtMethod, fmtRecord, WEIGHT_LABEL } from "./format.ts";

function FighterBlock({ fighter, corner }: { fighter: Fighter; corner: Corner }) {
  const initials = fighter.name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2);
  const lastName = fighter.name.split(" ").at(-1) ?? fighter.name;

  return (
    <div className={`tot-fighter tot-${corner}`}>
      <span className={`fighter-photo fighter-photo-${corner}`} aria-hidden="true">
        {initials}
      </span>
      <span className={`tot-name corner-${corner}`} title={fighter.name}>
        {lastName}
      </span>
      <span className="tot-record num">{fmtRecord(fighter.record)}</span>
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
          {bout.status === "in-round" ? "Live" : "Between rds"}
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
      <span className="tot-live-label tot-upcoming">Upcoming</span>
      <span className="tot-round-label num">{bout.scheduledRounds}×5</span>
      <span className="tot-substate">rounds · not started</span>
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
