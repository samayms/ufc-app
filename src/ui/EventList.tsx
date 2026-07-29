import { MatchupCard, type MatchupFighterEntry } from "./MatchupCard.tsx";
import "./newComponents.css";
import { fmtEventDate } from "./format.ts";

/** Source-agnostic shape for one event row — callers adapt real data (ESPN, etc.) into this. */
export interface EventListEntry {
  id: string;
  name: string;
  startsAt: string;
  isLive?: boolean;
  redFighter?: MatchupFighterEntry;
  blueFighter?: MatchupFighterEntry;
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
          <MatchupCard
            header={
              <>
                <span className="event-card-name">{currentEvent.name}</span>
                <span className="event-card-date num">{fmtEventDate(currentEvent.startsAt)}</span>
              </>
            }
            red={currentEvent.redFighter}
            blue={currentEvent.blueFighter}
            center={<span className="event-card-vs">vs</span>}
            isSelected={currentEvent.id === selectedId}
            isLive={currentEvent.isLive}
            onSelect={() => onSelect(currentEvent.id)}
          />
        </section>
      )}
      {events.length > 0 && (
        <section className="rail-segment">
          <h2 className="rail-heading">Upcoming events</h2>
          {events.map((entry) => (
            <MatchupCard
              key={entry.id}
              header={
                <>
                  <span className="event-card-name">{entry.name}</span>
                  <span className="event-card-date num">{fmtEventDate(entry.startsAt)}</span>
                </>
              }
              red={entry.redFighter}
              blue={entry.blueFighter}
              center={<span className="event-card-vs">vs</span>}
              isSelected={entry.id === selectedId}
              isLive={entry.isLive}
              onSelect={() => onSelect(entry.id)}
            />
          ))}
        </section>
      )}
    </nav>
  );
}
