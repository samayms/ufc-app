import type { Bout } from "../schema.ts";
import { MatchupCard } from "./MatchupCard.tsx";
import { fmtMethod, WEIGHT_LABEL } from "./format.ts";
import "./newComponents.css";

const SEGMENT_LABEL = {
  "main-card": "Main card",
  prelims: "Prelims",
  "early-prelims": "Early prelims",
} as const;

function StatusChip({ bout }: { bout: Bout }) {
  switch (bout.status) {
    case "in-round":
      return <span className="chip chip-live">LIVE R{bout.currentRound}</span>;
    case "between-rounds":
      return <span className="chip chip-live">END R{bout.currentRound}</span>;
    case "final": {
      const r = bout.result;
      return (
        <span className="chip chip-final">
          {r ? `${fmtMethod(r.method)}${r.round ? ` R${r.round}` : ""}` : "FINAL"}
        </span>
      );
    }
    case "canceled":
    case "postponed":
      return (
        <span className="chip chip-canceled">
          {bout.status.toUpperCase()}
        </span>
      );
    default:
      return <span className="chip chip-upcoming">UPCOMING</span>;
  }
}

export function CardRail({
  bouts,
  selectedId,
  onSelect,
  photosByBoutId,
}: {
  bouts: Bout[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** Optional fighter photo URLs, keyed by bout id. Falls back to initials-in-circle when absent. */
  photosByBoutId?: Record<string, { red?: string; blue?: string }>;
}) {
  const segments = ["main-card", "prelims", "early-prelims"] as const;
  return (
    <nav className="rail" aria-label="Fight card">
      {segments.map((seg) => {
        const segBouts = bouts.filter((b) => b.segment === seg);
        if (segBouts.length === 0) return null;
        return (
          <section key={seg} className="rail-segment">
            <h2 className="rail-heading">{SEGMENT_LABEL[seg]}</h2>
            {segBouts.map((bout) => {
              const winner =
                bout.status === "final" && bout.result
                  ? bout.result.winner
                  : null;
              return (
                <MatchupCard
                  key={bout.id}
                  isSelected={bout.id === selectedId}
                  onSelect={() => onSelect(bout.id)}
                  red={{
                    name: bout.fighters.red.name,
                    photoUrl: photosByBoutId?.[bout.id]?.red,
                  }}
                  blue={{
                    name: bout.fighters.blue.name,
                    photoUrl: photosByBoutId?.[bout.id]?.blue,
                  }}
                  redIsLoser={winner === "blue"}
                  blueIsLoser={winner === "red"}
                  center={
                    <span className="event-card-center">
                      <StatusChip bout={bout} />
                      <span className="event-card-center-weight">
                        {WEIGHT_LABEL[bout.weightClass]}
                      </span>
                    </span>
                  }
                />
              );
            })}
          </section>
        );
      })}
    </nav>
  );
}
