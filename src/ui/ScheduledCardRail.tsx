import type {
  EspnScheduledCard,
  EspnScheduledFight,
} from "../sources/espnSchedule.ts";
import { FitText, MatchupCard } from "./MatchupCard.tsx";
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

/**
 * Renders an ESPN future card using the same matchup markup as CardRail.
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
          {section.fights.map((fight) => {
            const winner =
              fight.status === "final" && fight.result
                ? fight.result.winner
                : null;
            return (
              <MatchupCard
                key={fight.competitionId}
                isSelected={false}
                onSelect={() => onSelect(fight)}
                red={{ name: fight.red.name, photoUrl: fight.red.headshotUrl }}
                blue={{ name: fight.blue.name, photoUrl: fight.blue.headshotUrl }}
                redIsLoser={winner === "blue"}
                blueIsLoser={winner === "red"}
                center={
                  <span className="event-card-center">
                    <FightStatusChip fight={fight} />
                    {fight.weightClassLabel && (
                      <FitText
                        className="event-card-center-weight"
                        text={fight.weightClassLabel}
                      />
                    )}
                  </span>
                }
              />
            );
          })}
        </section>
      ))}
    </nav>
  );
}
