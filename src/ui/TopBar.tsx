import type { ReactNode } from "react";

import type { UfcEvent } from "../schema.ts";
import { UfcWordmark } from "./UfcWordmark.tsx";
import "./newComponents.css";

const UFC_PREFIX = /^UFC\s+/i;

export function TopBar() {
  return (
    <header className="topbar" aria-label="UFC dashboard">
      <UfcWordmark className="topbar-wordmark" />
    </header>
  );
}

export function EventSubheader({
  event,
  leading,
}: {
  event: UfcEvent;
  /** Optional element (e.g. a back button) pinned to the left, above the header's bottom border. */
  leading?: ReactNode;
}) {
  const hasUfcPrefix = UFC_PREFIX.test(event.name);
  const displayName = hasUfcPrefix
    ? event.name.replace(UFC_PREFIX, "")
    : event.name;

  return (
    <div className={`event-subheader${leading ? " event-subheader-with-leading" : ""}`}>
      {leading && <div className="event-subheader-leading">{leading}</div>}
      <h1 title={event.name} aria-label={event.name}>
        {displayName}
      </h1>
    </div>
  );
}
