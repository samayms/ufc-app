/**
 * Hand-rolled useEffect + useState hooks over the ESPN future-schedule
 * source, matching the pattern in useDashboard.ts (no React Query/SWR in
 * this project). The source is created once at module scope so its TTL
 * cache is shared across every consumer and remount.
 */

import { useEffect, useState } from "react";
import {
  createEspnScheduleSource,
  type EspnScheduledCard,
  type EspnScheduledEventSummary,
} from "../sources/espnSchedule.ts";

// Exported so other hooks (e.g. useEventPhotos.ts) can reuse this exact
// instance and its TTL cache instead of standing up a second source with a
// cold cache.
export const scheduleSource = createEspnScheduleSource();

export interface UpcomingEspnEventsState {
  status: "loading" | "ready" | "error";
  events: EspnScheduledEventSummary[];
  message?: string;
  reload: () => void;
}

export function useUpcomingEspnEvents(): UpcomingEspnEventsState {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Omit<UpcomingEspnEventsState, "reload">>(
    { status: "loading", events: [] },
  );

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", events: [] });

    scheduleSource
      .listUpcomingEvents()
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
              : "The upcoming event list could not be loaded.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return { ...state, reload: () => setAttempt((current) => current + 1) };
}

export interface EspnCardState {
  status: "idle" | "loading" | "ready" | "error";
  card: EspnScheduledCard | null;
  message?: string;
}

export function useEspnCard(eventId: string | null): EspnCardState {
  const [state, setState] = useState<EspnCardState>({
    status: "idle",
    card: null,
  });

  useEffect(() => {
    if (!eventId) {
      setState({ status: "idle", card: null });
      return;
    }

    let cancelled = false;
    setState({ status: "loading", card: null });

    scheduleSource
      .getCard(eventId)
      .then((card) => {
        if (cancelled) return;
        setState({ status: "ready", card });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          card: null,
          message:
            error instanceof Error
              ? error.message
              : "The fight card could not be loaded.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [eventId]);

  return state;
}
