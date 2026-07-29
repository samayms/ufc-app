import { useState } from "react";
import type {
  EspnScheduledCard,
  EspnScheduledFight,
  EspnScheduledFighter,
} from "../sources/espnSchedule.ts";
import { fmtMethod, fmtTime } from "./format.ts";
import "./newComponents.css";

/**
 * Mirrors CardRail.tsx's StatusChip: ESPN's fightcenter status is real for
 * every card, not just the one this app's collector tracks, so a fight a
 * user is already looking at can go live or final without the chip lying
 * and saying "upcoming" forever.
 */
function FightStatusChip({ fight }: { fight: EspnScheduledFight }) {
  switch (fight.status) {
    case "in-round":
      return <span className="chip chip-live">LIVE R{fight.currentRound}</span>;
    case "between-rounds":
      return <span className="chip chip-live">END R{fight.currentRound}</span>;
    case "final": {
      const r = fight.result;
      return (
        <span className="chip chip-final">
          {r ? `${fmtMethod(r.method)}${r.round ? ` R${r.round}` : ""}` : "FINAL"}
        </span>
      );
    }
    case "canceled":
    case "postponed":
      return (
        <span className="chip chip-canceled">{fight.status.toUpperCase()}</span>
      );
    default:
      return (
        <span className="chip chip-upcoming">
          UPCOMING
        </span>
      );
  }
}

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
}: {
  fighter: EspnScheduledFighter;
  corner: "red" | "blue";
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = fighter.headshotUrl && !imgFailed;
  return (
    <span
      className={`rail-photo rail-photo-${corner}`}
      aria-hidden={showImg ? undefined : "true"}
    >
      {showImg ? (
        <img
          className="fighter-photo-img"
          src={fighter.headshotUrl}
          alt={fighter.name}
          onError={() => setImgFailed(true)}
        />
      ) : (
        initialsOf(fighter.name)
      )}
    </span>
  );
}

/**
 * Renders an ESPN future card using the same rail markup as CardRail.
 * Clicking a fight opens the lightweight ScheduledFightPreview — there's no
 * live round data for a future fight, so it's a preview, not the full fight
 * screen.
 */
export function ScheduledCardRail({
  card,
  onSelect,
}: {
  card: EspnScheduledCard;
  onSelect: (fight: EspnScheduledFight) => void;
}) {
  return (
    <nav className="rail" aria-label="Upcoming fight card">
      {card.sections.map((section) => (
        <section key={section.key} className="rail-segment">
          <h2 className="rail-heading">
            {section.displayName}
            {section.startsAt ? ` · from ${fmtTime(section.startsAt)}` : ""}
          </h2>
          {section.fights.map((fight) => (
            <button
              key={fight.competitionId}
              type="button"
              className="rail-bout"
              onClick={() => onSelect(fight)}
            >
              <span className="rail-photos">
                <RailPhoto fighter={fight.red} corner="red" />
                <RailPhoto fighter={fight.blue} corner="blue" />
              </span>
              <span className="rail-names">
                <span className="rail-name corner-red">{fight.red.name}</span>
                <span className="rail-name corner-blue">{fight.blue.name}</span>
              </span>
              <span className="rail-meta">
                <FightStatusChip fight={fight} />
                {fight.weightClassLabel && (
                  <span className="rail-weight">{fight.weightClassLabel}</span>
                )}
              </span>
            </button>
          ))}
        </section>
      ))}
    </nav>
  );
}
