import type { UfcEvent } from "../schema/types.ts";
import { fmtTime } from "./format.ts";

export function TopBar({ event }: { event: UfcEvent }) {
  return (
    <header className="topbar">
      <div className="topbar-title">
        <span className="topbar-kicker">Live event</span>
        <h1>{event.name}</h1>
      </div>
      <div className="topbar-venue">
        {event.venue} · {event.city}
      </div>
      <div className="topbar-status">
        {event.provenance.synthetic && (
          <span className="badge badge-synthetic" title="Fixture mode — no live credentials configured">
            Synthetic data
          </span>
        )}
        <span className="freshness">
          as of <span className="num">{fmtTime(event.provenance.fetchedAt)}</span>
        </span>
      </div>
    </header>
  );
}
