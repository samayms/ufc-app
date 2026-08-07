/**
 * Client-side access to the permanently-archived event history served by
 * GET /api/events and GET /api/events/:id (server/collector.ts). Matches the
 * hand-rolled useEffect + useState pattern used by useEspnSchedule.ts and
 * useUpcomingOdds.ts (no React Query/SWR in this project): a pure fetch
 * function that is unit-testable without a renderer, plus a thin hook that
 * folds it into loading/ready/error state.
 */

import { useEffect, useState } from "react";
import type { DashboardState } from "../schema.ts";

// Mirrors the server's ArchivedEventSummary shape (server/collector.ts).
// Redeclared here rather than imported so client code never depends on
// server code.
export interface ArchivedEventSummary {
  id: string;
  name: string;
  startsAt: string;
  archivedAt: string;
}

export interface ArchivedEventsState {
  status: "loading" | "ready" | "error";
  events: ArchivedEventSummary[];
  message?: string;
  reload: () => void;
}

/**
 * Fetches and decodes the archived-event list. Pure so the decoding/error
 * behavior is testable without a renderer.
 */
export async function fetchArchivedEvents(
  fetchImpl: typeof fetch = fetch,
): Promise<ArchivedEventSummary[]> {
  const response = await fetchImpl("/api/events");
  if (!response.ok) {
    throw new Error(`archived events request failed: ${response.status}`);
  }
  return (await response.json()) as ArchivedEventSummary[];
}

export function useArchivedEvents(): ArchivedEventsState {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Omit<ArchivedEventsState, "reload">>({
    status: "loading",
    events: [],
  });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", events: [] });

    fetchArchivedEvents()
      .then((events) => {
        if (cancelled) return;
        setState({ status: "ready", events });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          events: [],
          message:
            error instanceof Error
              ? error.message
              : "The archived event list could not be loaded.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return { ...state, reload: () => setAttempt((current) => current + 1) };
}

export interface ArchivedEventState {
  status: "idle" | "loading" | "ready" | "error";
  data: DashboardState | null;
  message?: string;
}

/**
 * Fetches and decodes a single archived event's DashboardState. Pure for the
 * same reason as fetchArchivedEvents above.
 */
export async function fetchArchivedEvent(
  eventId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DashboardState> {
  const response = await fetchImpl(`/api/events/${encodeURIComponent(eventId)}`);
  if (!response.ok) {
    throw new Error(`archived event request failed: ${response.status}`);
  }
  return (await response.json()) as DashboardState;
}

export function useArchivedEvent(eventId: string | null): ArchivedEventState {
  const [state, setState] = useState<ArchivedEventState>({
    status: "idle",
    data: null,
  });

  useEffect(() => {
    if (eventId === null) {
      setState({ status: "idle", data: null });
      return;
    }

    let cancelled = false;
    setState({ status: "loading", data: null });

    fetchArchivedEvent(eventId)
      .then((data) => {
        if (cancelled) return;
        setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          data: null,
          message:
            error instanceof Error
              ? error.message
              : "The archived event could not be loaded.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [eventId]);

  return state;
}
