export type FightSection = "summary" | "odds" | "tale";

const SECTION_LABEL: Record<FightSection, string> = {
  summary: "Fight",
  odds: "Odds",
  tale: "Tale",
};

const DEFAULT_SECTIONS: FightSection[] = ["summary", "odds", "tale"];

export function SectionTabs({
  active,
  onChange,
  sections = DEFAULT_SECTIONS,
}: {
  active: FightSection;
  onChange: (section: FightSection) => void;
  /** Restrict which tabs render, in order. Defaults to all four, preserving prior behavior. */
  sections?: FightSection[];
}) {
  return (
    <div className="section-tabs" role="tablist" aria-label="Fight information">
      {sections.map((id) => ({ id, label: SECTION_LABEL[id] })).map((section) => (
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
