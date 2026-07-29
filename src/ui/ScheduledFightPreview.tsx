import { useState } from "react";

import type { EspnScheduledFight, EspnScheduledFighter } from "../sources/espnSchedule.ts";
import type { Corner, Fighter, FightRecord } from "../schema.ts";

import { BoutHeader } from "./BoutHeader.tsx";
import { FighterProfile } from "./FighterProfile.tsx";
import { RecentForm } from "./RecentForm.tsx";
import { SectionTabs, type FightSection } from "./SectionTabs.tsx";
import "./newComponents.css";

const PREVIEW_SECTIONS: FightSection[] = ["odds", "tale", "stats"];

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
 * Fight-detail view for a future (not-yet-started) ESPN fight. Shares the
 * live Fight tab's BoutHeader/FighterProfile/RecentForm elements outright
 * (a fight's tale-of-the-tape identity doesn't change between "scheduled"
 * and "in progress") and only swaps in a lighter tab set (no round data,
 * no live odds) for what genuinely doesn't exist before the fight starts.
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
      <BoutHeader
        weightClassLabel={fight.weightClassLabel ?? ""}
        titleFight={fight.titleFight}
        scheduledRounds={scheduledRounds}
        fighters={{ red: toFighter(fight.red), blue: toFighter(fight.blue) }}
        status="upcoming"
        photosByCorner={{
          red: fight.red.headshotUrl,
          blue: fight.blue.headshotUrl,
        }}
      />

      <SectionTabs active={active} onChange={setActive} sections={PREVIEW_SECTIONS} />

      {active === "odds" && <OddsSection />}
      {active === "tale" && <TaleSection fight={fight} />}
      {active === "stats" && <StatsSection fight={fight} />}
    </div>
  );
}
