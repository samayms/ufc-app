import { useState } from "react";
import type { Bout, Corner, Fighter } from "../schema.ts";
import { fmtMethod, WEIGHT_LABEL } from "./format.ts";
import "./newComponents.css";

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2);
}

function RailPhoto({
  fighter,
  corner,
  photoUrl,
}: {
  fighter: Fighter;
  corner: Corner;
  photoUrl?: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = photoUrl && !imgFailed;
  return (
    <span
      className={`rail-photo rail-photo-${corner}`}
      aria-hidden={showImg ? undefined : "true"}
    >
      {showImg ? (
        <img
          className="fighter-photo-img"
          src={photoUrl}
          alt={fighter.name}
          onError={() => setImgFailed(true)}
        />
      ) : (
        initialsOf(fighter.name)
      )}
    </span>
  );
}

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
                <button
                  key={bout.id}
                  className={`rail-bout${bout.id === selectedId ? " is-selected" : ""}`}
                  onClick={() => onSelect(bout.id)}
                  aria-current={bout.id === selectedId ? "true" : undefined}
                >
                  <span className="rail-photos">
                    <RailPhoto
                      fighter={bout.fighters.red}
                      corner="red"
                      photoUrl={photosByBoutId?.[bout.id]?.red}
                    />
                    <RailPhoto
                      fighter={bout.fighters.blue}
                      corner="blue"
                      photoUrl={photosByBoutId?.[bout.id]?.blue}
                    />
                  </span>
                  <span className="rail-names">
                    <span className={`rail-name corner-red${winner === "blue" ? " is-loser" : ""}`}>
                      {bout.fighters.red.name}
                    </span>
                    <span className={`rail-name corner-blue${winner === "red" ? " is-loser" : ""}`}>
                      {bout.fighters.blue.name}
                    </span>
                  </span>
                  <span className="rail-meta">
                    <StatusChip bout={bout} />
                    <span className="rail-weight">{WEIGHT_LABEL[bout.weightClass]}</span>
                  </span>
                </button>
              );
            })}
          </section>
        );
      })}
    </nav>
  );
}
