import type { BoutView, ExpertConsensus } from "../schema.ts";
import type {
  CollectorSnapshot,
  CollectorUnifiedRound,
  CollectorValueDelivery,
} from "../store/collectorClient.ts";
import { DeliveryFreshness } from "./DeliveryFreshness.tsx";

function consensusLabel(
  consensus: ExpertConsensus | undefined,
  source: "sherdog",
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
  source: "sherdog",
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
  return undefined;
}

export function ScorecardFeed({
  view,
  records = [],
  round,
  collector,
}: {
  view: BoutView;
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
  const sherdogDelivery =
    record === undefined
      ? undefined
      : sourceDelivery(collector, record, "sherdog");
  const sherdogConsensus =
    record === undefined
      ? undefined
      : consensusLabel(record.expertConsensus, "sherdog");

  return (
    <section className="panel scorecard-panel" aria-label="Expert scorecards">
      <div className="panel-head expert-panel-head">
        <h2>Expert scores</h2>
      </div>

      {sherdog !== undefined ? (
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
      ) : (
        <p className="empty expert-empty">
          No Sherdog scorecard for this round.
        </p>
      )}
    </section>
  );
}
