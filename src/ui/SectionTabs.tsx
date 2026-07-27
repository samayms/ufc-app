export type FightSection = "summary" | "stats" | "odds" | "tale";

const SECTIONS: { id: FightSection; label: string }[] = [
  { id: "summary", label: "Fight" },
  { id: "stats", label: "Stats" },
  { id: "odds", label: "Odds" },
  { id: "tale", label: "Tale" },
];

export function SectionTabs({
  active,
  onChange,
}: {
  active: FightSection;
  onChange: (section: FightSection) => void;
}) {
  return (
    <div className="section-tabs" role="tablist" aria-label="Fight information">
      {SECTIONS.map((section) => (
        <button
          key={section.id}
          type="button"
          role="tab"
          aria-selected={active === section.id}
          className={`section-tab${active === section.id ? " is-active" : ""}`}
          onClick={() => onChange(section.id)}
        >
          {section.label}
        </button>
      ))}
    </div>
  );
}
