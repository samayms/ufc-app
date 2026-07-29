import type { OddsQuote, OddsSnapshot } from "../schema.ts";
import { averageImpliedProbability, marketProbabilities } from "../lib/oddsMath.ts";
import {
  upcomingProviderDisplayStatus,
  type UpcomingBoutOdds,
  type UpcomingProviderEntry,
  type UpcomingProviderId,
} from "../lib/upcomingOdds.ts";
import { UPCOMING_PROVIDER_LABEL } from "../sources/upcoming/types.ts";
import { fmtNative, fmtPct } from "./format.ts";

/**
 * Kalshi and Polymarket remain independent blocks. The two sportsbook sources
 * are combined into one visible market, while each source still retains its
 * own state calculation below.
 */
const PROVIDER_ORDER = [
  "kalshi",
  "polymarket",
  "sportsbooks",
] as const;

type DisplayProvider = (typeof PROVIDER_ORDER)[number];

const PROVIDER_ACCENT: Record<
  DisplayProvider,
  "kalshi" | "polymarket" | "sportsbook"
> = {
  kalshi: "kalshi",
  polymarket: "polymarket",
  sportsbooks: "sportsbook",
};

const SPORTSBOOK_PROVIDERS: readonly UpcomingProviderId[] = [
  "odds-api-io",
  "odds-api",
];

function bestSportsbookQuote(
  entries: readonly (UpcomingProviderEntry | undefined)[],
  corner: "red" | "blue",
) {
  return entries
    .flatMap((source) =>
      source?.snapshot?.provenance.synthetic === false
        ? source.snapshot.quotes
        : [],
    )
    .filter(
      (quote) =>
        quote.corner === corner && quote.native.kind === "american-moneyline",
    )
    .reduce<OddsQuote | undefined>(
      (best, quote) =>
        best === undefined ||
        quote.impliedProbability < best.impliedProbability
          ? quote
          : best,
      undefined,
    );
}

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
  sportsbookQuotes,
  redName,
  blueName,
}: {
  snapshot: OddsSnapshot | null;
  sportsbookQuotes?: {
    red: OddsSnapshot["quotes"][number] | undefined;
    blue: OddsSnapshot["quotes"][number] | undefined;
  };
  redName: string;
  blueName: string;
}) {
  const red = sportsbookQuotes?.red?.impliedProbability ??
    (snapshot ? averageImpliedProbability(snapshot, "red") : null);
  const blue = sportsbookQuotes?.blue?.impliedProbability ??
    (snapshot ? averageImpliedProbability(snapshot, "blue") : null);
  const redQuote = sportsbookQuotes?.red;
  const blueQuote = sportsbookQuotes?.blue;
  const redMoneyline = redQuote?.native.kind === "american-moneyline"
    ? fmtNative(redQuote.native)
    : "—";
  const blueMoneyline = blueQuote?.native.kind === "american-moneyline"
    ? fmtNative(blueQuote.native)
    : "—";

  return (
    <div className="market-bar">
      <span className="market-side">
        {sportsbookQuotes ? (
          <>
            <span className="market-moneyline num">{redMoneyline}</span>
            <span className="market-moneyline-pct num">
              {redQuote == null ? "—" : fmtPct(redQuote.impliedProbability)}
            </span>
          </>
        ) : (
          <span className="market-pct num">{red == null ? "—" : fmtPct(red)}</span>
        )}
      </span>
      <SplitBar red={red} blue={blue} redName={redName} blueName={blueName} />
      <span className="market-side market-side-blue">
        {sportsbookQuotes ? (
          <>
            <span className="market-moneyline num">{blueMoneyline}</span>
            <span className="market-moneyline-pct num">
              {blueQuote == null ? "—" : fmtPct(blueQuote.impliedProbability)}
            </span>
          </>
        ) : (
          <span className="market-pct num">{blue == null ? "—" : fmtPct(blue)}</span>
        )}
      </span>
    </div>
  );
}

