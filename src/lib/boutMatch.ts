/**
 * The single bout matcher every provider goes through.
 *
 * Kalshi, Polymarket, Odds-API.io and The Odds API all publish a fight as a
 * pair of free-text fighter names plus (usually) a start time. None of them
 * share ESPN's bout ids, none of them agree on corner order, and each one
 * spells a name slightly differently. Rather than let every provider grow its
 * own ad-hoc matching, all of them call `matchBout` here, so a fix to name
 * handling fixes every provider at once.
 *
 * The rules, in the order they bind:
 *
 * 1. A manual override for the discovered market's external id wins outright
 *    (confidence 1) — the owner's judgement is never second-guessed.
 * 2. Promotion mismatch (e.g. a Bellator card leaking into a UFC feed) is a
 *    hard reject, not a penalty.
 * 3. Event-date mismatch beyond the window is a hard reject. Providers list
 *    rematches with identical names months apart; the date is the only thing
 *    that separates them.
 * 4. Names are compared both ways round (red/blue vs blue/red) after alias
 *    canonicalization; the better orientation wins and reports
 *    `cornersReversed` so callers can flip the quotes rather than silently
 *    attaching them to the wrong fighter.
 * 5. Weight class, when both sides know it, nudges the score.
 *
 * A result is only `matched` when it clears the confidence threshold *and*
 * beats the runner-up by more than `ambiguityMargin`. Two plausible bouts
 * produce `ambiguous`, which callers surface as `unmatched` in the UI. Odds
 * are never attached on a coin flip.
 */

/** Default score a candidate must reach before it is considered a match. */
export const DEFAULT_MATCH_CONFIDENCE_THRESHOLD = 0.85;

/**
 * How far ahead of the runner-up the best candidate must be. Two bouts on the
 * same card scoring within this margin of each other are ambiguous, not a
 * match — usually a rematch or two brothers on the same card.
 */
export const DEFAULT_AMBIGUITY_MARGIN = 0.02;

/** How far a provider's listed start time may drift from ESPN's, in ms. */
export const DEFAULT_EVENT_DATE_WINDOW_MS = 36 * 60 * 60 * 1_000;

/**
 * Names that are the same human but never spelled the same way across
 * providers. Kept deliberately tiny and hand-audited: an alias is a claim
 * that two strings are one person, and a wrong entry silently mis-attaches
 * money-carrying odds. Each group is a set of equivalent spellings; the first
 * entry is the canonical form used for display only.
 */
export const DEFAULT_FIGHTER_ALIASES: readonly (readonly string[])[] = [
  // Required by the dashboard owner: Kalshi and several sportsbooks list him
  // as "Ian Garry", ESPN and Polymarket as "Ian Machado Garry".
  ["Ian Machado Garry", "Ian Garry"],
  ["Alexandre Pantoja", "Alex Pantoja"],
  ["Jose Aldo", "Jose Aldo Junior"],
  ["Rafael dos Anjos", "Rafael Dos Anjos", "RDA"],
  ["Marlon Vera", "Marlon Chito Vera"],
  ["Bryce Mitchell", "Bryce Thug Nasty Mitchell"],
];

export interface MatchableBout {
  boutId: string;
  redFighter: string;
  blueFighter: string;
  /** ISO 8601 start of the bout's event, when known. */
  startsAt?: string;
  weightClass?: string;
  /** Lowercase promotion slug, e.g. "ufc". */
  promotion?: string;
}

export interface DiscoveredBout {
  redFighter: string;
  blueFighter: string;
  startsAt?: string;
  weightClass?: string;
  promotion?: string;
}

export interface BoutMatchCandidate {
  boutId: string;
  confidence: number;
  cornersReversed: boolean;
}

export type BoutMatchResult =
  | {
      status: "matched";
      boutId: string;
      confidence: number;
      cornersReversed: boolean;
      /** True when a manual override decided this, not name scoring. */
      manual: boolean;
      candidates: BoutMatchCandidate[];
    }
  | { status: "ambiguous"; candidates: BoutMatchCandidate[] }
  | { status: "unmatched"; candidates: BoutMatchCandidate[] };

export interface BoutMatchOptions {
  /** Bout id an operator pinned this exact market to. Wins outright. */
  overrideBoutId?: string;
  confidenceThreshold?: number;
  ambiguityMargin?: number;
  eventDateWindowMs?: number;
  aliases?: readonly (readonly string[])[];
}

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

const NAME_NOISE_TOKENS: ReadonlySet<string> = new Set([
  "jr",
  "sr",
  "ii",
  "iii",
  "iv",
]);

