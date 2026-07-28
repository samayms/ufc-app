import type { CollectorValueDelivery } from "../store/collectorClient.ts";
import { fmtTime } from "./format.ts";

export function DeliveryFreshness({
  delivery,
}: {
  delivery: CollectorValueDelivery;
}) {
  return (
    <span className="freshness delivery-freshness">
      <span>{delivery.source}</span>
      {delivery.sourceUpdatedAt && (
        <span className="num">
          source {fmtTime(delivery.sourceUpdatedAt)}
        </span>
      )}
      <span className="num">
        received {fmtTime(delivery.receivedAt)}
      </span>
      <span
        className={
          delivery.provisional
            ? "delivery-state-provisional"
            : "delivery-state-final"
        }
      >
        {delivery.provisional ? "Provisional" : "Final"}
      </span>
      {delivery.revision !== undefined && (
        <span className="num">rev {delivery.revision}</span>
      )}
      {delivery.stale && (
        <span className="delivery-state-stale">Stale</span>
      )}
    </span>
  );
}