function DecisionBlock({
  bout,
  redName,
  blueName,
  nowMs,
}: {
  bout: UpcomingBoutOdds | undefined;
  redName: string;
  blueName: string;
  nowMs: number;
}) {
  const usableSnapshot = (provider: UpcomingProviderId) => {
    const entry = bout?.providers[provider];
    const status = upcomingProviderDisplayStatus(entry, nowMs);
    return status === "loaded" || status === "stale"
      ? entry?.snapshot?.provenance.synthetic === false
        ? entry.snapshot
        : null
      : null;
  };

  const source = (["kalshi", "polymarket"] as const).find((provider) => {
    const snapshot = usableSnapshot(provider);
    return snapshot !== null && marketProbabilities(snapshot) !== null;
  });
  const sportsbookSnapshots = SPORTSBOOK_PROVIDERS
    .map((provider) => usableSnapshot(provider))
    .filter((snapshot): snapshot is OddsSnapshot => snapshot !== null);
  const firstSportsbookSnapshot = sportsbookSnapshots[0];
  const sportsbookSnapshot: OddsSnapshot | null = firstSportsbookSnapshot === undefined
    ? null
    : {
        ...firstSportsbookSnapshot,
        quotes: sportsbookSnapshots.flatMap((snapshot) =>
          snapshot.quotes.filter(
            (quote) => quote.native.kind === "american-moneyline",
          ),
        ),
      };
  const decisionSnapshot = source === undefined
    ? sportsbookSnapshot
    : usableSnapshot(source);
  const probabilities = decisionSnapshot === null
    ? null
    : marketProbabilities(decisionSnapshot);
  const accent = source ?? "sportsbook";

  return (
    <section
      className="market"
      data-market-accent={accent}
      aria-label={`Decision odds, ${probabilities === null ? "not available" : "available"}`}
    >
      <div className="market-head">
        <h3>Decision</h3>
      </div>
      <div className="market-bar">
        <span className="market-side">
          <span className="market-pct num">
            {probabilities === null ? "—" : fmtPct(probabilities.red)}
          </span>
        </span>
        <SplitBar
          red={probabilities?.red ?? null}
          blue={probabilities?.blue ?? null}
          redName={redName}
          blueName={blueName}
        />
        <span className="market-side market-side-blue">
          <span className="market-pct num">
            {probabilities === null ? "—" : fmtPct(probabilities.blue)}
          </span>
        </span>
      </div>
    </section>
  );
}

export function UpcomingMarketBlock({
  provider,
  entry,
  entries,
  redName,
  blueName,
  nowMs,
}: {
  provider: DisplayProvider;
  entry: UpcomingProviderEntry | undefined;
  entries?: Partial<Record<UpcomingProviderId, UpcomingProviderEntry>>;
  redName: string;
  blueName: string;
  nowMs: number;
}) {
  const providers = provider === "sportsbooks" ? SPORTSBOOK_PROVIDERS : [provider];
  const statuses = providers.map((source) =>
    upcomingProviderDisplayStatus(entries?.[source] ?? entry, nowMs),
  );
  const status = statuses.includes("loaded")
    ? "loaded"
    : statuses.includes("stale")
      ? "stale"
      : statuses.find((candidate) => candidate !== "not_listed") ?? "not_listed";
  const sportsbookEntries = provider === "sportsbooks"
    ? SPORTSBOOK_PROVIDERS.map((source) => entries?.[source])
    : [];
  const sportsbookQuotes = provider === "sportsbooks"
    ? {
        red: bestSportsbookQuote(sportsbookEntries, "red"),
        blue: bestSportsbookQuote(sportsbookEntries, "blue"),
      }
    : undefined;
  const snapshot = provider === "sportsbooks"
    ? null
    : status === "loaded" || status === "stale"
      ? (entry?.snapshot?.provenance.synthetic === false
        ? entry.snapshot
        : null)
      : null;
  const label = provider === "sportsbooks" ? "Sportsbooks" : UPCOMING_PROVIDER_LABEL[provider];

  return (
    <section
      className="market"
      data-market-accent={PROVIDER_ACCENT[provider]}
      data-upcoming-status={status}
      aria-label={`${label} odds, ${status.replace("_", " ")}`}
    >
      <div className="market-head">
        <h3>{label}</h3>
      </div>
      <ProviderBar
        snapshot={snapshot}
        sportsbookQuotes={sportsbookQuotes}
        redName={redName}
        blueName={blueName}
      />
    </section>
  );
}

/**
 * The Odds tab for a fight that has not started.
 *
 * No fixture price is ever substituted: a number on this screen is always a
 * real one that a provider actually published.
 */
export function UpcomingOddsPanel({
  bout,
  redName,
  blueName,
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
      {PROVIDER_ORDER.map((provider) => (
        <UpcomingMarketBlock
          key={provider}
          provider={provider}
          entry={
            provider === "sportsbooks" ? undefined : bout?.providers[provider]
          }
          entries={bout?.providers}
          redName={redName}
          blueName={blueName}
          nowMs={nowMs}
        />
      ))}
      <DecisionBlock
        bout={bout}
        redName={redName}
        blueName={blueName}
        nowMs={nowMs}
      />
    </section>
  );
}
