import { useState } from "react";
import "./newComponents.css";
import { fmtEventDate } from "./format.ts";

/** Source-agnostic shape for one event row — callers adapt real data (ESPN, etc.) into this. */
export interface EventListEntry {
  id: string;
  name: string;
  startsAt: string;
  redFighter?: { name: string; photoUrl?: string };
  blueFighter?: { name: string; photoUrl?: string };
}

/** Two-letter initials from a full name, matching BoutHeader.tsx's FighterBlock convention. */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2);
}

function EventCardFighter({
  fighter,
  corner,
}: {
  fighter: { name: string; photoUrl?: string } | undefined;
  corner: "red" | "blue";
}) {
  const [imgFailed, setImgFailed] = useState(false);
  if (!fighter) {
    return <div className={`event-card-fighter${corner === "blue" ? " is-blue" : ""}`} />;
  }
  const showImg = fighter.photoUrl && !imgFailed;
  return (
    <div className={`event-card-fighter${corner === "blue" ? " is-blue" : ""}`}>
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
      <span className="event-card-fighter-name">{fighter.name.split(" ").at(-1)}</span>
    </div>
  );
}

function EventCard({
  entry,
  isSelected,
  onSelect,
}: {
  entry: EventListEntry;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className={`event-card${isSelected ? " is-selected" : ""}`}
      onClick={() => onSelect(entry.id)}
      aria-current={isSelected ? "true" : undefined}
    >
      <div className="event-card-matchup">
        <EventCardFighter fighter={entry.redFighter} corner="red" />
        <span className="event-card-vs">vs</span>
        <EventCardFighter fighter={entry.blueFighter} corner="blue" />
      </div>
      <div className="event-card-meta">
        <span className="event-card-name">{entry.name}</span>
        <span className="event-card-date num">{fmtEventDate(entry.startsAt)}</span>
      </div>
    </button>
  );
}

/**
 * Top-level "browse events" screen: a richer, card-style replacement for
 * the old thin UpcomingEventRail rows. Keeps the same two-section
 * (current / upcoming) layout and .rail/.rail-segment/.rail-heading
 * structure, but each row is a bigger card with both main-event fighters'
 * photos, the event name, and its date.
 */
export function EventList({
  currentEvent,
  events,
  selectedId,
  onSelect,
}: {
  currentEvent: EventListEntry | null;
  events: EventListEntry[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="rail" aria-label="Events">
      {currentEvent && (
        <section className="rail-segment">
          <h2 className="rail-heading">Current event</h2>
          <EventCard
            entry={currentEvent}
            isSelected={currentEvent.id === selectedId}
            onSelect={onSelect}
          />
        </section>
      )}
      {events.length > 0 && (
        <section className="rail-segment">
          <h2 className="rail-heading">Upcoming events</h2>
          {events.map((entry) => (
            <EventCard
              key={entry.id}
              entry={entry}
              isSelected={entry.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </section>
      )}
    </nav>
  );
}
