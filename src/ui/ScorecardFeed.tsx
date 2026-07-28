import type { BoutView, Corner, ScorecardAccount } from "../schema.ts";
import { completedRounds } from "./RoundSelector.tsx";

/** Each demo journalist's round-by-round pick, oldest round first. */
const DEMO_CARDS: { rounds: Corner[] }[] = [
  { rounds: ["blue", "blue"] },
  { rounds: ["red", "blue"] },
  { rounds: ["blue", "red"] },
  { rounds: ["blue", "blue"] },
];

/**
 * Journalist scorecards arrive as X posts and render through the official
 * embed widget in live mode. Until live posts are connected, fixture mode
 * renders four demo cards to exercise the final layout.
 */
export function ScorecardFeed({
  view,
  accounts,
}: {
  view: BoutView;
  accounts: ScorecardAccount[];
}) {
  const featured = accounts.filter((account) => account.active).slice(0, 4);
  const roundsSoFar = completedRounds(view).length || 1;

  return (
    <section className="panel scorecard-panel" aria-label="Media scorecards">
      <ul className="media-scorecard-grid">
        {featured.map((account, index) => {
          const demo = DEMO_CARDS[index];
          if (!demo) return null;
          let red = 0;
          let blue = 0;
          for (let round = 0; round < roundsSoFar; round += 1) {
            const pick = demo.rounds[round] ?? demo.rounds.at(-1);
            if (pick === "red") {
              red += 10;
              blue += 9;
            } else {
              red += 9;
              blue += 10;
            }
          }
          const corner = demo.rounds[roundsSoFar - 1] ?? demo.rounds.at(-1) ?? "red";
          const favored = view.bout.fighters[corner].name.split(" ").at(-1);
          const initials = account.displayName
            .split(/\s+/)
            .map((part) => part[0])
            .join("")
            .slice(0, 2)
            .toUpperCase();

          return (
            <li key={account.handle} className="media-scorecard">
              <span className="media-scorecard-avatar" aria-hidden="true">
                {initials}
              </span>
              <span className="media-scorecard-id">
                <strong className="media-scorecard-name">
                  {account.displayName}
                </strong>
                <span className="media-scorecard-handle">
                  @{account.handle}
                </span>
              </span>
              <span className={`media-scorecard-score corner-${corner}`}>
                <b className="num">10–9</b>
                <span>{favored}</span>
                <span className="media-scorecard-total num">
                  ({red}–{blue})
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
