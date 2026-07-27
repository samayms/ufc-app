import type { UfcEvent } from "../schema/types.ts";
import { UfcWordmark } from "./UfcWordmark.tsx";

const UFC_PREFIX = /^UFC\s+/i;

export function TopBar() {
  return (
    <header className="topbar" aria-label="UFC dashboard">
      <UfcWordmark className="topbar-wordmark" />
    </header>
  );
}

export function EventSubheader({ event }: { event: UfcEvent }) {
  const hasUfcPrefix = UFC_PREFIX.test(event.name);
  const displayName = hasUfcPrefix
    ? event.name.replace(UFC_PREFIX, "")
    : event.name;

  return (
    <div className="event-subheader">
      <h1 title={event.name} aria-label={event.name}>
        {displayName}
      </h1>
    </div>
  );
}
