import type { BoutView, ScorecardAccount } from "../schema/types.ts";

const DEMO_CARDS = [
  { corner: "blue" as const, note: "Cleaner counters" },
  { corner: "blue" as const, note: "Control and pressure" },
  { corner: "red" as const, note: "Sharper late work" },
  { corner: "blue" as const, note: "Edged the exchanges" },
];

/**
 * Journalist scorecards arrive as X posts and render through the official
 * embed widget in live mode. Until live posts are connected, fixture mode
 * renders four explicitly labeled demo cards to exercise the final layout.
 */
export function ScorecardFeed({
  view,
  accounts,
}: {
  view: BoutView;
  accounts: ScorecardAccount[];
}) {
  const featured = accounts.filter((account) => account.active).slice(0, 4);
  const latestRound =
    Object.values(view.rounds)
      .flat()
      .map((round) => round.round)
      .sort((a, b) => b - a)[0] ??
    view.bout.currentRound ??
    1;

  return (
    <section className="panel scorecard-panel" aria-label="Media scorecards">
      <div className="panel-head">
        <h2>Media scorecards</h2>
        <span className="badge-synthetic">Demo cards</span>
      </div>
      <ul className="media-scorecard-grid">
        {featured.map((account, index) => {
          const demo = DEMO_CARDS[index];
          if (!demo) return null;
          const favored = view.bout.fighters[demo.corner].name.split(" ").at(-1);

          return (
            <li
              key={account.handle}
              className="media-scorecard"
              title={`@${account.handle}`}
            >
              <strong className="media-scorecard-name">
                {account.displayName}
              </strong>
              <span className={`media-scorecard-score corner-${demo.corner}`}>
                <b className="num">10–9</b> {favored}
              </span>
              <span className="media-scorecard-note">
                <b className="num">R{latestRound}</b> · {demo.note}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
