import type { OddsQuote, OddsSnapshot } from "../schema.ts";
import bet365Logo from "../assets/brand/Bet365-Logo.png";
import kalshiLogo from "../assets/brand/kalshi-logo-primary-green-1-on-near-black.svg";
import polymarketLogo from "../assets/brand/polymarket-logo-white.svg";
import { averageImpliedProbability } from "../lib/oddsMath.ts";
import {
  upcomingDecisionDisplayStatus,
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

const PROVIDER_LOGO: Record<DisplayProvider, { alt: string; src: string }> = {
  kalshi: { alt: "Kalshi", src: kalshiLogo },
  polymarket: { alt: "Polymarket", src: polymarketLogo },
  sportsbooks: { alt: "Bet365", src: bet365Logo },
};

function compactUsd(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  return `$${value.toFixed(0)}`;
}

function MetadataFooter({
  provider,
  entry,
  entries,
}: {
  provider: DisplayProvider;
  entry: UpcomingProviderEntry | undefined;
  entries?: Partial<Record<UpcomingProviderId, UpcomingProviderEntry>>;
}) {
  const isRealEntry = (candidate: UpcomingProviderEntry | undefined) =>
    candidate?.snapshot?.provenance.synthetic === false &&
    candidate.status === "loaded";

  if (provider === "sportsbooks") {
    const bookmakerCount = SPORTSBOOK_PROVIDERS.reduce((total, source) => {
      const sourceEntry = entries?.[source];
      const count = isRealEntry(sourceEntry)
        ? sourceEntry?.metadata?.bookmakerCount
        : undefined;
      return count !== undefined && Number.isFinite(count) ? total + count : total;
    }, 0);
    const hasBookmakerCount = SPORTSBOOK_PROVIDERS.some((source) => {
      const sourceEntry = entries?.[source];
      const count = isRealEntry(sourceEntry)
        ? sourceEntry?.metadata?.bookmakerCount
        : undefined;
      return count !== undefined && Number.isFinite(count);
    });
    if (!hasBookmakerCount) return null;
    return (
      <div className="market-footer">
        {bookmakerCount} {bookmakerCount === 1 ? "book" : "books"}
      </div>
    );
  }

  const metadata = entry !== undefined && isRealEntry(entry)
    ? entry.metadata
    : undefined;
  if (metadata === undefined) return null;
  const values = provider === "kalshi"
    ? [
        ["Vol", compactUsd(metadata.volume)],
        ["OI", compactUsd(metadata.openInterest)],
      ]
    : [
        ["Vol", compactUsd(metadata.volume)],
        ["24h", compactUsd(metadata.volume24hr)],
        ["Liq", compactUsd(metadata.liquidity)],
      ];
  const present = values.filter(([, value]) => value !== null);
  if (present.length === 0) return null;

  return (
    <div className="market-footer">
      {present.map(([label, value], index) => (
        <span key={label}>
          {index > 0 && <span aria-hidden="true"> · </span>}
          {label} {value}
        </span>
      ))}
    </div>
  );
}

function bestSportsbookQuote(
  entries: readonly (UpcomingProviderEntry | undefined)[],
  corner: "red" | "blue",
  allowSynthetic = false,
) {
  return entries
    .flatMap((source) =>
      source?.snapshot !== undefined &&
      (source.snapshot.provenance.synthetic === false || allowSynthetic)
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

function DecisionBar({
  decision,
  finish,
}: {
  decision: number | null;
  finish: number | null;
}) {
  const hasData = decision != null && finish != null;
  const total = (decision ?? 0) + (finish ?? 0);
  const decisionShare =
    hasData && total > 0 ? ((decision as number) / total) * 100 : 50;
  const label = hasData
    ? `Decision ${fmtPct(decision as number)}, Finish ${fmtPct(finish as number)}`
    : "Decision versus finish odds unavailable";

  return (
    <div className="split" role="img" aria-label={label}>
      <span
        className={hasData ? "split-decision" : "split-neutral"}
        style={{ width: `calc(${decisionShare}% - 1px)` }}
      />
      <span
        className={hasData ? "split-finish" : "split-neutral"}
        style={{ width: `calc(${100 - decisionShare}% - 1px)` }}
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
        <span className="decision-label">{redName}</span>
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
        <span className="decision-label">{blueName}</span>
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
  nowMs,
}: {
  bout: UpcomingBoutOdds | undefined;
  nowMs: number;
}) {
  const decision = bout?.decision;
  const status = upcomingDecisionDisplayStatus(decision, nowMs);
  const available =
    (status === "loaded" || status === "stale") &&
    decision?.synthetic === false &&
    decision.decisionProbability !== undefined &&
    decision.finishProbability !== undefined;
  const decisionProbability = available
    ? decision?.decisionProbability ?? null
    : null;
  const finishProbability = available
    ? decision?.finishProbability ?? null
    : null;
  const accent = decision?.source ?? "sportsbook";

  return (
    <section
      className="market"
      data-market-accent={accent}
      data-upcoming-status={status}
      aria-label={`Go the distance odds, ${available ? "available" : "not available"}`}
    >
      <div className="market-head">
        <h3 className="market-head-text">Go the distance</h3>
      </div>
      <div className="market-bar">
        <span className="market-side decision-side">
          <span className="decision-label">DECISION</span>
          <span className="market-pct num">
            {decisionProbability === null ? "—" : fmtPct(decisionProbability)}
          </span>
        </span>
        <DecisionBar decision={decisionProbability} finish={finishProbability} />
        <span className="market-side market-side-blue decision-side">
          <span className="decision-label">FINISH</span>
          <span className="market-pct num">
            {finishProbability === null ? "—" : fmtPct(finishProbability)}
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
  allowSynthetic = false,
}: {
  provider: DisplayProvider;
  entry: UpcomingProviderEntry | undefined;
  entries?: Partial<Record<UpcomingProviderId, UpcomingProviderEntry>>;
  redName: string;
  blueName: string;
  nowMs: number;
  allowSynthetic?: boolean;
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
        red: bestSportsbookQuote(sportsbookEntries, "red", allowSynthetic),
        blue: bestSportsbookQuote(sportsbookEntries, "blue", allowSynthetic),
      }
    : undefined;
  const entrySnapshot = entry?.snapshot;
  const snapshot = provider === "sportsbooks"
    ? null
    : status === "loaded" || status === "stale"
      ? (entrySnapshot !== undefined &&
        (entrySnapshot.provenance.synthetic === false || allowSynthetic)
        ? entrySnapshot
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
        <h3>
          <img
            src={PROVIDER_LOGO[provider].src}
            alt={PROVIDER_LOGO[provider].alt}
          />
        </h3>
      </div>
      <ProviderBar
        snapshot={snapshot}
        sportsbookQuotes={sportsbookQuotes}
        redName={redName}
        blueName={blueName}
      />
      <MetadataFooter provider={provider} entry={entry} entries={entries} />
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
  allowSynthetic = false,
}: {
  bout: UpcomingBoutOdds | undefined;
  redName: string;
  blueName: string;
  notice?: string;
  nowMs?: number;
  allowSynthetic?: boolean;
}) {
  return (
    <section className="panel upcoming-odds-panel" aria-label="Odds comparison">
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
          allowSynthetic={allowSynthetic}
        />
      ))}
      <DecisionBlock
        bout={bout}
        nowMs={nowMs}
      />
    </section>
  );
}
