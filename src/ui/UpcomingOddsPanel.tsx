import type { OddsSnapshot } from "../schema.ts";
import { averageImpliedProbability } from "../lib/oddsMath.ts";
import {
  upcomingProviderDisplayStatus,
  type UpcomingBoutOdds,
  type UpcomingProviderDisplayStatus,
  type UpcomingProviderEntry,
  type UpcomingProviderId,
} from "../lib/upcomingOdds.ts";
import { UPCOMING_PROVIDER_LABEL } from "../sources/upcoming/types.ts";
import { fmtNative, fmtPct, fmtTime } from "./format.ts";

/**
 * Each of the four providers gets its own block with its own state, rather
 * than the live tab's three merged market kinds. Odds-API.io and The Odds API
 * both publish sportsbook lines, but they are separate accounts on separate
 * quotas that fail independently — collapsing them would hide which one is
 * actually answering.
 */
const PROVIDER_ORDER: readonly UpcomingProviderId[] = [
  "kalshi",
  "polymarket",
  "odds-api-io",
  "odds-api",
];

const PROVIDER_ACCENT: Record<
  UpcomingProviderId,
  "kalshi" | "polymarket" | "sportsbook"
> = {
  kalshi: "kalshi",
  polymarket: "polymarket",
  "odds-api-io": "sportsbook",
  "odds-api": "sportsbook",
};

const STATUS_LABEL: Record<UpcomingProviderDisplayStatus, string> = {
  loaded: "Live",
  stale: "Stale",
  not_listed: "Not listed",
  unmatched: "Unmatched",
  provider_error: "Provider error",
};

/**
 * The one-line explanation under a block that has no usable price. These are
 * deliberately different sentences: "no market exists" and "we refused to
 * guess which market this is" are different facts about the same blank space.
 */
const STATUS_DETAIL: Record<UpcomingProviderDisplayStatus, string | null> = {
  loaded: null,
  stale: null,
  not_listed: "This provider does not list this fight.",
  unmatched:
    "A market may exist, but it could not be matched to this bout with confidence.",
  provider_error: "The provider could not be reached on the last sync.",
};

function SplitBar({
  red,
  blue,
  redName,
  blueName,
}: {
  red: number | null;
  blue: number | null;
  redName: string;
  blueName: string;
}) {
  const hasData = red != null && blue != null;
  const total = (red ?? 0) + (blue ?? 0);
  const redShare = hasData && total > 0 ? ((red as number) / total) * 100 : 50;
  const label = hasData
    ? `${redName} ${fmtPct(red as number)}, ${blueName} ${fmtPct(blue as number)}`
    : `${redName} vs ${blueName}, odds unavailable`;
  return (
    <div className="split" role="img" aria-label={label}>
      <span
        className={hasData ? "split-red" : "split-neutral"}
        style={{ width: `calc(${redShare}% - 1px)` }}
      />
      <span
        className={hasData ? "split-blue" : "split-neutral"}
        style={{ width: `calc(${100 - redShare}% - 1px)` }}
      />
    </div>
  );
}

function ProviderBar({
  snapshot,
  redName,
  blueName,
}: {
  snapshot: OddsSnapshot | null;
  redName: string;
  blueName: string;
}) {
  const red = snapshot ? averageImpliedProbability(snapshot, "red") : null;
  const blue = snapshot ? averageImpliedProbability(snapshot, "blue") : null;
  const singleBook = snapshot ? snapshot.market !== "sportsbook" : false;
  const redQuote = snapshot?.quotes.find((quote) => quote.corner === "red");
  const blueQuote = snapshot?.quotes.find((quote) => quote.corner === "blue");

  return (
    <div className="market-bar">
      <span className="market-side">
        <span className="market-pct num">{red == null ? "—" : fmtPct(red)}</span>
        <span className="market-name">{redName}</span>
        {singleBook && redQuote && (
          <span className="market-native num">{fmtNative(redQuote.native)}</span>
        )}
      </span>
      <SplitBar red={red} blue={blue} redName={redName} blueName={blueName} />
      <span className="market-side market-side-blue">
        <span className="market-pct num">{blue == null ? "—" : fmtPct(blue)}</span>
        <span className="market-name">{blueName}</span>
        {singleBook && blueQuote && (
          <span className="market-native num">
            {fmtNative(blueQuote.native)}
          </span>
        )}
      </span>
    </div>
  );
}

export function UpcomingMarketBlock({
  provider,
  entry,
  redName,
  blueName,
  nowMs,
}: {
  provider: UpcomingProviderId;
  entry: UpcomingProviderEntry | undefined;
  redName: string;
  blueName: string;
  nowMs: number;
}) {
  const status = upcomingProviderDisplayStatus(entry, nowMs);
  const showsPrice = status === "loaded" || status === "stale";
  const snapshot = showsPrice ? (entry?.snapshot ?? null) : null;
  const observedAt = entry?.updatedAt ?? entry?.fetchedAt;
  const detail = STATUS_DETAIL[status];

  return (
    <section
      className="market"
      data-market-accent={PROVIDER_ACCENT[provider]}
      data-upcoming-status={status}
      aria-label={`${UPCOMING_PROVIDER_LABEL[provider]} odds`}
    >
      <div className="market-head">
        <h3>{UPCOMING_PROVIDER_LABEL[provider]}</h3>
        <span className="upcoming-status" data-status={status}>
          {STATUS_LABEL[status]}
        </span>
      </div>
      <ProviderBar snapshot={snapshot} redName={redName} blueName={blueName} />
      <div className="market-head upcoming-foot">
        <span className="freshness">
          {observedAt === undefined ? (
            "never updated"
          ) : (
            <>
              updated <span className="num">{fmtTime(observedAt)}</span>
            </>
          )}
        </span>
        {entry?.preserved === true && (
          <span className="freshness">last known price retained</span>
        )}
      </div>
      {detail !== null && <p className="upcoming-detail">{detail}</p>}
    </section>
  );
}

/**
 * The Odds tab for a fight that has not started.
 *
 * `bout` being undefined means the sync produced nothing for this bout —
 * either it has never run, or this card was not in its window. That is shown
 * as an explicit notice rather than four silently empty blocks, and no
 * fixture price is ever substituted: a number on this screen is always a real
 * one that a provider actually published.
 */
export function UpcomingOddsPanel({
  bout,
  redName,
  blueName,
  syncedAt,
  notice,
  nowMs = Date.now(),
}: {
  bout: UpcomingBoutOdds | undefined;
  redName: string;
  blueName: string;
  syncedAt?: string;
  notice?: string;
  nowMs?: number;
}) {
  return (
    <section className="panel" aria-label="Odds comparison">
      <div className="panel-head">
        <h2>Markets</h2>
        {syncedAt !== undefined && (
          <span className="freshness">
            synced <span className="num">{fmtTime(syncedAt)}</span>
          </span>
        )}
      </div>
      {notice !== undefined && (
        <div className="state-notice" role="status">
          <strong>Upcoming odds unavailable</strong>
          <span>{notice}</span>
        </div>
      )}
      {PROVIDER_ORDER.map((provider) => (
        <UpcomingMarketBlock
          key={provider}
          provider={provider}
          entry={bout?.providers[provider]}
          redName={redName}
          blueName={blueName}
          nowMs={nowMs}
        />
      ))}
    </section>
  );
}
