import type { ReactNode } from "react";

import type { UfcEvent } from "../schema.ts";
import { UfcWordmark } from "./UfcWordmark.tsx";
import "./newComponents.css";

export function TopBar() {
  return (
    <header className="topbar" aria-label="UFC dashboard">
      <UfcWordmark className="topbar-wordmark" />
    </header>
  );
}

export function EventSubheader({
  event,
  eventName,
  hideTitle,
  leading,
}: {
  event: UfcEvent;
  /** Optional explicit title text (used when viewing a selected future-fight event). */
  eventName?: string;
  /** Keeps header height/back-button slot while hiding the title text. */
  hideTitle?: boolean;
  /** Optional element (e.g. a back button) pinned to the left, above the header's bottom border. */
  leading?: ReactNode;
}) {
  const rawName = eventName ?? event.name;

  return (
    <div className={`event-subheader${leading ? " event-subheader-with-leading" : ""}`}>
      {leading && <div className="event-subheader-leading">{leading}</div>}
      <h1
        className={hideTitle ? "event-subheader-title-hidden" : undefined}
        title={rawName}
        aria-label={rawName}
        aria-hidden={hideTitle ? "true" : undefined}
      >
        {rawName}
      </h1>
    </div>
  );
}
