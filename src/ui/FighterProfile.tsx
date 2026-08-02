import type { Corner, Fighter } from "../schema.ts";

function value(value: string | number | undefined, suffix = "") {
  return value == null ? "—" : `${value}${suffix}`;
}

/**
 * Physicals-only comparison (age/height/reach/stance/country). The
 * name/record/nickname header this used to carry lives in BoutHeader now,
 * directly above the FIGHT/STATS/TALE tabs, so this panel doesn't repeat it.
 */
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
      <div className="profile-rows profile-rows--leading">
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