/** Splits a name into lowercase, accent-free, punctuation-free tokens. */
export function fighterNameTokens(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/['’]/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0 && !NAME_NOISE_TOKENS.has(token));
}

/**
 * Canonical comparison key for a fighter name. Tokens are sorted so that
 * "Garry, Ian" and "Ian Garry" collapse to the same string — providers are
 * inconsistent about ordering, and no MMA name's meaning depends on it.
 */
export function normalizeFighterName(name: string): string {
  return fighterNameTokens(name).sort().join(" ");
}

function buildAliasIndex(
  groups: readonly (readonly string[])[],
): Map<string, string> {
  const index = new Map<string, string>();
  for (const group of groups) {
    const canonical = group[0];
    if (canonical === undefined) continue;
    const canonicalKey = normalizeFighterName(canonical);
    if (canonicalKey.length === 0) continue;
    for (const spelling of group) {
      const key = normalizeFighterName(spelling);
      if (key.length > 0) index.set(key, canonicalKey);
    }
  }
  return index;
}

const DEFAULT_ALIAS_INDEX = buildAliasIndex(DEFAULT_FIGHTER_ALIASES);

function aliasIndexFor(
  aliases: readonly (readonly string[])[] | undefined,
): Map<string, string> {
  return aliases === undefined ? DEFAULT_ALIAS_INDEX : buildAliasIndex(aliases);
}

/** Resolves a name to its alias-canonical normalized key. */
export function canonicalFighterKey(
  name: string,
  aliasIndex: Map<string, string> = DEFAULT_ALIAS_INDEX,
): string {
  const key = normalizeFighterName(name);
  return aliasIndex.get(key) ?? key;
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from(
    { length: right.length + 1 },
    (_value, index) => index,
  );

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const insertion = (current[rightIndex - 1] ?? 0) + 1;
      const deletion = (previous[rightIndex] ?? 0) + 1;
      const substitution =
        (previous[rightIndex - 1] ?? 0) +
        (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(insertion, deletion, substitution);
    }
    previous = current;
  }

  return previous[right.length] ?? Math.max(left.length, right.length);
}

/**
 * Similarity of two fighter names in [0,1].
 *
 * Beyond edit distance there is one structural rule: when the shorter name's
 * tokens are all present in the longer name's, they are the same fighter with
 * a dropped middle or family name ("Ian Garry" ⊂ "Ian Machado Garry"). That
 * rule needs at least two tokens on the short side, otherwise every "Silva"
 * would match every other Silva.
 */
export function fighterNameSimilarity(
  left: string,
  right: string,
  aliasIndex: Map<string, string> = DEFAULT_ALIAS_INDEX,
): number {
  const leftKey = canonicalFighterKey(left, aliasIndex);
  const rightKey = canonicalFighterKey(right, aliasIndex);
  if (leftKey.length === 0 || rightKey.length === 0) return 0;
  if (leftKey === rightKey) return 1;

  const leftTokens = new Set(leftKey.split(" "));
  const rightTokens = new Set(rightKey.split(" "));
  const [smaller, larger] =
    leftTokens.size <= rightTokens.size
      ? [leftTokens, rightTokens]
      : [rightTokens, leftTokens];
  if (
    smaller.size >= 2 &&
    [...smaller].every((token) => larger.has(token))
  ) {
    return 0.97;
  }

  const length = Math.max(leftKey.length, rightKey.length);
  return Math.max(0, 1 - levenshteinDistance(leftKey, rightKey) / length);
}

export function roundConfidence(confidence: number): number {
  return Math.round(Math.max(0, Math.min(1, confidence)) * 1_000) / 1_000;
}

// ---------------------------------------------------------------------------
// Pair scoring
// ---------------------------------------------------------------------------

export interface FighterPairMatch {
  confidence: number;
  cornersReversed: boolean;
}

/**
 * Scores two fighter pairs without assuming either source preserves red/blue
 * corner order. The reversed orientation only wins when it scores strictly
 * higher, so an exact-order tie keeps the corners as given.
 */
