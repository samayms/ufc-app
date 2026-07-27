export type AppTab = "fight" | "card" | "sources";

const ITEMS: { id: AppTab; label: string; shortLabel: string }[] = [
  { id: "fight", label: "Live fight", shortLabel: "Fight" },
  { id: "card", label: "Event card", shortLabel: "Card" },
  { id: "sources", label: "Data health", shortLabel: "Data" },
];

export function BottomNav({
  active,
  onChange,
}: {
  active: AppTab;
  onChange: (tab: AppTab) => void;
}) {
  return (
    <nav className="bottom-nav" aria-label="Primary navigation">
      {ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`bottom-nav-item${active === item.id ? " is-active" : ""}`}
          onClick={() => onChange(item.id)}
          aria-current={active === item.id ? "page" : undefined}
          aria-label={item.label}
        >
          <span className="bottom-nav-mark" aria-hidden="true" />
          <span className="bottom-nav-label">{item.shortLabel}</span>
        </button>
      ))}
    </nav>
  );
}
