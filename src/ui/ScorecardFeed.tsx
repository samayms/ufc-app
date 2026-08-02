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

/** "10-9" (or an en/em dash, or already-spaced) -> "10 - 9" for display. */
function formatScore(score: string): string {
  return score.trim().replace(/\s*[-–—]\s*/u, " - ");
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

/**
 * Finds the run of words in `fullName` (diacritics intact) that normalizes to
 * `token`. Tries the trailing N words first, where N is the token's own word
 * count — this is right for both single names ("Rakic" -> "Rakić") and
 * multi-word surnames ("Machado Garry" -> "Machado Garry" out of "Ian
 * Machado Garry"). Falls back to scanning every contiguous window, then to
 * the bare last name if nothing normalizes to an exact match.
 */
function bestNameMatch(token: string, fullName: string): string {
  const words = fullName.split(/\s+/).filter((word) => word.length > 0);
  const tokenWordCount = token.split(/\s+/).filter((word) => word.length > 0).length;

  if (tokenWordCount > 0 && tokenWordCount <= words.length) {
    const suffix = words.slice(words.length - tokenWordCount).join(" ");
    if (normalizeNameToken(suffix) === token) return suffix;
  }

  for (let start = 0; start < words.length; start += 1) {
    for (let length = 1; start + length <= words.length; length += 1) {
      const candidate = words.slice(start, start + length).join(" ");
      if (normalizeNameToken(candidate) === token) return candidate;
    }
  }

  return words.at(-1) ?? fullName;
}

/**
 * Sherdog's `winner` string is the diacritic-stripped spelling; the fighter's
 * own name in bout data carries the real accents ("Rakić", "Medić"). Once a
 * corner is matched, display that fighter's own spelling instead of
 * Sherdog's token. Unmatched names have no corner to borrow a spelling from,
 * so they render as-is.
 */
function resolveWinnerDisplay(
  winner: string,
  fighters: { red: string; blue: string },
): { text: string; corner: "red" | "blue" | undefined } {
  const corner = matchWinnerCorner(winner, fighters);
  if (corner === undefined) return { text: winner, corner: undefined };
  return { text: bestNameMatch(normalizeNameToken(winner), fighters[corner]), corner };
}

function WinnerName({
  name,
  fighters,
}: {
  name: string;
  fighters: { red: string; blue: string };
}) {
  const { text, corner } = resolveWinnerDisplay(name, fighters);
  const className = ["scorecard-judge-winner", cornerClassName(corner)]
    .filter(Boolean)
    .join(" ");
  return <span className={className}>{text}</span>;
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
      const latest = boundedEntries.at(-1);
      if (latest === undefined) return undefined;
      return { judge, latest };
    })
    .filter((row): row is { judge: JudgeTotal; latest: JudgeRoundEntry } => row !== undefined);

  if (rows.length === 0) return null;

  return (
    <section
      className="panel scorecard-panel"
      aria-label={allRounds ? "Sherdog scorecards" : `Sherdog scorecards through round ${boundary}`}
    >
      <ul className="scorecard-list">
        {rows.map(({ judge, latest }) => {
          const bigScore = latest.card.cumulativeScore ?? latest.card.roundScore;
          return (
            <li className="scorecard-judge" key={judge.scorer}>
              <div className="scorecard-judge-header">
                <ScorerAvatar scorer={judge.scorer} profiles={scorerProfiles} />
                <strong className="scorecard-judge-name">{judge.scorer}</strong>
                {bigScore !== undefined && (
                  <span className="scorecard-judge-score num" title={bigScore}>
                    {formatScore(bigScore)}
                  </span>
                )}
                {latest.card.winner && (
                  <WinnerName name={latest.card.winner} fighters={fighters} />
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
