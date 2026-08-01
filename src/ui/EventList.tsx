import { MatchupCard, type MatchupFighterEntry } from "./MatchupCard.tsx";
import "./newComponents.css";
import { fmtEventDate } from "./format.ts";

/** Source-agnostic shape for one event row — callers adapt real data (ESPN, etc.) into this. */
export interface EventListEntry {
  id: string;
  name: string;
  startsAt: string;
  isLive?: boolean;
  isComplete?: boolean;
  redFighter?: MatchupFighterEntry;
  blueFighter?: MatchupFighterEntry;
}

function eventTime(entry: EventListEntry): number {
  const parsed = Date.parse(entry.startsAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Upcoming cards read forward; completed cards read backward from most recent. */
export function groupEventListEntries(events: readonly EventListEntry[]) {
  return {
    upcoming: events
      .filter((entry) => !entry.isComplete)
      .sort((left, right) => eventTime(left) - eventTime(right)),
    past: events
      .filter((entry) => entry.isComplete)
      .sort((left, right) => eventTime(right) - eventTime(left)),
  };
}

/**
 * Top-level "browse events" screen: a richer, card-style replacement for
 * the old thin UpcomingEventRail rows. Keeps the same sectioned
 * (current / upcoming / past) layout and .rail/.rail-segment/.rail-heading
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
  const grouped = groupEventListEntries(events);

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
      {grouped.upcoming.length > 0 && (
        <section className="rail-segment">
          <h2 className="rail-heading">Upcoming events</h2>
          {grouped.upcoming.map((entry) => (
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
      {grouped.past.length > 0 && (
        <section className="rail-segment">
          <h2 className="rail-heading">Past events</h2>
          {grouped.past.map((entry) => (
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
              onSelect={() => onSelect(entry.id)}
            />
          ))}
        </section>
      )}
    </nav>
  );
}
