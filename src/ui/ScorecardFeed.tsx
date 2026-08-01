import { useEffect, useState } from "react";
import type { BoutView, SherdogScorerCard, SherdogScorerProfile } from "../schema.ts";
import defaultScorerAvatar from "../assets/sherdog-default-avatar.svg";
import {
  collectorBaseUrl,
  type CollectorUnifiedRound,
} from "../store/collectorClient.ts";

function normalizeScorerNameForLookup(name: string): string {
  return name.toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

/**
 * Fetches the collector's cached Sherdog scorer-profile photos once per
 * mount. Best-effort: an empty map just means every scorer renders with no
 * avatar yet (or the default one), never a loading error state — this is
 * decorative, not load-bearing.
 */
function useSherdogScorerProfiles(): Map<string, SherdogScorerProfile> {
  const [profiles, setProfiles] = useState<Map<string, SherdogScorerProfile>>(
    () => new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    fetch(`${collectorBaseUrl()}/api/sherdog-scorer-profiles`)
      .then((response) => (response.ok ? response.json() : []))
      .then((records: SherdogScorerProfile[]) => {
        if (cancelled) return;
        setProfiles(
          new Map(records.map((profile) => [profile.normalizedName, profile])),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return profiles;
}

function ScorerAvatar({
  scorer,
  profiles,
}: {
  scorer: string;
  profiles: Map<string, SherdogScorerProfile>;
}) {
  const profile = profiles.get(normalizeScorerNameForLookup(scorer));
  const profilePhoto =
    profile === undefined
      ? defaultScorerAvatar
      : profile.resolved
        ? `${collectorBaseUrl()}${profile.photoUrl}`
        : defaultScorerAvatar;
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <img
      className="media-scorecard-avatar"
      src={imageFailed ? defaultScorerAvatar : profilePhoto}
      alt=""
      width={32}
      height={32}
      loading="lazy"
      onError={() => setImageFailed(true)}
    />
  );
}

function hasScore(card: SherdogScorerCard): boolean {
  return [card.roundScore, card.cumulativeScore].some(
    (score) => typeof score === "string" && score.trim().length > 0,
  );
}

export function ScorecardFeed({
  view,
  records = [],
  round,
}: {
  view: BoutView;
  records?: readonly CollectorUnifiedRound[];
  round?: number;
}) {
  const scorerProfiles = useSherdogScorerProfiles();
  const record = records
    .filter(
      (candidate) =>
        candidate.boutId === view.bout.id &&
        (round === undefined || candidate.round === round),
    )
    .sort((left, right) => right.round - left.round)[0];
  const sherdog = record?.sherdog;
  const scoredCards = sherdog?.scorerCards.filter(hasScore) ?? [];

  if (sherdog === undefined || scoredCards.length === 0) return null;

  return (
    <section
      className="panel scorecard-panel"
      aria-label={`Sherdog round ${sherdog.round} scorecards`}
    >
      <ul className="media-scorecard-grid">
        {scoredCards.map((card, index) => (
          <li className="media-scorecard" key={`${card.scorer}:${index}`}>
            <ScorerAvatar scorer={card.scorer} profiles={scorerProfiles} />
            <span className="media-scorecard-id">
              <strong className="media-scorecard-name">{card.scorer}</strong>
              <span className="media-scorecard-handle">
                Round {sherdog.round}
              </span>
            </span>
            <span className="media-scorecard-score">
              <b className="num">{card.roundScore}</b>
              {card.winner && (
                <span className="media-scorecard-winner">{card.winner}</span>
              )}
              {card.cumulativeScore && (
                <span className="media-scorecard-total num">
                  {card.cumulativeScore}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
