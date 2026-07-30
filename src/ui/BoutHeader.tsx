import { useEffect, useState } from "react";
import type { BoutResult, BoutStatus, Corner, Fighter } from "../schema.ts";
import type { CollectorClockSync } from "../store/collectorClient.ts";
import { fmtMethod, fmtRecord } from "./format.ts";

/**
 * Turns an ESPN-sourced `Fighter.ranking` string (see `parseEspnRankings`
 * in espnSchedule.ts: either "${division} Champion" or "#${current}
 * ${division}") into the short badge text to render, or `null` when the
 * fighter is unranked or the string doesn't match a recognized shape —
 * absence over a fabricated badge.
 */
function rankingBadge(ranking: string | undefined): string | null {
  if (ranking === undefined) return null;
  if (/champion/i.test(ranking)) return "C";
  const match = ranking.match(/^#(\d+)/);
  return match?.[1] ?? null;
}

function FighterBlock({
  fighter,
  corner,
  photoUrl,
}: {
  fighter: Fighter;
  corner: Corner;
  photoUrl?: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = photoUrl !== undefined && !imgFailed;
  const initials = fighter.name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2);
  const firstName = fighter.name.split(" ")[0] ?? fighter.name;
  const lastName = fighter.name.split(" ").at(-1) ?? fighter.name;
  const badge = rankingBadge(fighter.ranking);
  const lastNameClass =
    lastName.length >= 14
      ? "tot-name tot-name-tight"
      : lastName.length >= 11
        ? "tot-name tot-name-compact"
        : "tot-name";

  return (
    <div className={`tot-fighter tot-${corner}`}>
      <span
        className={`fighter-photo fighter-photo-${corner}`}
        aria-hidden={showImg ? undefined : "true"}
      >
        {showImg ? (
          <img
            className="fighter-photo-img"
            src={photoUrl}
            alt={fighter.name}
            onError={() => setImgFailed(true)}
          />
        ) : (
          initials
        )}
      </span>
      <span className="tot-firstname">{firstName}</span>
      <span className="tot-name-row">
        <span className={`${lastNameClass} corner-${corner}`} title={fighter.name}>
          {lastName}
        </span>
        {badge && (
          <span className={`rank-badge${badge === "C" ? " rank-badge-champion" : ""}`}>
            <span className="rank-badge-text">{badge}</span>
          </span>
        )}
      </span>
      <span className="tot-record num">{fmtRecord(fighter.record)}</span>
    </div>
  );
}

function CenterStatus({
  status,
  currentRound,
  scheduledRounds,
  result,
  fighters,
  clockSync,
}: {
  status: BoutStatus;
  currentRound?: number;
  scheduledRounds: number;
  result?: BoutResult;
  fighters: Record<Corner, Fighter>;
  clockSync?: CollectorClockSync;
}) {
  const clockMatchesBoutState =
    clockSync !== undefined &&
    clockSync.state === "in" &&
    clockSync.period === currentRound &&
    clockSync.clockSeconds !== undefined;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    if (
      status !== "in-round" ||
      !clockMatchesBoutState ||
      clockSync.clockSeconds === 0
    ) {
      return;
    }

    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 250);
    return () => window.clearInterval(interval);
  }, [
    clockMatchesBoutState,
    clockSync?.clockSeconds,
    clockSync?.receivedAt,
    status,
  ]);

  if (status === "canceled" || status === "postponed") {
    return (
      <>
        <span className="tot-live-label tot-canceled">{status}</span>
        <span className="tot-round-label">—</span>
        <span className="tot-substate">bout unavailable</span>
      </>
    );
  }
  if (status === "final" && result) {
    const { winner, method, round, time } = result;
    const name =
      winner === "draw" || winner === "nc"
        ? null
        : fighters[winner as Corner].name.split(" ").at(-1);
    return (
      <>
        <span className="tot-live-label">Final</span>
        <span className="tot-round-label">
          {name ? `${name} wins` : winner.toUpperCase()}
        </span>
        <span className="tot-substate num">
          {fmtMethod(method)}
          {round ? ` · R${round}` : ""}
          {time ? ` ${time}` : ""}
        </span>
      </>
    );
  }
  if (status === "between-rounds" || status === "in-round") {
    const clockSeconds = clockMatchesBoutState
      ? interpolateClockSeconds(clockSync, now)
      : undefined;
    const clockText = formatFightClock(clockSeconds);
    const sourceLabel =
      clockSync?.source === "cito" ? "Cito fallback" : "ESPN sync";
    return (
      <>
        <span
          className={`tot-live-label${status === "between-rounds" ? " tot-between" : ""}`}
        >
          <span className="live-dot" aria-hidden="true" />
          {status === "in-round" ? "Live" : "Between rds"}
        </span>
        <span
          className="tot-fight-clock"
          role="timer"
          aria-label={
            clockSeconds === undefined
              ? `Round ${currentRound ?? ""} clock waiting for ESPN`
              : `${Math.floor(clockSeconds / 60)} minutes ${clockSeconds % 60} seconds remaining in round ${currentRound ?? ""}`
          }
        >
          {clockText}
        </span>
        <span className="tot-substate">
          {status === "in-round" ? `R${currentRound}` : `End R${currentRound}`}
          {" · "}
          {clockSeconds === undefined ? "waiting for ESPN" : sourceLabel}
        </span>
      </>
    );
  }
  return (
    <>
      <span className="tot-live-label tot-upcoming">Upcoming</span>
      <span className="tot-round-label num">{scheduledRounds} ROUNDS</span>
      <span className="tot-substate">not started</span>
    </>
  );
}