export function matchFighterPair(
  known: Pick<MatchableBout, "redFighter" | "blueFighter">,
  discovered: Pick<DiscoveredBout, "redFighter" | "blueFighter">,
  aliasIndex: Map<string, string> = DEFAULT_ALIAS_INDEX,
): FighterPairMatch {
  const direct =
    (fighterNameSimilarity(
      known.redFighter,
      discovered.redFighter,
      aliasIndex,
    ) +
      fighterNameSimilarity(
        known.blueFighter,
        discovered.blueFighter,
        aliasIndex,
      )) /
    2;
  const reversed =
    (fighterNameSimilarity(
      known.redFighter,
      discovered.blueFighter,
      aliasIndex,
    ) +
      fighterNameSimilarity(
        known.blueFighter,
        discovered.redFighter,
        aliasIndex,
      )) /
    2;

  return {
    confidence: roundConfidence(Math.max(direct, reversed)),
    cornersReversed: reversed > direct,
  };
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeWeightClass(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized.length === 0 ? undefined : normalized;
}

function normalizePromotion(value: string | undefined): string | undefined {
  const normalized = value?.toLocaleLowerCase("en-US").trim();
  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}

/**
 * Scores one known bout against one discovered market. Returns `null` for a
 * hard reject (wrong promotion, or an event date outside the window), which
 * keeps impossible candidates out of the ambiguity comparison entirely
 * instead of letting a high name score drag them back in.
 */
export function scoreBoutCandidate(
  known: MatchableBout,
  discovered: DiscoveredBout,
  options: BoutMatchOptions = {},
): BoutMatchCandidate | null {
  const aliasIndex = aliasIndexFor(options.aliases);
  const knownPromotion = normalizePromotion(known.promotion);
  const discoveredPromotion = normalizePromotion(discovered.promotion);
  if (
    knownPromotion !== undefined &&
    discoveredPromotion !== undefined &&
    knownPromotion !== discoveredPromotion
  ) {
    return null;
  }

  const windowMs =
    options.eventDateWindowMs ?? DEFAULT_EVENT_DATE_WINDOW_MS;
  const knownTime = parseTime(known.startsAt);
  const discoveredTime = parseTime(discovered.startsAt);
  const bothTimed = knownTime !== undefined && discoveredTime !== undefined;
  if (bothTimed && Math.abs(knownTime - discoveredTime) > windowMs) {
    return null;
  }

  const pair = matchFighterPair(known, discovered, aliasIndex);
  if (pair.confidence <= 0) {
    return {
      boutId: known.boutId,
      confidence: 0,
      cornersReversed: false,
    };
  }

  // Corroborating signals can only ever move a name score by a few points:
  // they break ties between near-identical candidates, they never turn a bad
  // name match into a good one.
  let confidence = pair.confidence;
  if (bothTimed) confidence += 0.02;

  const knownWeight = normalizeWeightClass(known.weightClass);
  const discoveredWeight = normalizeWeightClass(discovered.weightClass);
  if (knownWeight !== undefined && discoveredWeight !== undefined) {
    confidence += knownWeight === discoveredWeight ? 0.02 : -0.1;
  }

  return {
    boutId: known.boutId,
    confidence: roundConfidence(confidence),
    cornersReversed: pair.cornersReversed,
  };
}

/**
 * Matches one discovered provider market against the known bouts of a card.
 * Candidates are always returned (best first) so callers can persist why a
 * market went unmatched instead of just recording that it did.
 */
export function matchBout(
  knownBouts: readonly MatchableBout[],
  discovered: DiscoveredBout,
  options: BoutMatchOptions = {},
): BoutMatchResult {
  const threshold =
    options.confidenceThreshold ?? DEFAULT_MATCH_CONFIDENCE_THRESHOLD;
  const margin = options.ambiguityMargin ?? DEFAULT_AMBIGUITY_MARGIN;

  if (options.overrideBoutId !== undefined) {
    const target = knownBouts.find(
      (bout) => bout.boutId === options.overrideBoutId,
    );
    if (target !== undefined) {
      const scored = scoreBoutCandidate(target, discovered, options);
      return {
        status: "matched",
        boutId: target.boutId,
        confidence: 1,
        cornersReversed: scored?.cornersReversed ?? false,
        manual: true,
        candidates: [
          { boutId: target.boutId, confidence: 1, cornersReversed: scored?.cornersReversed ?? false },
        ],
      };
    }
  }

  const candidates = knownBouts
    .flatMap((bout) => {
      const scored = scoreBoutCandidate(bout, discovered, options);
      return scored === null ? [] : [scored];
    })
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.boutId.localeCompare(right.boutId),
    );

  const best = candidates[0];
  if (best === undefined || best.confidence < threshold) {
    return { status: "unmatched", candidates };
  }

  const runnerUp = candidates[1];
  if (
    runnerUp !== undefined &&
    runnerUp.confidence >= threshold &&
    best.confidence - runnerUp.confidence <= margin
  ) {
    return { status: "ambiguous", candidates };
  }

  return {
    status: "matched",
    boutId: best.boutId,
    confidence: best.confidence,
    cornersReversed: best.cornersReversed,
    manual: false,
    candidates,
  };
}
