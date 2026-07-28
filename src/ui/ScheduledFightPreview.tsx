import { useState } from "react";

import type { EspnScheduledFight, EspnScheduledFighter } from "../sources/espnSchedule.ts";

import { BackButton } from "./BackButton.tsx";
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
    <div className="scheduled-preview-fighter">
      <span
        className={`scheduled-preview-photo fighter-photo-${corner}`}
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
      <span className={`scheduled-preview-name corner-${corner}`} title={fighter.name}>
        {lastName}
      </span>
      {fighter.record && <span className="scheduled-preview-record num">{fighter.record}</span>}
    </div>
  );
}

/** One "?" placeholder row shared by the tale and stats sections below. */
function PlaceholderRow({ label }: { label: string }) {
  return (
    <div className="profile-row">
      <span className="num">?</span>
      <span>{label}</span>
      <span className="num">?</span>
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
  // EspnScheduledFighter has no DOB/height/reach/stance/history fields today
  // — these rows render "?" on both sides until a real source is wired up.
  return (
    <section className="profile-panel" aria-label="Fighter comparison">
      <div className="profile-head">
        <div className="profile profile-red">
          <h3 className="corner-red">{fight.red.name.split(" ").at(-1)}</h3>
          {fight.red.country && <span className="profile-nick">{fight.red.country}</span>}
        </div>
        <span className="profile-vs">vs</span>
        <div className="profile profile-blue">
          <h3 className="corner-blue">{fight.blue.name.split(" ").at(-1)}</h3>
          {fight.blue.country && <span className="profile-nick">{fight.blue.country}</span>}
        </div>
      </div>
      <div className="profile-rows">
        <PlaceholderRow label="DOB / Age" />
        <PlaceholderRow label="Height" />
        <PlaceholderRow label="Reach" />
        <PlaceholderRow label="Stance" />
        <PlaceholderRow label="Recent fight history" />
      </div>
    </section>
  );
}

// Placeholder fight-outlook copy. Swap for a real AI-generated prediction
// once a data source exists.
const OUTLOOK_PLACEHOLDER =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. This fight outlook " +
  "will summarize stylistic matchups and a data-driven prediction once a " +
  "live analysis source is wired up. Sed do eiusmod tempor incididunt ut " +
  "labore et dolore magna aliqua.";

function StatsSection() {
  // Both the outlook paragraph above and the stat rows below are
  // placeholders pending a future data source (AI-generated summary +
  // real fighter stats).
  return (
    <section className="profile-panel" aria-label="Fight outlook">
      <div className="outlook-panel">
        <span className="outlook-heading">Fight outlook</span>
        <p className="outlook-body">{OUTLOOK_PLACEHOLDER}</p>
      </div>
      <div className="profile-rows">
        <PlaceholderRow label="Takedown defense" />
        <PlaceholderRow label="Finish rate" />
        <PlaceholderRow label="Sig. strikes landed/min" />
        <PlaceholderRow label="Sig. strikes absorbed/min" />
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
  onBack,
}: {
  fight: EspnScheduledFight;
  onBack: () => void;
}) {
  const [active, setActive] = useState<FightSection>("tale");

  return (
    <div className="scheduled-preview">
      <BackButton onClick={onBack} />

      <section className="tot" aria-label="Tale of the tape">
        <div className="scheduled-preview-head">
          <span className="scheduled-preview-class">
            {fight.weightClassLabel ?? ""}
            {fight.titleFight ? " · Title fight" : ""}
          </span>
        </div>
        <div className="scheduled-preview-grid">
          <PreviewFighter fighter={fight.red} corner="red" />
          <span className="scheduled-preview-vs">vs</span>
          <PreviewFighter fighter={fight.blue} corner="blue" />
        </div>
      </section>

      <SectionTabs active={active} onChange={setActive} sections={PREVIEW_SECTIONS} />

      {active === "odds" && <OddsSection />}
      {active === "tale" && <TaleSection fight={fight} />}
      {active === "stats" && <StatsSection />}
    </div>
  );
}
