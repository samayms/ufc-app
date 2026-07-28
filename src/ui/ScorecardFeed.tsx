import { useEffect, useState, type ReactNode } from "react";
import type {
  BoutView,
  ExpertConsensus,
  ScorecardAccount,
} from "../schema.ts";
import type {
  CollectorSnapshot,
  CollectorUnifiedRound,
  CollectorValueDelivery,
} from "../store/collectorClient.ts";
import { DeliveryFreshness } from "./DeliveryFreshness.tsx";
import {
  ensureXWidgetsScript,
  subscribeXWidgetsState,
  type XWidgetsState,
} from "./xWidgetsScript.ts";

/**
 * One official X embed: a blockquote link that's fully readable on its own,
 * progressively enhanced into the rich embed once (and only once, however
 * many of these mount) the widgets script loads. If that script fails, the
 * plain link stays and we say so instead of leaving a silent dead widget.
 */
function XEmbedBlockquote({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const [widgetsState, setWidgetsState] = useState<XWidgetsState>("idle");

  useEffect(() => {
    ensureXWidgetsScript();
    return subscribeXWidgetsState(setWidgetsState);
  }, []);

  return (
    <>
      <blockquote className="twitter-tweet official-x-embed" data-dnt="true">
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      </blockquote>
      {widgetsState === "error" && (
        <span className="x-embed-fallback-note">
          Live preview unavailable — the link above opens the post on X.
        </span>
      )}
    </>
  );
}

function consensusLabel(
  consensus: ExpertConsensus | undefined,
  source: "sherdog" | "x",
): string | undefined {
  const value = consensus?.[source];
  if (value === undefined) return undefined;
  const leader =
    value.leader === "red"
      ? "red corner"
      : value.leader === "blue"
        ? "blue corner"
        : value.leader === "draw"
          ? "draw"
          : "split";
  return `${leader} · ${value.redVotes}–${value.blueVotes}${
    value.drawVotes > 0 ? `–${value.drawVotes}` : ""
  }`;
}

function sourceDelivery(
  snapshot: CollectorSnapshot | undefined,
  record: CollectorUnifiedRound,
  source: "sherdog" | "x",
): CollectorValueDelivery | undefined {
  if (source === "sherdog" && record.sherdog !== undefined) {
    return {
      source: "Sherdog",
      ...(record.sherdog.publishedAt === undefined
        ? {}
        : { sourceUpdatedAt: record.sherdog.publishedAt }),
      receivedAt: record.sherdog.fetchedAt,
      stale:
        snapshot?.connection !== "connected" ||
        snapshot.health.sherdog?.fresh === false,
      provisional: record.provisional,
    };
  }
  const latest = record.xScores
    ?.map((score) => score.fetchedAt)
    .sort()
    .at(-1);
  if (source === "x" && latest !== undefined) {
    return {
      source: "X",
      sourceUpdatedAt: latest,
      receivedAt: latest,
      stale:
        snapshot?.connection !== "connected" ||
        snapshot.health["x-embed"]?.fresh === false ||
        snapshot.health.x?.fresh === false,
      provisional: record.provisional,
    };
  }
  return undefined;
}

export function ScorecardFeed({
  view,
  accounts,
  records = [],
  round,
  collector,
}: {
  view: BoutView;
  accounts: ScorecardAccount[];
  records?: readonly CollectorUnifiedRound[];
  round?: number;
  collector?: CollectorSnapshot;
}) {
  const record = records
    .filter(
      (candidate) =>
        candidate.boutId === view.bout.id &&
        (round === undefined || candidate.round === round),
    )
    .sort((left, right) => right.round - left.round)[0];
  const sherdog = record?.sherdog;
  const xScores = record?.xScores ?? [];
  const embeddedPosts = view.scorecards.filter(
    (post) => round === undefined || post.round === round,
  );
  const activeAccounts = new Map(
    accounts
      .filter((account) => account.active)
      .map((account) => [
        account.handle.toLocaleLowerCase("en"),
        account.displayName,
      ]),
  );
  const sherdogDelivery =
    record === undefined
      ? undefined
      : sourceDelivery(collector, record, "sherdog");
  const collectorXDelivery =
    record === undefined
      ? undefined
      : sourceDelivery(collector, record, "x");
  const latestEmbed = embeddedPosts
    .map((post) => post.provenance.fetchedAt)
    .sort()
    .at(-1);
  const xDelivery: CollectorValueDelivery | undefined =
    collectorXDelivery ??
    (latestEmbed === undefined
      ? undefined
      : {
          source: "X official embed",
          sourceUpdatedAt: latestEmbed,
          receivedAt: latestEmbed,
          stale: collector?.connection === "reconnecting",
          provisional: false,
        });
  const sherdogConsensus =
    record === undefined
      ? undefined
      : consensusLabel(record.expertConsensus, "sherdog");
  const xConsensus =
    record === undefined
      ? undefined
      : consensusLabel(record.expertConsensus, "x");

  return (
    <section className="panel scorecard-panel" aria-label="Expert scorecards">
      <div className="panel-head expert-panel-head">
        <h2>Expert scores</h2>
        <span className="freshness">
          Sherdog and X stay separate
        </span>
      </div>

      {sherdog !== undefined && (
        <div className="expert-source-group">
          <div className="expert-source-head">
            <div>
              <strong>Sherdog</strong>
              {sherdogConsensus && (
                <span className="expert-consensus num">
                  Consensus {sherdogConsensus}
                </span>
              )}
            </div>
            {sherdogDelivery && (
              <DeliveryFreshness delivery={sherdogDelivery} />
            )}
          </div>
          {sherdog.commentary && (
            <p className="expert-commentary">{sherdog.commentary}</p>
          )}
          {sherdog.scorerCards.length > 0 && (
            <ul className="media-scorecard-grid">
              {sherdog.scorerCards.map((card, index) => (
                <li
                  className="media-scorecard"
                  key={`${card.scorer}:${index}`}
                >
                  <span className="media-scorecard-id">
                    <strong className="media-scorecard-name">
                      {card.scorer}
                    </strong>
                    <span className="media-scorecard-handle">
                      Round {sherdog.round} · Sherdog
                    </span>
                  </span>
                  <span className="media-scorecard-score">
                    <b className="num">{card.roundScore ?? "Scored"}</b>
                    {card.winner && <span>{card.winner}</span>}
                    {card.cumulativeScore && (
                      <span className="media-scorecard-total num">
                        ({card.cumulativeScore})
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="expert-source-group">
        <div className="expert-source-head">
          <div>
            <strong>X scorecards</strong>
            {xConsensus && (
              <span className="expert-consensus num">
                Consensus {xConsensus}
              </span>
            )}
          </div>
          {xDelivery && <DeliveryFreshness delivery={xDelivery} />}
        </div>
        {xScores.length === 0 && embeddedPosts.length === 0 ? (
          <p className="empty expert-empty">
            No configured X scorecard posts for this round.
          </p>
        ) : (
          <ul className="media-scorecard-grid">
            {embeddedPosts.map((post) => (
              <li
                className="media-scorecard"
                key={`x-embed:${post.postId}`}
              >
                <XEmbedBlockquote
                  href={`https://x.com/${post.handle}/status/${post.postId}`}
                >
                  <span className="media-scorecard-id">
                    <strong className="media-scorecard-name">
                      {activeAccounts.get(
                        post.handle.toLocaleLowerCase("en"),
                      ) ?? `@${post.handle}`}
                    </strong>
                    <span className="media-scorecard-handle">
                      Official X embed
                      {post.round === undefined
                        ? ""
                        : ` · round ${post.round}`}
                    </span>
                  </span>
                  <span className="media-scorecard-score">
                    <b>View post</b>
                  </span>
                </XEmbedBlockquote>
              </li>
            ))}
            {xScores.map((score) => {
              const handle = score.scorer.replace(/^@/, "");
              const displayName =
                activeAccounts.get(handle.toLocaleLowerCase("en")) ??
                score.scorer;
              const scoreText = `${score.score.red}–${score.score.blue}`;
              const winner =
                score.score.red > score.score.blue
                  ? view.bout.fighters.red.name
                  : score.score.blue > score.score.red
                    ? view.bout.fighters.blue.name
                    : "Even";
              const content = (
                <>
                  <span className="media-scorecard-id">
                    <strong className="media-scorecard-name">
                      {displayName}
                    </strong>
                    <span className="media-scorecard-handle">
                      {score.mode} · confidence{" "}
                      <span className="num">
                        {Math.round(score.parseConfidence * 100)}%
                      </span>
                    </span>
                  </span>
                  <span className="media-scorecard-score">
                    <b className="num">{scoreText}</b>
                    <span>{winner.split(" ").at(-1)}</span>
                  </span>
                </>
              );

              return (
                <li
                  className="media-scorecard"
                  key={`${score.source}:${score.sourcePostId}`}
                >
                  {score.mode === "embed" ? (
                    <XEmbedBlockquote href={score.postUrl}>
                      {content}
                    </XEmbedBlockquote>
                  ) : (
                    <a
                      className="expert-score-link"
                      href={score.postUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {content}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