export function interpolateClockSeconds(
  sync: Pick<CollectorClockSync, "clockSeconds" | "receivedAt">,
  now: number,
): number | undefined {
  if (sync.clockSeconds === undefined) return undefined;
  const receivedAt = Date.parse(sync.receivedAt);
  const elapsedSeconds = Number.isFinite(receivedAt)
    ? Math.max(0, Math.floor((now - receivedAt) / 1_000))
    : 0;
  return Math.max(0, Math.floor(sync.clockSeconds) - elapsedSeconds);
}

export function formatFightClock(seconds: number | undefined): string {
  if (seconds === undefined) return "--:--";
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  return `${Math.floor(wholeSeconds / 60)}:${String(
    wholeSeconds % 60,
  ).padStart(2, "0")}`;
}

/**
 * Tale-of-the-tape header: weight class, both corners, and a center status
 * that reads the bout's live state. Deliberately takes plain fields rather
 * than a full live `Bout` — a not-yet-started ESPN fight has no canonical
 * `Bout` (no id, no event, no provenance), just the same handful of facts
 * this header actually renders, so this is the one shared element for both
 * the live Fight tab and the future-fight preview instead of two
 * hand-maintained copies of the same markup.
 */
export function BoutHeader({
  weightClassLabel,
  titleFight,
  scheduledRounds,
  fighters,
  status,
  currentRound,
  result,
  photosByCorner,
  clockSync,
}: {
  weightClassLabel: string;
  titleFight: boolean;
  scheduledRounds: number;
  fighters: Record<Corner, Fighter>;
  status: BoutStatus;
  currentRound?: number;
  result?: BoutResult;
  /** Latest collector clock sync; the browser interpolates between source polls. */
  clockSync?: CollectorClockSync;
  /** Optional real photo per corner — falls back to initials when absent, same as CardRail's RailPhoto. */
  photosByCorner?: Partial<Record<Corner, string>>;
}) {
  return (
    <section className="tot" aria-label="Tale of the tape">
      <div className="tot-class">
        {weightClassLabel}
        {titleFight ? " · Title fight" : ""}
      </div>
      <div className="tot-grid">
        <FighterBlock
          fighter={fighters.red}
          corner="red"
          photoUrl={photosByCorner?.red}
        />
        <div className="tot-center">
          <CenterStatus
            status={status}
            currentRound={currentRound}
            scheduledRounds={scheduledRounds}
            result={result}
            fighters={fighters}
            clockSync={clockSync}
          />
        </div>
        <FighterBlock
          fighter={fighters.blue}
          corner="blue"
          photoUrl={photosByCorner?.blue}
        />
      </div>
    </section>
  );
}
