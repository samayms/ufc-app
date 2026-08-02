import { useEffect, useState } from "react";
import type { BoutView, SherdogScorerCard, SherdogScorerProfile } from "../schema.ts";
import defaultScorerAvatar from "../assets/sherdog-default-avatar.svg";
import {
  collectorBaseUrl,
  type CollectorUnifiedRound,
} from "../store/collectorClient.ts";

function normalizeScorerNameForLookup(name: string): string {
  return name.toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

/**
 * Fetches the collector's cached Sherdog scorer-profile photos once per
 * mount. Best-effort: an empty map just means every scorer renders with no
 * avatar yet (or the default one), never a loading error state — this is
 * decorative, not load-bearing.
 */
function useSherdogScorerProfiles(): Map<string, SherdogScorerProfile> {
  const [profiles, setProfiles] = useState<Map<string, SherdogScorerProfile>>(
    () => new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    fetch(`${collectorBaseUrl()}/api/sherdog-scorer-profiles`)
      .then((response) => (response.ok ? response.json() : []))
      .then((records: SherdogScorerProfile[]) => {
        if (cancelled) return;
        setProfiles(
          new Map(records.map((profile) => [profile.normalizedName, profile])),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return profiles;
}

function ScorerAvatar({
  scorer,
  profiles,
}: {
  scorer: string;
  profiles: Map<string, SherdogScorerProfile>;
}) {
  const profile = profiles.get(normalizeScorerNameForLookup(scorer));
  const profilePhoto =
    profile === undefined
      ? defaultScorerAvatar
      : profile.resolved
        ? `${collectorBaseUrl()}${profile.photoUrl}`
        : defaultScorerAvatar;
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <img
      className="scorecard-judge-avatar"
      src={imageFailed ? defaultScorerAvatar : profilePhoto}
      alt=""
      width={32}
      height={32}
      loading="lazy"
      onError={() => setImageFailed(true)}
    />
  );
}

function hasScore(card: SherdogScorerCard): boolean {
  return [card.roundScore, card.cumulativeScore].some(
    (score) => typeof score === "string" && score.trim().length > 0,
  );
}

/** "10 - 9" (or an en/em dash) -> "10-9" for display: no space around the dash. */
function formatScore(score: string): string {
  return score.trim().replace(/\s*[-–—]\s*/u, "-");
}

function normalizeNameToken(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en-US")
    .trim();
}

/**
 * Sherdog's `winner` is a bare last name, and often drops diacritics a
 * fighter's own record keeps ("Rakic" for "Rakić"). Normalize both sides the
 * same way and compare against each corner's last name first, falling back
 * to a full-name substring check for multi-word surnames.
 */
export function matchWinnerCorner(
  winner: string | undefined,
  fighters: { red: string; blue: string },
): "red" | "blue" | undefined {
  if (!winner) return undefined;
  const token = normalizeNameToken(winner);
  if (token.length === 0) return undefined;

  for (const corner of ["red", "blue"] as const) {
    const fullName = normalizeNameToken(fighters[corner]);
    const lastName = fullName.split(" ").at(-1) ?? fullName;
    if (lastName === token || fullName.includes(token)) return corner;
  }
  return undefined;
}

function cornerClassName(corner: "red" | "blue" | undefined): string | undefined {
  if (corner === "red") return "corner-red";
  if (corner === "blue") return "corner-blue";
  return undefined;
}

/** Last name only, for the compact winner tag ("Aleksandar Rakić" -> "Rakić"). */
function lastName(fullName: string): string {
  return fullName.trim().split(/\s+/).at(-1) ?? fullName;
}

/** One judge's scored rounds, keyed by round number, round-ascending. */
interface JudgeRoundEntry {
  round: number;
  card: SherdogScorerCard;
}

interface JudgeTotal {
  scorer: string;
  entries: JudgeRoundEntry[];
}

/** Splits a "10-9" style score into its two numbers, corner-attributed via `winner`. */
function cornerScore(
  score: string,
  winner: string | undefined,
  fighters: { red: string; blue: string },
): { red: number; blue: number } | undefined {
  const parts = score.trim().split(/\s*[-–—]\s*/u).map(Number);
  if (parts.length !== 2 || parts.some((part) => Number.isNaN(part))) return undefined;
  const [high = 0, low = 0] = parts;
  const corner = matchWinnerCorner(winner, fighters);
  if (corner === "red") return { red: high, blue: low };
  if (corner === "blue") return { red: low, blue: high };
  return undefined;
}

/**
 * The running score through the boundary round. Prefers Sherdog's own
 * cumulativeScore when the latest bounded round carried one (parsed the same
 * corner-attributed way); otherwise sums every bounded round's own score,
 * since Sherdog doesn't always post a running cumulative each round.
 */
function runningScore(
  entries: readonly JudgeRoundEntry[],
  fighters: { red: string; blue: string },
): { red: number; blue: number } | undefined {
  const latest = entries.at(-1);
  if (latest?.card.cumulativeScore !== undefined) {
    const parsed = cornerScore(latest.card.cumulativeScore, latest.card.winner, fighters);
    if (parsed !== undefined) return parsed;
  }

  let red = 0;
  let blue = 0;
  let any = false;
  for (const entry of entries) {
    if (entry.card.roundScore === undefined) continue;
    const parsed = cornerScore(entry.card.roundScore, entry.card.winner, fighters);
    if (parsed === undefined) continue;
    red += parsed.red;
    blue += parsed.blue;
    any = true;
  }
  return any ? { red, blue } : undefined;
}

function groupByJudge(
  records: readonly CollectorUnifiedRound[],
  boutId: string,
): JudgeTotal[] {
  const roundsAscending = records
    .filter((record) => record.boutId === boutId && record.sherdog !== undefined)
    .sort((left, right) => left.round - right.round);

  const groups: JudgeTotal[] = [];
  const byScorer = new Map<string, JudgeTotal>();
  for (const record of roundsAscending) {
    for (const card of record.sherdog?.scorerCards ?? []) {
      if (!hasScore(card)) continue;
      let group = byScorer.get(card.scorer);
      if (group === undefined) {
        group = { scorer: card.scorer, entries: [] };
        byScorer.set(card.scorer, group);
        groups.push(group);
      }
      group.entries.push({ round: record.round, card });
    }
  }
  return groups;
}

function RoundChip({
  entry,
  fighters,
}: {
  entry: JudgeRoundEntry | undefined;
  fighters: { red: string; blue: string };
}) {
  if (entry?.card.roundScore === undefined) {
    return (
      <div className="scorecard-round-cell">
        <div className="scorecard-round-chip scorecard-round-chip-empty">—</div>
        <div className="scorecard-round-bar scorecard-round-bar-empty" />
      </div>
    );
  }

  const corner = matchWinnerCorner(entry.card.winner, fighters);
  const cornerModifier = corner ? ` scorecard-round-chip-${corner}` : "";
  const barModifier = corner ? ` scorecard-round-bar-${corner}` : "";
  return (
    <div className="scorecard-round-cell">
      <div
        className={`scorecard-round-chip num${cornerModifier}`}
        title={entry.card.roundScore}
      >
        {formatScore(entry.card.roundScore)}
      </div>
      <div className={`scorecard-round-bar${barModifier}`} />
    </div>
  );
}

export function ScorecardFeed({
  view,
  records = [],
  round,
  allRounds = false,
}: {
  view: BoutView;
  records?: readonly CollectorUnifiedRound[];
  round?: number;
  /** True when the round selector is set to "total" (through the last reported round). */
  allRounds?: boolean;
}) {
  const scorerProfiles = useSherdogScorerProfiles();
  const fighters = {
    red: view.bout.fighters.red.name,
    blue: view.bout.fighters.blue.name,
  };
  const scheduledRounds = view.bout.scheduledRounds ?? 3;

  const judges = groupByJudge(records, view.bout.id);
  if (judges.length === 0) return null;

  const boundary =
    round === undefined
      ? Math.max(0, ...judges.flatMap((judge) => judge.entries.map((entry) => entry.round)))
      : round;

  const rows = judges
    .map((judge) => {
      const boundedEntries = judge.entries.filter((entry) => entry.round <= boundary);
      if (boundedEntries.length === 0) return undefined;
      return { judge, boundedEntries };
    })
    .filter(
      (row): row is { judge: JudgeTotal; boundedEntries: JudgeRoundEntry[] } =>
        row !== undefined,
    );

  if (rows.length === 0) return null;

  return (
    <section
      className="panel scorecard-panel"
      aria-label={allRounds ? "Sherdog scorecards" : `Sherdog scorecards through round ${boundary}`}
    >
      <ul className="scorecard-list">
        {rows.map(({ judge, boundedEntries }) => {
          const totals = runningScore(boundedEntries, fighters);
          const winnerCorner =
            totals === undefined
              ? undefined
              : totals.red === totals.blue
                ? undefined
                : totals.red > totals.blue
                  ? "red"
                  : "blue";
          // Leader's number first, matching the "10-9" convention used for round scores.
          const totalsText =
            totals === undefined
              ? undefined
              : winnerCorner === "blue"
                ? `${totals.blue}-${totals.red}`
                : `${totals.red}-${totals.blue}`;
          return (
            <li className="scorecard-judge" key={judge.scorer}>
              <div className="scorecard-judge-header">
                <ScorerAvatar scorer={judge.scorer} profiles={scorerProfiles} />
                <strong className="scorecard-judge-name">{judge.scorer}</strong>
                {totalsText !== undefined && (
                  <span className="scorecard-judge-score num" title={totalsText}>
                    {formatScore(totalsText)}
                  </span>
                )}
                {winnerCorner !== undefined && (
                  <span className={`scorecard-judge-winner ${cornerClassName(winnerCorner)}`}>
                    {lastName(fighters[winnerCorner])}
                  </span>
                )}
              </div>
              <div
                className="scorecard-round-grid"
                style={{ gridTemplateColumns: `repeat(${scheduledRounds}, 1fr)` }}
              >
                {Array.from({ length: scheduledRounds }, (_, index) => {
                  const roundNumber = index + 1;
                  const entry =
                    roundNumber <= boundary
                      ? judge.entries.find((candidate) => candidate.round === roundNumber)
                      : undefined;
                  return (
                    <RoundChip key={roundNumber} entry={entry} fighters={fighters} />
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
