import { useState } from "react";

import type { EspnScheduledFight, EspnScheduledFighter } from "../sources/espnSchedule.ts";
import type { Corner, Fighter, FightRecord } from "../schema.ts";

import { FighterProfile } from "./FighterProfile.tsx";
import { RecentForm } from "./RecentForm.tsx";
import { SectionTabs, type FightSection } from "./SectionTabs.tsx";
import "./newComponents.css";

const PREVIEW_SECTIONS: FightSection[] = ["odds", "tale", "stats"];

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2);
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
    provenance: { source: "espn", fetchedAt: new Date().toISOString(), synthetic: false },
  };
}

function PreviewFighter({
  fighter,
  corner,
}: {
  fighter: EspnScheduledFighter;
  corner: "red" | "blue";
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = fighter.headshotUrl && !imgFailed;
  const lastName = fighter.name.split(" ").at(-1) ?? fighter.name;
  return (
    <div className={`tot-fighter tot-${corner}`}>
      <span
        className={`fighter-photo fighter-photo-${corner}`}
        aria-hidden={showImg ? undefined : "true"}
      >
        {showImg ? (
          <img
            className="fighter-photo-img"
            src={fighter.headshotUrl}
            alt={fighter.name}
            onError={() => setImgFailed(true)}
          />
        ) : (
          initialsOf(fighter.name)
        )}
      </span>
      <span className={`tot-name corner-${corner}`} title={fighter.name}>
        {lastName}
      </span>
      {fighter.record && <span className="tot-record num">{fighter.record}</span>}
    </div>
  );
}

function OddsSection() {
  // No real data pipeline connects future ESPN fights to market odds yet —
  // this always renders the "not available" state until one is wired up.
  return (
    <div className="state-notice">
      <strong>Odds</strong>
      <span>Odds aren't available for this fight yet.</span>
    </div>
  );
}

function TaleSection({ fight }: { fight: EspnScheduledFight }) {
  const fighters: Record<Corner, Fighter> = {
    red: toFighter(fight.red),
    blue: toFighter(fight.blue),
  };
  return (
    <>
      <FighterProfile fighters={fighters} />
      <RecentForm fighters={fighters} />
    </>
  );
}

// Placeholder fight-outlook copy. Swap for a real AI-generated prediction
// once a data source exists.
const OUTLOOK_PLACEHOLDER =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. This fight outlook " +
  "will summarize stylistic matchups and a data-driven prediction once a " +
  "live analysis source is wired up. Sed do eiusmod tempor incididunt ut " +
  "labore et dolore magna aliqua.";

const STAT_ROWS: { key: string; label: string }[] = [
  { key: "strikeLPM", label: "Sig. strikes landed/min" },
  { key: "strikeAccuracy", label: "Sig. strike accuracy" },
  { key: "takedownAvg", label: "Takedown avg" },
  { key: "takedownAccuracy", label: "Takedown accuracy" },
  { key: "submissionAvg", label: "Submission avg" },
];

function statValue(fighter: EspnScheduledFighter, key: string): string {
  return fighter.stats?.find((stat) => stat.name === key)?.displayValue ?? "—";
}

function StatsSection({ fight }: { fight: EspnScheduledFight }) {
  // The outlook paragraph above is still a placeholder pending a real
  // AI-generated summary source; the stat rows below use ESPN's real
  // per-fighter career-average stats.
  return (
    <section className="profile-panel" aria-label="Fight outlook">
      <div className="outlook-panel">
        <span className="outlook-heading">Fight outlook</span>
        <p className="outlook-body">{OUTLOOK_PLACEHOLDER}</p>
      </div>
      <div className="profile-rows">
        {STAT_ROWS.map(({ key, label }) => (
          <div className="profile-row" key={key}>
            <span className="num">{statValue(fight.red, key)}</span>
            <span>{label}</span>
            <span className="num">{statValue(fight.blue, key)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Fight-detail view for a future (not-yet-started) ESPN fight — a lighter
 * stand-in for the full live BoutHeader + SectionTabs experience, which
 * needs live round data that doesn't exist pre-fight.
 */
export function ScheduledFightPreview({
  fight,
}: {
  fight: EspnScheduledFight;
}) {
  const [active, setActive] = useState<FightSection>("tale");

  // ESPN's fightcenter payload has no explicit scheduled-rounds field for
  // future fights; inferred from modern UFC convention (title fights and
  // main events go 5 rounds, everything else 3) rather than ESPN-supplied
  // data.
  const scheduledRounds = fight.titleFight || fight.mainEvent ? 5 : 3;

  return (
    <div className="scheduled-preview">
      <section className="tot" aria-label="Tale of the tape">
        <div className="tot-class">
          {fight.weightClassLabel ?? ""}
          {fight.titleFight ? " · Title fight" : ""}
        </div>
        <div className="tot-grid">
          <PreviewFighter fighter={fight.red} corner="red" />
          <div className="tot-center">
            <span className="tot-live-label tot-upcoming">Upcoming</span>
            <span className="tot-round-label num">{scheduledRounds}×5</span>
            <span className="tot-substate">rounds · not started</span>
          </div>
          <PreviewFighter fighter={fight.blue} corner="blue" />
        </div>
      </section>

      <SectionTabs active={active} onChange={setActive} sections={PREVIEW_SECTIONS} />

      {active === "odds" && <OddsSection />}
      {active === "tale" && <TaleSection fight={fight} />}
      {active === "stats" && <StatsSection fight={fight} />}
    </div>
  );
}
