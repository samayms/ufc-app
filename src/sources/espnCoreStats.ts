import type { EspnCumulativeStats } from "./espn.ts";

const CORE_BASE = "https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events";

export function buildEspnCoreStatsUrl(eventId: string, competitionId: string, athleteId: string): string {
  return `${CORE_BASE}/${encodeURIComponent(eventId)}/competitions/${encodeURIComponent(competitionId)}/competitors/${encodeURIComponent(athleteId)}/statistics`;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function empty(): EspnCumulativeStats {
  return { significantStrikesLanded: 0, significantStrikesAttempted: 0, totalStrikesLanded: 0, totalStrikesAttempted: 0, takedownsLanded: 0, takedownsAttempted: 0, submissionsAttempted: 0, reversals: 0, controlTimeSeconds: 0, knockdowns: 0, headStrikesLanded: 0, headStrikesAttempted: 0, bodyStrikesLanded: 0, bodyStrikesAttempted: 0, legStrikesLanded: 0, legStrikesAttempted: 0 };
}

const STAT_MAP: Readonly<Record<string, keyof EspnCumulativeStats>> = {
  sigstrikeslanded: "significantStrikesLanded", significantstrikeslanded: "significantStrikesLanded",
  sigstrikesattempted: "significantStrikesAttempted", significantstrikesattempted: "significantStrikesAttempted",
  totalstrikeslanded: "totalStrikesLanded", totalstrikesattempted: "totalStrikesAttempted",
  takedownslanded: "takedownsLanded", takedownsattempted: "takedownsAttempted",
  submissionattempts: "submissionsAttempted", submissionsattempted: "submissionsAttempted",
  reversals: "reversals", controltimeseconds: "controlTimeSeconds", controltime: "controlTimeSeconds",
  knockdowns: "knockdowns", headstrikeslanded: "headStrikesLanded", headstrikesattempted: "headStrikesAttempted",
  bodystrikeslanded: "bodyStrikesLanded", bodystrikesattempted: "bodyStrikesAttempted",
  legstrikeslanded: "legStrikesLanded", legstrikesattempted: "legStrikesAttempted",
};

/** Normalizes ESPN core's category/stat payload without depending on category labels. */
export function parseEspnCoreCumulativeStats(payload: unknown): EspnCumulativeStats {
  const result = empty();
  const root = payload as { splits?: { categories?: Array<{ stats?: Array<{ name?: string; value?: unknown }> }> } };
  for (const category of root.splits?.categories ?? []) for (const stat of category.stats ?? []) {
    const field = STAT_MAP[(stat.name ?? "").replace(/[^a-z]/gi, "").toLowerCase()];
    if (field !== undefined) result[field] = number(stat.value);
  }
  return result;
}

export async function fetchEspnCoreCumulativeStats(options: { eventId: string; competitionId: string; athleteId: string; fetchImpl?: typeof fetch }): Promise<EspnCumulativeStats> {
  const response = await (options.fetchImpl ?? fetch)(buildEspnCoreStatsUrl(options.eventId, options.competitionId, options.athleteId), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`ESPN core stats request failed with HTTP ${response.status}`);
  return parseEspnCoreCumulativeStats(await response.json());
}
