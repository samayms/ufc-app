import { useEffect, useRef, useState } from "react";

import type { EspnScheduledFight, EspnScheduledFighter } from "../sources/espnSchedule.ts";
import type {
  Bout,
  BoutView,
  Corner,
  Fighter,
  FightRecord,
  OddsSnapshot,
} from "../schema.ts";

import {
  findUpcomingBout,
  type UpcomingBoutOdds,
  type UpcomingProviderEntry,
  type UpcomingProviderId,
} from "../lib/upcomingOdds.ts";
import type { UpcomingOddsState } from "../store/useUpcomingOdds.ts";
import { BoutHeader } from "./BoutHeader.tsx";
import { FighterProfile } from "./FighterProfile.tsx";
import { MarketStrip } from "./MarketStrip.tsx";
import { RecentForm } from "./RecentForm.tsx";
import { SkeletonRows } from "./Skeleton.tsx";
import { UpcomingOddsPanel } from "./UpcomingOddsPanel.tsx";
import { SectionTabs, type FightSection } from "./SectionTabs.tsx";
import { directionBetween } from "../lib/screenTransition.ts";
import { ScreenTransition } from "./ScreenTransition.tsx";
import { WEIGHT_LABEL, fmtRecord } from "./format.ts";
import "./newComponents.css";

const PREVIEW_SECTIONS: FightSection[] = ["tale", "odds"];

function previewSectionDepth(key: string): number {
  return PREVIEW_SECTIONS.indexOf(key as FightSection);
}

function boutFighterToScheduledFighter(fighter: Fighter): EspnScheduledFighter {
  const athleteId = fighter.externalRefs.find((ref) => ref.source === "espn")?.id;
  return {
    ...(athleteId === undefined ? {} : { athleteId }),
    name: fighter.name,
    record: fmtRecord(fighter.record),
    ...(fighter.nickname === undefined ? {} : { nickname: fighter.nickname }),
    ...(fighter.country === undefined ? {} : { country: fighter.country }),
    ...(fighter.age === undefined ? {} : { age: fighter.age }),
    ...(fighter.heightCm === undefined ? {} : { heightCm: fighter.heightCm }),
    ...(fighter.reachCm === undefined ? {} : { reachCm: fighter.reachCm }),
    ...(fighter.stance === undefined ? {} : { stance: fighter.stance }),
    ...(fighter.recentBouts === undefined ? {} : { recentBouts: fighter.recentBouts }),
    ...(fighter.ranking === undefined ? {} : { ranking: fighter.ranking }),
  };
}

function liveSnapshotEntry(
  provider: UpcomingProviderId,
  snapshot: OddsSnapshot,
): UpcomingProviderEntry {
  const fetchedAt = snapshot.provenance.fetchedAt;
  return {
    status: "loaded",
    fetchedAt,
    updatedAt: snapshot.marketUpdatedAt ?? fetchedAt,
    externalId: `${provider}:${snapshot.boutId}`,
    confidence: 1,
    cornersReversed: false,
    snapshot,
  };
}

/** Converts live snapshots into the same provider shape used by upcoming odds. */
export function liveBoutToUpcomingOdds(view: BoutView): UpcomingBoutOdds {
  const providers: UpcomingBoutOdds["providers"] = {};
  for (const snapshot of Object.values(view.latestOdds)) {
    const provider: UpcomingProviderId =
      snapshot.market === "kalshi"
        ? "kalshi"
        : snapshot.market === "polymarket"
          ? "polymarket"
          : snapshot.provenance.source === "odds-api"
            ? "odds-api"
            : "odds-api-io";
    providers[provider] = liveSnapshotEntry(provider, snapshot);
  }
  const synthetic = Object.values(view.latestOdds).some(
    (snapshot) => snapshot.provenance.synthetic,
  );
  return {
    boutId: view.bout.id,
    espnEventId: view.bout.eventId,
    redFighter: view.bout.fighters.red.name,
    blueFighter: view.bout.fighters.blue.name,
    providers,
    decision: {
      state: "not_listed",
      fetchedAt: new Date().toISOString(),
      synthetic,
    },
  };
}

