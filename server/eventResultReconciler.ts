/**
 * Repairs only the result fields of a persisted ESPN card. This deliberately
 * bypasses the general archive write guard: a missing result, or ESPN's
 * placeholder `other` method, is not a complete immutable record. Nothing
 * else about an archived event may be changed through this path.
 */
import { and, eq } from "drizzle-orm";

import type { AppDatabase } from "./db/client.ts";
import { bouts } from "./db/schema.ts";
import type { DashboardState } from "../src/schema.ts";

export interface EventResultReconciliation {
  examined: number;
  updatedBoutIds: string[];
}

export function reconcileEspnEventResults(
  db: AppDatabase,
  state: DashboardState,
  now: () => Date = () => new Date(),
): EventResultReconciliation {
  const updatedBoutIds: string[] = [];
  let examined = 0;

  for (const sourceBout of state.event.bouts) {
    const incoming = sourceBout.result;
    if (incoming === undefined) continue;
    examined += 1;
    const stored = db.select({
      resultWinnerCorner: bouts.resultWinnerCorner,
      resultMethod: bouts.resultMethod,
    }).from(bouts).where(and(
      eq(bouts.id, sourceBout.id),
      eq(bouts.eventId, state.event.id),
    )).get();
    if (stored === undefined) continue;

    const missingResult = stored.resultWinnerCorner === null;
    const incompleteMethod =
      stored.resultMethod === "other" && incoming.method !== "other";
    if (!missingResult && !incompleteMethod) continue;

    db.update(bouts).set({
      resultWinnerCorner: incoming.winner,
      resultMethod: incoming.method,
      resultRound: incoming.round ?? null,
      resultTime: incoming.time ?? null,
      updatedAt: now().toISOString(),
    }).where(and(
      eq(bouts.id, sourceBout.id),
      eq(bouts.eventId, state.event.id),
    )).run();
    updatedBoutIds.push(sourceBout.id);
  }

  return { examined, updatedBoutIds };
}
