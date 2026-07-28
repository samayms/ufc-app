/**
 * Fighter-photo lookup layer built on top of the ESPN schedule source:
 * finding a card's main event, batch-fetching photos for the upcoming
 * events list, and mapping the app's own current-event fighters onto their
 * ESPN headshots.
 */

import { useEffect, useState } from "react";
import type { ExternalRef, UfcEvent } from "../schema.ts";
import {
  scheduleSource,
  useEspnCard,
} from "./useEspnSchedule.ts";
import type {
  EspnScheduledCard,
  EspnScheduledEventSummary,
  EspnScheduledFight,
  EspnScheduledFighter,
} from "../sources/espnSchedule.ts";

/**
 * Finds the card's main event fight. Falls back to the first main-card
 * fight, then the first fight in the first non-empty section, in case
 * ESPN's payload never marks a fight `mainEvent: true`. Never throws.
 */
export function pickMainEventFight(
  card: EspnScheduledCard,
): EspnScheduledFight | undefined {
  for (const section of card.sections) {
    for (const fight of section.fights) {
      if (fight.mainEvent) return fight;
    }
  }

  const mainCardSection = card.sections.find(
    (section) => section.segment === "main-card",
  );
  if (mainCardSection && mainCardSection.fights.length > 0) {
    return mainCardSection.fights[0];
  }

  for (const section of card.sections) {
    if (section.fights.length > 0) return section.fights[0];
  }

  return undefined;
}

export interface MainEventCorners {
  red?: EspnScheduledFighter;
  blue?: EspnScheduledFighter;
}

/**
 * Batch-fetches the main-event photo for every event in `events`. Uses the
 * shared `scheduleSource` singleton (see useEspnSchedule.ts) so its per-id
 * TTL cache is reused rather than refetched. Events that are still loading,
 * failed, or have no discoverable main event are simply absent from the
 * returned map — callers treat "missing key" as the loading/unavailable
 * state rather than checking for `undefined` fields.
 */
export function useUpcomingEventPhotos(
  events: EspnScheduledEventSummary[],
): Record<string, MainEventCorners> {
  const [photosByEventId, setPhotosByEventId] = useState<
    Record<string, MainEventCorners>
  >({});

  // Derived key so the effect only re-runs when the actual set of event ids
  // changes, not on every render where `events` is a new array reference
  // with the same contents.
  const eventIdsKey = events.map((event) => event.eventId).join(",");

  useEffect(() => {
    let cancelled = false;
    const eventIds = eventIdsKey.length === 0 ? [] : eventIdsKey.split(",");

    if (eventIds.length === 0) {
      setPhotosByEventId({});
      return;
    }

    Promise.all(
      eventIds.map(async (eventId) => {
        try {
          const card = await scheduleSource.getCard(eventId);
          if (card === null) return undefined;
          const mainEvent = pickMainEventFight(card);
          if (mainEvent === undefined) return undefined;
          return [eventId, { red: mainEvent.red, blue: mainEvent.blue }] as const;
        } catch {
          return undefined;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, MainEventCorners> = {};
      for (const entry of entries) {
        if (entry === undefined) continue;
        const [eventId, corners] = entry;
        next[eventId] = corners;
      }
      setPhotosByEventId(next);
    });

    return () => {
      cancelled = true;
    };
  }, [eventIdsKey]);

  return photosByEventId;
}

/** Extracts a Fighter's ESPN athlete id from its external refs, if any. */
export function fighterEspnAthleteId(
  externalRefs: ExternalRef[],
): string | undefined {
  return externalRefs.find((ref) => ref.source === "espn")?.id;
}

function espnEventIdFor(event: UfcEvent | undefined): string | null {
  if (event === undefined) return null;
  const ref = event.externalRefs.find((entry) => entry.source === "espn");
  return ref?.id ?? null;
}

/**
 * Maps every fighter on the current event's ESPN card (every section, not
 * just the main event — this app wants best-effort photos for the whole
 * card) to their headshot URL, keyed by ESPN athlete id. Returns `{}` while
 * loading, on error, or if the event carries no ESPN external ref. Look up
 * a `Fighter`'s key in the result with `fighterEspnAthleteId(fighter.externalRefs)`.
 */
export function useCurrentEventAthletePhotos(
  event: UfcEvent | undefined,
): Record<string, string> {
  const espnEventId = espnEventIdFor(event);
  const cardState = useEspnCard(espnEventId);

  if (espnEventId === null || cardState.status !== "ready" || cardState.card === null) {
    return {};
  }

  const photosByAthleteId: Record<string, string> = {};
  for (const section of cardState.card.sections) {
    for (const fight of section.fights) {
      for (const fighter of [fight.red, fight.blue]) {
        if (fighter.athleteId === undefined || fighter.headshotUrl === undefined) {
          continue;
        }
        photosByAthleteId[fighter.athleteId] = fighter.headshotUrl;
      }
    }
  }
  return photosByAthleteId;
}
