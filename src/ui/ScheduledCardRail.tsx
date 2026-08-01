import type {
  EspnScheduledCard,
  EspnScheduledFight,
} from "../sources/espnSchedule.ts";
import { FitText, MatchupCard } from "./MatchupCard.tsx";
import { fmtFightPhase, fmtTime } from "./format.ts";
import "./newComponents.css";

/**
 * Mirrors CardRail.tsx's StatusChip: ESPN's fightcenter status is real for
 * every card, not just the one this app's collector tracks, so a fight a
 * user is already looking at can go live or final without the chip lying
 * and saying "upcoming" forever.
 */
function FightStatusChip({ fight }: { fight: EspnScheduledFight }) {
  const label = fmtFightPhase(
    fight.status,
    fight.currentRound,
    fight.result,
  );
  switch (fight.status) {
    case "in-round":
    case "between-rounds":
      return <span className="chip chip-live">{label}</span>;
    case "final":
      return <span className="chip chip-final">{label}</span>;
    case "canceled":
    case "postponed":
      return <span className="chip chip-canceled">{label}</span>;
    default:
      return <span className="chip chip-upcoming">{label}</span>;
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
                winnerCorner={winner === "red" || winner === "blue" ? winner : undefined}
                isLive={
                  fight.status === "in-round" || fight.status === "between-rounds"
                }
                center={
                  <>
                    <FightStatusChip fight={fight} />
                    {fight.weightClassLabel && (
                      <FitText
                        className="event-card-center-weight"
                        text={fight.weightClassLabel}
                      />
                    )}
                  </>
                }
              />
            );
          })}
        </section>
      ))}
    </nav>
  );
}
