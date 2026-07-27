import type { BoutView, ScorecardAccount } from "../schema/types.ts";

/**
 * Journalist scorecards arrive as X posts and render through the official
 * embed widget in live mode. Fixture mode has no posts, so this shows the
 * roster and an honest empty state instead of fake tweets.
 */
export function ScorecardFeed({
  view,
  accounts,
}: {
  view: BoutView;
  accounts: ScorecardAccount[];
}) {
  const active = accounts.filter((a) => a.active);
  return (
    <section className="panel" aria-label="Media scorecards">
      <div className="panel-head">
        <h2>Media scorecards</h2>
      </div>
      <ul className="scorecard-accounts">
        {active.map((a) => (
          <li key={a.handle} className="chip chip-handle" title={a.displayName}>
            @{a.handle}
          </li>
        ))}
      </ul>
      {view.scorecards.length === 0 && (
        <p className="empty">
          Live X embeds appear here during an event. Nothing to show in fixture
          mode — no posts are invented.
        </p>
      )}
    </section>
  );
}
