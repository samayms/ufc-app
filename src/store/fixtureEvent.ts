/**
 * Builds the canonical UfcEvent from src/fixtures/event.json. This is the
 * structural backbone (bouts + fighters) the dashboard renders; per-source
 * clients layer odds and round data on top of it. When live credentials
 * arrive, the ESPN/Cito clients replace this as the event source.
 */

import raw from "../fixtures/event.json";
import type {
  Bout,
  BoutResult,
  Corner,
  Fighter,
  UfcEvent,
} from "../schema/types.ts";

interface RawBout
  extends Omit<Bout, "fighters" | "result" | "weightClass" | "segment" | "status" | "scheduledRounds"> {
  fighterIds: Record<Corner, string>;
  weightClass: string;
  segment: string;
  status: string;
  scheduledRounds: number;
  result?: BoutResult;
}

export function loadFixtureEvent(): UfcEvent {
  const fighters = new Map<string, Fighter>(
    (raw.fighters as unknown as Fighter[]).map((f) => [f.id, f]),
  );

  const bouts: Bout[] = (raw.bouts as unknown as RawBout[]).map((b) => {
    const red = fighters.get(b.fighterIds.red);
    const blue = fighters.get(b.fighterIds.blue);
    if (!red || !blue) {
      throw new Error(`fixture bout ${b.id} references unknown fighter`);
    }
    const { fighterIds: _fighterIds, ...rest } = b;
    return {
      ...(rest as unknown as Omit<Bout, "fighters" | "provenance">),
      fighters: { red, blue },
      provenance: raw.event.provenance as Bout["provenance"],
    };
  });

  return {
    ...(raw.event as unknown as Omit<UfcEvent, "bouts">),
    bouts,
  };
}
