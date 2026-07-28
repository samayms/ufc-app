import type {
  EspnScheduledCard,
  EspnScheduledFight,
} from "../sources/espnSchedule.ts";
import { fmtTime } from "./format.ts";

function fightChipLabel(fight: EspnScheduledFight): string {
  if (fight.titleFight) return "TITLE";
  if (fight.mainEvent) return "MAIN";
  return "UPCOMING";
}

/**
 * Renders an ESPN future card using the same rail markup as CardRail, but
 * as non-interactive rows — there is no live data for future events, so
 * these are informational only (never selectable into the fight view).
 */
export function ScheduledCardRail({ card }: { card: EspnScheduledCard }) {
  return (
    <nav className="rail" aria-label="Upcoming fight card">
      {card.sections.map((section) => (
        <section key={section.key} className="rail-segment">
          <h2 className="rail-heading">
            {section.displayName}
            {section.startsAt ? ` · from ${fmtTime(section.startsAt)}` : ""}
          </h2>
          {section.fights.map((fight) => (
            <div key={fight.competitionId} className="rail-bout">
              <span className="rail-corners" aria-hidden="true">
                <span className="rail-corner rail-corner-red" />
                <span className="rail-corner rail-corner-blue" />
              </span>
              <span className="rail-names">
                <span className="rail-name corner-red">{fight.red.name}</span>
                <span className="rail-name corner-blue">{fight.blue.name}</span>
              </span>
              <span className="rail-meta">
                <span className="chip chip-upcoming">
                  {fightChipLabel(fight)}
                </span>
                {fight.weightClassLabel && (
                  <span className="rail-weight">{fight.weightClassLabel}</span>
                )}
              </span>
            </div>
          ))}
        </section>
      ))}
    </nav>
  );
}
