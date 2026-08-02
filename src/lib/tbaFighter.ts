/**
 * A bout side ESPN hasn't named yet. Its fightcenter payload fills both name
 * fields rather than leaving them blank, so an unannounced fighter arrives as
 * "TBA TBA" (both slots) or "Opponent TBA" (a placeholder first name) — which
 * the ordinary first-name/last-name split then renders as two stacked lines
 * of nothing, e.g. "Opponent" above "TBA".
 */
export function isTbaFighter(name: string | undefined): boolean {
  return name !== undefined && /\bTBA\b/i.test(name);
}

/**
 * What to actually show for a fighter: their name, or the bare "TBA" for an
 * unannounced one — never ESPN's "Opponent"/"TBA" filler as a first name.
 */
export function fighterDisplayName(name: string): string {
  return isTbaFighter(name) ? "TBA" : name;
}

/**
 * Whether a matchup is still missing a fighter, in which case there is no
 * fight to open: no tale of the tape, no odds, no record — a screen of
 * dashes. Either side being unannounced is enough, since the comparison such
 * a screen exists to show needs both.
 */
export function isTbaMatchup(
  redName: string | undefined,
  blueName: string | undefined,
): boolean {
  return isTbaFighter(redName) || isTbaFighter(blueName);
}
