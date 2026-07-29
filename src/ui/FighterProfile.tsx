import type { Corner, Fighter } from "../schema.ts";
import { fmtRecord } from "./format.ts";

function value(value: string | number | undefined, suffix = "") {
  return value == null ? "—" : `${value}${suffix}`;
}

function Profile({
  fighter,
  corner,
}: {
  fighter: Fighter;
  corner: Corner;
}) {
  const last = fighter.name.split(" ").at(-1) ?? fighter.name;
  return (
    <div className={`profile profile-${corner}`}>
      <h3 className={`corner-${corner}`}>{last}</h3>
      <span className="profile-record num">{fmtRecord(fighter.record)}</span>
      {fighter.nickname && <span className="profile-nick">"{fighter.nickname}"</span>}
      {fighter.ranking && <span className="profile-ranking">{fighter.ranking}</span>}
    </div>
  );
}

export function FighterProfile({ fighters }: { fighters: Record<Corner, Fighter> }) {
  const { red, blue } = fighters;
  const rows = [
    ["Age", value(red.age), value(blue.age)],
    ["Height", value(red.heightCm, " cm"), value(blue.heightCm, " cm")],
    ["Reach", value(red.reachCm, " cm"), value(blue.reachCm, " cm")],
    ["Stance", value(red.stance), value(blue.stance)],
    ["Country", value(red.country), value(blue.country)],
  ];
  return (
    <section className="profile-panel" aria-label="Fighter comparison">
      <div className="profile-head">
        <Profile fighter={red} corner="red" />
        <span className="profile-vs">vs</span>
        <Profile fighter={blue} corner="blue" />
      </div>
      <div className="profile-rows">
        {rows.map(([label, redValue, blueValue]) => (
          <div className="profile-row" key={label}>
            <span className="num">{redValue}</span>
            <span>{label}</span>
            <span className="num">{blueValue}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
