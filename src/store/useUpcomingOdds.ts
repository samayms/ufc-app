/**
 * Loads the upcoming-odds document the twice-daily sync writes.
 *
 * Plain fetch-and-poll rather than SSE on purpose. The collector's SSE channel
 * carries in-fight market ticks, which change by the second; upcoming odds
 * change twice a day. A refetch on an interval matches the data's actual
 * cadence, keeps the sync a standalone process the collector need not be
 * running for, and avoids a second live channel that would only ever be idle.
 *
 * The last good document is retained across a failed refetch. A network blip
 * must never blank a panel full of real prices — that is exactly the case the
 * per-provider `preserved` flag exists for, and it would be undone here by
 * dropping the whole document on error.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { collectorBaseUrl } from "./collectorClient.ts";
import type { UpcomingOddsDocument } from "../lib/upcomingOdds.ts";

export const UPCOMING_ODDS_REFRESH_MS = 5 * 60 * 1_000;

export interface UpcomingOddsState {
  status: "loading" | "ready" | "error";
  /** null once loaded means the sync has never run. */
  document: UpcomingOddsDocument | null;
  /** True when `document` predates a failed refetch. */
  stale: boolean;
  message?: string;
  reload: () => void;
}

export interface UseUpcomingOddsOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  refreshMs?: number;
}

function isDocument(value: unknown): value is UpcomingOddsDocument {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { events?: unknown }).events)
  );
}

export function upcomingOddsUrl(baseUrl?: string): string {
  return `${collectorBaseUrl(baseUrl)}/api/upcoming-odds`;
}

/**
 * Fetches and decodes the document. A 200 carrying `document: null` means the
 * sync has never run, which is a real state and not an error; anything the
 * decoder does not recognize as a v1 document is treated the same way rather
 * than half-rendered.
 */
export async function fetchUpcomingOddsDocument(
  url: string,
  fetchImpl: typeof fetch,
): Promise<UpcomingOddsDocument | null> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Collector responded ${response.status}`);
  }
  const payload = (await response.json()) as { document?: unknown };
  return isDocument(payload.document) ? payload.document : null;
}

/**
 * Folds one load attempt into the next state. Pure so the retain-on-failure
 * rule is testable without a renderer — it is the rule that keeps a network
 * blip from blanking a panel of real prices, and it is worth pinning down.
 */
export function resolveUpcomingOddsState(
  attempt:
    | { ok: true; document: UpcomingOddsDocument | null }
    | { ok: false; error: unknown },
  lastGood: UpcomingOddsDocument | null,
): Omit<UpcomingOddsState, "reload"> {
  if (attempt.ok) {
    return { status: "ready", document: attempt.document, stale: false };
  }
  return {
    status: lastGood === null ? "error" : "ready",
    document: lastGood,
    stale: lastGood !== null,
    message:
      attempt.error instanceof Error
        ? attempt.error.message
        : "Upcoming odds could not be loaded.",
  };
}

export function useUpcomingOdds(
  options: UseUpcomingOddsOptions = {},
): UpcomingOddsState {
  const [state, setState] = useState<Omit<UpcomingOddsState, "reload">>({
    status: "loading",
    document: null,
    stale: false,
  });
  const [attempt, setAttempt] = useState(0);
  // Kept in a ref so a failed refetch can retain the last good document
  // without making the fetch effect depend on the document it just set.
  const lastGood = useRef<UpcomingOddsDocument | null>(null);

  const baseUrl = options.baseUrl;
  const fetchImpl = options.fetchImpl;
  const refreshMs = options.refreshMs ?? UPCOMING_ODDS_REFRESH_MS;

  useEffect(() => {
    let cancelled = false;
    const resolvedFetch =
      fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init));
    const url = upcomingOddsUrl(baseUrl);

    const load = async (): Promise<void> => {
      try {
        const document = await fetchUpcomingOddsDocument(url, resolvedFetch);
        if (cancelled) return;
        lastGood.current = document;
        setState(resolveUpcomingOddsState({ ok: true, document }, document));
      } catch (error) {
        if (cancelled) return;
        setState(resolveUpcomingOddsState({ ok: false, error }, lastGood.current));
      }
    };

    void load();
    const handle = setInterval(() => void load(), refreshMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [attempt, baseUrl, fetchImpl, refreshMs]);

  const reload = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  return { ...state, reload };
}
