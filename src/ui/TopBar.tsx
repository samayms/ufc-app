import type { UfcEvent } from "../schema/types.ts";
import { fmtTime } from "./format.ts";
import { UfcWordmark } from "./UfcWordmark.tsx";

const UFC_PREFIX = /^UFC\s+/i;

export function TopBar({
  event,
  stale = false,
}: {
  event: UfcEvent;
  stale?: boolean;
}) {
  const hasUfcPrefix = UFC_PREFIX.test(event.name);
  const displayName = hasUfcPrefix
    ? event.name.replace(UFC_PREFIX, "")
    : event.name;

  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1 title={event.name} aria-label={event.name}>
          {hasUfcPrefix && <UfcWordmark className="topbar-wordmark" />}
          {displayName}
        </h1>
        {event.provenance.synthetic && (
          <span
            className="fixture-label"
            title="Fixture mode — no live credentials configured"
          >
            Fixture data
          </span>
        )}
      </div>
      <div className="topbar-status">
        <span
          className={`sync-dot${stale ? " is-stale" : ""}`}
          aria-hidden="true"
        />
        <span className="freshness">
          {stale ? "stale" : "synced"}{" "}
          <span className="num">{fmtTime(event.provenance.fetchedAt)}</span>
        </span>
      </div>
    </header>
  );
}
