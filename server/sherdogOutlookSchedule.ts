export const OUTLOOK_WINDOW_LEAD_MS = 3 * 24 * 60 * 60 * 1000;
export const OUTLOOK_RETRY_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Ms until the discovery window opens (startsAt - 3 days); 0 if already open. */
export function msUntilOutlookWindowOpens(now: Date, startsAt: string): number {
  const opensAt = new Date(startsAt).getTime() - OUTLOOK_WINDOW_LEAD_MS;
  return Math.max(0, opensAt - now.getTime());
}

export function isOutlookWindowOpen(now: Date, startsAt: string): boolean {
  return msUntilOutlookWindowOpens(now, startsAt) <= 0;
}

export function hasEventStarted(now: Date, startsAt: string): boolean {
  return now.getTime() >= new Date(startsAt).getTime();
}
