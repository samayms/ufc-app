import { type ReactNode, useState } from "react";
import "./newComponents.css";

/** Source-agnostic shape for one side of a matchup — callers adapt real data into this. */
export interface MatchupFighterEntry {
  name: string;
  photoUrl?: string;
}

/** Two-letter initials from a full name, matching BoutHeader.tsx's FighterBlock convention. */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2);
}

function splitName(name: string): { first: string; last: string } {
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? name;
  const last = parts.at(-1) ?? name;
  return { first, last };
}

export function MatchupFighter({
  fighter,
  corner,
  isLoser,
}: {
  fighter: MatchupFighterEntry | undefined;
  corner: "red" | "blue";
  isLoser?: boolean;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const blueSuffix = corner === "blue" ? " is-blue" : "";
  if (!fighter) {
    return <div className={`event-card-fighter${blueSuffix}`} />;
  }
  const showImg = fighter.photoUrl && !imgFailed;
  const { first, last } = splitName(fighter.name);
  const lastNameClass =
    last.length >= 14
      ? "event-card-fighter-lastname event-card-fighter-lastname-tight"
      : last.length >= 11
        ? "event-card-fighter-lastname event-card-fighter-lastname-compact"
        : "event-card-fighter-lastname";
  const loserSuffix = isLoser ? " is-loser" : "";
  return (
    <div className={`event-card-fighter${blueSuffix}`}>
      <span
        className={`event-card-fighter-photo fighter-photo-${corner}`}
        aria-hidden={showImg ? undefined : "true"}
      >
        {showImg ? (
          <img
            className="fighter-photo-img"
            src={fighter.photoUrl}
            alt={fighter.name}
            onError={() => setImgFailed(true)}
          />
        ) : (
          initialsOf(fighter.name)
        )}
      </span>
      <span className={`event-card-fighter-names${blueSuffix}`}>
        <span className={`event-card-fighter-firstname${blueSuffix}${loserSuffix}`}>{first}</span>
        <span className={`${lastNameClass}${blueSuffix}${loserSuffix}`}>{last}</span>
      </span>
    </div>
  );
}

/**
 * Shared "red fighter vs blue fighter" card shell — the browse-events screen
 * (EventList) and every bout-list row (CardRail, ScheduledCardRail) all use
 * this same layout so a fight looks the same wherever it's shown. The only
 * thing that varies between them is what goes in the center column: "vs" on
 * the events screen, a live/upcoming/final status chip in bout lists.
 */
export function MatchupCard({
  header,
  red,
  blue,
  redIsLoser,
  blueIsLoser,
  center,
  isSelected,
  onSelect,
}: {
  header?: ReactNode;
  red: MatchupFighterEntry | undefined;
  blue: MatchupFighterEntry | undefined;
  redIsLoser?: boolean;
  blueIsLoser?: boolean;
  center: ReactNode;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`event-card${isSelected ? " is-selected" : ""}`}
      onClick={onSelect}
      aria-current={isSelected ? "true" : undefined}
    >
      {header && <div className="event-card-header">{header}</div>}
      <div className="event-card-matchup">
        <MatchupFighter fighter={red} corner="red" isLoser={redIsLoser} />
        {center}
        <MatchupFighter fighter={blue} corner="blue" isLoser={blueIsLoser} />
      </div>
    </button>
  );
}