/** Adapts a canonical bout into the same preview contract used by ESPN cards. */
export function boutToScheduledFight(bout: Bout): EspnScheduledFight {
  return {
    competitionId: bout.id,
    matchNumber: bout.cardPosition,
    weightClassLabel: WEIGHT_LABEL[bout.weightClass] ?? bout.weightClass,
    titleFight: bout.titleFight,
    mainEvent: bout.cardPosition === 1,
    red: boutFighterToScheduledFighter(bout.fighters.red),
    blue: boutFighterToScheduledFighter(bout.fighters.blue),
    status: bout.status,
    ...(bout.currentRound === undefined ? {} : { currentRound: bout.currentRound }),
    ...(bout.result === undefined ? {} : { result: bout.result }),
    ...(bout.outlook === undefined ? {} : { outlook: bout.outlook }),
  };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Parses a display record like "20-5-0" (optionally with a trailing
 * " (N NC)") into the structured shape `Fighter.record` needs. Copied
 * locally rather than importing espn.ts's private parseRecord, matching
 * this file's established convention of not reaching into that module's
 * fetch/parse plumbing — never throws, defaults any unparseable part to 0.
 */
function parseDisplayRecord(record: string | undefined): FightRecord {
  if (record === undefined) return { wins: 0, losses: 0, draws: 0, noContests: 0 };
  const match = record.match(/^(\d+)-(\d+)-(\d+)/);
  const ncMatch = record.match(/\((\d+)\s*NC\)/i);
  return {
    wins: match ? Number(match[1]) : 0,
    losses: match ? Number(match[2]) : 0,
    draws: match ? Number(match[3]) : 0,
    noContests: ncMatch ? Number(ncMatch[1]) : 0,
  };
}

/**
 * Adapts an ESPN scheduled-card fighter into the full `Fighter` shape
 * `FighterProfile`/`RecentForm` expect, so the future-fight preview can
 * reuse the exact same tale-of-the-tape components as the live fight view.
 * The resulting `id` is a synthetic, display-only value — never persisted
 * or reconciled against anything.
 */
function toFighter(fighter: EspnScheduledFighter): Fighter {
  return {
    id: fighter.athleteId ?? slugify(fighter.name),
    externalRefs: fighter.athleteId ? [{ source: "espn", id: fighter.athleteId }] : [],
    name: fighter.name,
    nickname: fighter.nickname,
    record: parseDisplayRecord(fighter.record),
    stance: fighter.stance,
    heightCm: fighter.heightCm,
    reachCm: fighter.reachCm,
    age: fighter.age,
    country: fighter.country,
    recentBouts: fighter.recentBouts,
    ranking: fighter.ranking,
    provenance: { source: "espn", fetchedAt: new Date().toISOString(), synthetic: false },
  };
}

/**
 * Odds tab for a future (not-yet-started) fight.
 *
 * Backed by the twice-daily upcoming-odds sync rather than the live
 * collector's in-fight tick stream. Each of the four providers reports its
 * own state, because before a fight starts "Kalshi hasn't listed it" and
 * "Kalshi is down" are the two most common situations and they are not the
 * same answer. Nothing here falls back to fixture prices: every number on
 * this screen was published by a real provider for this exact bout.
 */
export function UpcomingOddsSection({
  fight,
  upcoming,
  liveView,
}: {
  fight: EspnScheduledFight;
  upcoming: UpcomingOddsState;
  liveView?: BoutView;
}) {
  const redName = fight.red.name.split(" ").at(-1) ?? fight.red.name;
  const blueName = fight.blue.name.split(" ").at(-1) ?? fight.blue.name;
  const upcomingBout = findUpcomingBout(upcoming.document, fight.competitionId);
  const liveBout = liveView ? liveBoutToUpcomingOdds(liveView) : undefined;
  const bout = liveBout && Object.keys(liveBout.providers).length > 0
    ? liveBout
    : upcomingBout;

  if (upcoming.status === "loading") {
    return (
      <div className="upcoming-odds-panel upcoming-odds-skeleton">
        <SkeletonRows count={4} className="upcoming-odds-skeleton-row" />
      </div>
    );
  }

  const notice =
    upcoming.status === "error"
      ? (upcoming.message ??
        "Live odds are temporarily unavailable. Try again shortly.")
      : upcoming.document === null
        ? "Pre-fight odds are not available yet."
        : bout === undefined
          ? "Pre-fight odds are not available for this fight yet."
          : undefined;

  return (
    <UpcomingOddsPanel
      bout={bout}
      redName={redName}
      blueName={blueName}
      {...(notice === undefined ? {} : { notice })}
      {...(liveView === undefined ? {} : { allowSynthetic: true })}
    />
  );
}

function hasRealStatValue(value: string | undefined): boolean {
  return value !== undefined && value !== "—";
}

/** "3.21" -> 3.21; "—" or anything non-numeric -> undefined. */
function parseStatNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function UpcomingTaleSection({
  fighters,
  statValues,
  outlook,
}: {
  fighters: Record<Corner, Fighter>;
  statValues?: Partial<Record<Corner, Record<string, string>>>;
  /** Real Sherdog-derived outlook text; the panel is omitted entirely when absent. */
  outlook?: string;
}) {
  const hasAnyStats = STAT_ROWS.some(
    ({ key }) =>
      hasRealStatValue(statValues?.red?.[key]) || hasRealStatValue(statValues?.blue?.[key]),
  );
  return (
    <>
      <FighterProfile fighters={fighters} />
      <RecentForm fighters={fighters} />
      <section
        className="profile-panel"
        aria-label={outlook === undefined ? "Fighter stats" : "Fight outlook and fighter stats"}
      >
        {outlook === undefined ? undefined : (
          <div className="outlook-panel">
            <span className="outlook-heading">Fight outlook</span>
            <p className="outlook-body">{outlook}</p>
          </div>
        )}
        <div
          className={
            outlook === undefined ? "profile-rows profile-rows--leading" : "profile-rows"
          }
        >
          {STAT_ROWS.map(({ key, label }) => {
            const red = parseStatNumber(statValues?.red?.[key]);
            const blue = parseStatNumber(statValues?.blue?.[key]);
            const max = Math.max(red ?? 0, blue ?? 0, 1);
            return (
              <div className="profile-row-block" key={key}>
                <div className="profile-row">
                  <span className="num">{statValues?.red?.[key] ?? "—"}</span>
                  <span>{label}</span>
                  <span className="num">{statValues?.blue?.[key] ?? "—"}</span>
                </div>
                <div className="profile-row-bars" aria-hidden="true">
                  <span>
                    <i
                      className="profile-row-bar-red"
                      style={{ width: red ? `${(red / max) * 100}%` : "0%" }}
                    />
                  </span>
                  <span>
                    <i
                      className="profile-row-bar-blue"
                      style={{ width: blue ? `${(blue / max) * 100}%` : "0%" }}
                    />
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        {!hasAnyStats && (
          <p className="profile-rows-empty">
            No career averages available for this matchup
          </p>
        )}
      </section>
    </>
  );
}

function TaleSection({ fight }: { fight: EspnScheduledFight }) {
  const fighters: Record<Corner, Fighter> = {
    red: toFighter(fight.red),
    blue: toFighter(fight.blue),
  };
  return (
    <UpcomingTaleSection
      fighters={fighters}
      outlook={fight.outlook}
      statValues={taleStatValues(fight)}
    />
  );
}

/**
 * ESPN's fightcenter career-average stats for both corners of a fight, in
 * the shape `UpcomingTaleSection` takes. Exported so the live/current-event
 * Fight tab (App.tsx) can show the same real numbers this preview does, once
 * it has matched its own bout to an ESPN fightcenter fight.
 */
export function taleStatValues(
  fight: EspnScheduledFight,
): Partial<Record<Corner, Record<string, string>>> {
  return {
    red: Object.fromEntries(
      STAT_ROWS.map(({ key }) => [key, statValue(fight.red, key)]),
    ),
    blue: Object.fromEntries(
      STAT_ROWS.map(({ key }) => [key, statValue(fight.blue, key)]),
    ),
  };
}

const STAT_ROWS: { key: string; label: string }[] = [
  { key: "strikeLPM", label: "Sig. strikes landed/min" },
  { key: "strikeAccuracy", label: "Sig. strike accuracy" },
  { key: "takedownAvg", label: "Takedown avg" },
  { key: "takedownAccuracy", label: "Takedown accuracy" },
  { key: "submissionAvg", label: "Submission avg" },
];

/**
 * Collapses a bout's per-provider entries into the market-keyed shape
 * `MarketStrip` already speaks. Kalshi and Polymarket map straight across; the
 * two sportsbook providers share one slot, so the more recently updated of the
 * two wins rather than whichever happened to be enumerated last.
 */
function latestOddsByMarket(
  bout: UpcomingBoutOdds,
): Partial<Record<OddsSnapshot["market"], OddsSnapshot>> {
  const latest: Partial<Record<OddsSnapshot["market"], OddsSnapshot>> = {};
  for (const entry of Object.values(bout.providers)) {
    if (entry?.status !== "loaded" || entry.snapshot === undefined) continue;
    const market = entry.snapshot.market;
    const existing = latest[market];
    if (
      existing === undefined ||
      (entry.updatedAt ?? "") > (existing.marketUpdatedAt ?? "")
    ) {
      latest[market] = entry.snapshot;
    }
  }
  return latest;
}

function statValue(fighter: EspnScheduledFighter, key: string): string {
  return fighter.stats?.find((stat) => stat.name === key)?.displayValue ?? "—";
}

/**
 * Fight-detail view for a future (not-yet-started) ESPN fight. Shares the
 * live Fight tab's BoutHeader/FighterProfile/RecentForm elements outright
 * (a fight's tale-of-the-tape identity doesn't change between "scheduled"
 * and "in progress") and only swaps in a lighter tab set (no round data,
 * no live odds) for what genuinely doesn't exist before the fight starts.
 */
export function ScheduledFightPreview({
  fight,
  upcoming,
  photosByCorner,
}: {
  fight: EspnScheduledFight;
  upcoming: UpcomingOddsState;
  photosByCorner?: Partial<Record<Corner, string>>;
}) {
  const [active, setActive] = useState<FightSection>("tale");
  const previousActiveRef = useRef<string | null>(null);
  const activeDirection = directionBetween(
    previousActiveRef.current,
    active,
    previewSectionDepth,
  );
  useEffect(() => {
    previousActiveRef.current = active;
  }, [active]);

  // ESPN's fightcenter payload has no explicit scheduled-rounds field for
  // future fights; inferred from modern UFC convention (title fights and
  // main events go 5 rounds, everything else 3) rather than ESPN-supplied
  // data.
  const scheduledRounds = fight.titleFight || fight.mainEvent ? 5 : 3;

  // The strip above the tabs previews whatever the sync actually has, so a
  // fight with real upcoming odds shows them before the Odds tab is opened.
  const upcomingBout = findUpcomingBout(upcoming.document, fight.competitionId);
  const stripOdds = upcomingBout === undefined ? {} : latestOddsByMarket(upcomingBout);

  return (
    <div className="scheduled-preview">
      <BoutHeader
        weightClassLabel={fight.weightClassLabel ?? ""}
        titleFight={fight.titleFight}
        scheduledRounds={scheduledRounds}
        fighters={{ red: toFighter(fight.red), blue: toFighter(fight.blue) }}
        status="upcoming"
        photosByCorner={photosByCorner ?? {
          red: fight.red.headshotUrl,
          blue: fight.blue.headshotUrl,
        }}
      />
      <MarketStrip
        latestOdds={stripOdds}
        preFightOdds={{}}
        onOpen={() => setActive("odds")}
      />

      <SectionTabs active={active} onChange={setActive} sections={PREVIEW_SECTIONS} />

      <ScreenTransition screenKey={active} direction={activeDirection}>
        {active === "odds" && <UpcomingOddsSection fight={fight} upcoming={upcoming} />}
        {active === "tale" && <TaleSection fight={fight} />}
      </ScreenTransition>
    </div>
  );
}
