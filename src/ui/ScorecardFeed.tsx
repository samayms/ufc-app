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
  const featured = accounts.filter((account) => account.active).slice(0, 4);

  return (
    <section className="panel scorecard-panel" aria-label="Media scorecards">
      <div className="panel-head">
        <h2>Media scorecards</h2>
        <span className="freshness num">{featured.length} voices</span>
      </div>
      <ul className="media-scorecard-grid">
        {featured.map((account) => {
          const card = view.scorecards.find(
            (scorecard) => scorecard.handle === account.handle,
          );

          return (
            <li
              key={account.handle}
              className="media-scorecard"
              title={`@${account.handle}`}
            >
              <strong>{account.displayName}</strong>
              <span className="num">
                {card
                  ? `${card.round ? `R${card.round} · ` : ""}posted`
                  : "Awaiting"}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
