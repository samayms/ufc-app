/** Safely enrich result fields for one or more persisted ESPN event ids. */
import { closeDb, getDb } from "./db/client.ts";
import { reconcileEspnEventResults } from "./eventResultReconciler.ts";
import { loadEspnEventState } from "./liveEventState.ts";

const eventIds = process.argv.slice(2).filter((value) => value.trim().length > 0);

if (eventIds.length === 0) {
  throw new Error("Usage: node server/reconcileEspnResults.ts <espn-event-id> [...]");
}

try {
  for (const eventId of eventIds) {
    const state = await loadEspnEventState(eventId);
    if (state === undefined) {
      console.warn(`ESPN card ${eventId} was unavailable; no database rows changed.`);
      continue;
    }
    const result = reconcileEspnEventResults(getDb(), state);
    console.log(
      `ESPN result reconciliation ${eventId}: ${result.updatedBoutIds.length} updated (${result.updatedBoutIds.join(", ") || "none"}).`,
    );
  }
} finally {
  closeDb();
}
