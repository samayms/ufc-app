import type { BoutView } from "../schema/types.ts";

export type RoundSelection = number | "total";

export function completedRounds(view: BoutView): number[] {
  return [
    ...new Set(
      Object.values(view.rounds)
        .flat()
        .map((round) => round.round),
    ),
  ].sort((a, b) => a - b);
}

export function defaultRoundSelection(view: BoutView): RoundSelection {
  return completedRounds(view).at(-1) ?? 1;
}

export function RoundSelector({
  view,
  value,
  onChange,
}: {
  view: BoutView;
  value: RoundSelection;
  onChange: (round: RoundSelection) => void;
}) {
  const completed = new Set(completedRounds(view));

  return (
    <div className="round-tabs" role="tablist" aria-label="Round">
      {Array.from({ length: view.bout.scheduledRounds }, (_, index) => index + 1).map(
        (round) => {
          const enabled = completed.has(round);
          return (
            <button
              key={round}
              type="button"
              role="tab"
              disabled={!enabled}
              aria-selected={value === round}
              className={`round-tab${value === round ? " is-active" : ""}`}
              onClick={() => onChange(round)}
            >
              R{round}
            </button>
          );
        },
      )}
      <button
        type="button"
        role="tab"
        disabled={completed.size === 0}
        aria-selected={value === "total"}
        className={`round-tab round-tab-total${value === "total" ? " is-active" : ""}`}
        onClick={() => onChange("total")}
      >
        Tot
      </button>
    </div>
  );
}
