import type { EspnScheduledEventSummary } from "../sources/espnSchedule.ts";
import { fmtEventDate } from "./format.ts";

/** The app's own in-memory event, shown as the first, pre-selected entry. */
export interface UpcomingEventRailCurrentEntry {
  id: string;
  name: string;
  startsAt: string;
}

export function UpcomingEventRail({
  currentEvent,
  events,
  selectedId,
  onSelect,
}: {
  currentEvent: UpcomingEventRailCurrentEntry | null;
  events: EspnScheduledEventSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="rail" aria-label="Events">
      {currentEvent && (
        <section className="rail-segment">
          <h2 className="rail-heading">Current event</h2>
          <button
            className={`rail-bout${currentEvent.id === selectedId ? " is-selected" : ""}`}
            onClick={() => onSelect(currentEvent.id)}
            aria-current={currentEvent.id === selectedId ? "true" : undefined}
          >
            <span className="rail-names">
              <span className="rail-name">{currentEvent.name}</span>
            </span>
            <span className="rail-meta">{fmtEventDate(currentEvent.startsAt)}</span>
          </button>
        </section>
      )}
      {events.length > 0 && (
        <section className="rail-segment">
          <h2 className="rail-heading">Upcoming events</h2>
          {events.map((event) => (
            <button
              key={event.eventId}
              className={`rail-bout${event.eventId === selectedId ? " is-selected" : ""}`}
              onClick={() => onSelect(event.eventId)}
              aria-current={event.eventId === selectedId ? "true" : undefined}
            >
              <span className="rail-names">
                <span className="rail-name">{event.name}</span>
              </span>
              <span className="rail-meta">{fmtEventDate(event.startsAt)}</span>
            </button>
          ))}
        </section>
      )}
    </nav>
  );
}
