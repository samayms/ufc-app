/**
 * Upcoming-odds sync scheduler.
 *
 * Fires the same `runUpcomingSync` used by `npm run sync:upcoming:live` at
 * 6:00a and 6:00p America/New_York, records every execution (scheduled,
 * startup catch-up, or manual) in `sync_runs`, detects on startup whether
 * the Machine missed its last scheduled slot while restarting/deploying
 * and — if so — runs one catch-up sync, and refuses to start a run while
 * one is already in flight.
 */

import { eq } from "drizzle-orm";

import { getDb, type AppDatabase } from "./db/client.ts";
import { syncRuns } from "./db/schema.ts";
import { runUpcomingSync, type RunSyncResult } from "./syncUpcoming.ts";

export const SCHEDULE_TIME_ZONE = "America/New_York";
export const SCHEDULE_HOURS = [6, 18] as const;

/** A run stuck in "running" longer than this is treated as crashed, not in flight. */
const STALE_RUN_MS = 30 * 60 * 1000;

export type SyncRunKind = "scheduled" | "catchup" | "manual";

function getOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const offsetLabel =
    parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+0";
  const match = /GMT([+-]\d+)(?::(\d+))?/u.exec(offsetLabel);
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  return hours * 60 + (hours < 0 ? -minutes : minutes);
}

function getZonedDateParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offsetMinutes = getOffsetMinutes(new Date(guess), timeZone);
  return new Date(guess - offsetMinutes * 60_000);
}

/** "YYYY-MM-DD" wall-clock date for `date` in `timeZone`, for same-day comparisons. */
export function zonedCalendarDate(
  date: Date,
  timeZone: string = SCHEDULE_TIME_ZONE,
): string {
  const { year, month, day } = getZonedDateParts(date, timeZone);
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

/** Every scheduled slot within [-1, +2] days of `now`, sorted ascending. */
export function scheduleSlotsAround(
  now: Date,
  timeZone: string = SCHEDULE_TIME_ZONE,
): Date[] {
  const { year, month, day } = getZonedDateParts(now, timeZone);
  const baseUtcMidnight = Date.UTC(year, month - 1, day);
  const slots: Date[] = [];

  for (let dayOffset = -1; dayOffset <= 2; dayOffset += 1) {
    const probe = new Date(baseUtcMidnight + dayOffset * 86_400_000);
    const zoned = getZonedDateParts(probe, timeZone);
    for (const hour of SCHEDULE_HOURS) {
      slots.push(
        zonedWallTimeToUtc(zoned.year, zoned.month, zoned.day, hour, 0, timeZone),
      );
    }
  }

  return slots.sort((a, b) => a.getTime() - b.getTime());
}

export function mostRecentSlotAtOrBefore(
  now: Date,
  timeZone: string = SCHEDULE_TIME_ZONE,
): Date {
  const past = scheduleSlotsAround(now, timeZone).filter(
    (slot) => slot.getTime() <= now.getTime(),
  );
  const slot = past.at(-1);
  if (!slot) throw new Error("No scheduled slot found at or before now");
  return slot;
}

export function nextSlotAfter(
  now: Date,
  timeZone: string = SCHEDULE_TIME_ZONE,
): Date {
  const future = scheduleSlotsAround(now, timeZone).filter(
    (slot) => slot.getTime() > now.getTime(),
  );
  const slot = future[0];
  if (!slot) throw new Error("No scheduled slot found after now");
  return slot;
}

export interface UpcomingSchedulerOptions {
  db?: AppDatabase;
  /** Injectable for tests; defaults to the real network-hitting sync. */
  sync?: (env?: NodeJS.ProcessEnv) => Promise<RunSyncResult>;
  now?: () => Date;
  timeZone?: string;
  env?: NodeJS.ProcessEnv;
  onLog?: (message: string) => void;
}

export class UpcomingScheduler {
  private readonly db: AppDatabase;
  private readonly sync: (env?: NodeJS.ProcessEnv) => Promise<RunSyncResult>;
  private readonly now: () => Date;
  private readonly timeZone: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (message: string) => void;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(options: UpcomingSchedulerOptions = {}) {
    this.db = options.db ?? getDb();
    this.sync = options.sync ?? runUpcomingSync;
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone ?? SCHEDULE_TIME_ZONE;
    this.env = options.env ?? process.env;
    this.log = options.onLog ?? ((message) => console.log(`[scheduler] ${message}`));
  }

  /** True while a run is in flight in this process, or a crashed run is still marked "running". */
  isRunInFlight(): boolean {
    if (this.running) return true;
    const stale = this.now().getTime() - STALE_RUN_MS;
    const row = this.db
      .select({ startedAt: syncRuns.startedAt })
      .from(syncRuns)
      .where(eq(syncRuns.status, "running"))
      .all()
      .find((candidate) => new Date(candidate.startedAt).getTime() >= stale);
    return row !== undefined;
  }

  /** Runs `sync` exactly once, recording the attempt in `sync_runs`. No-op (returns null) if a run is already in flight. */
  async runOnce(
    kind: SyncRunKind,
    scheduledFor?: Date,
  ): Promise<RunSyncResult | null> {
    if (this.isRunInFlight()) {
      this.log(`skipped ${kind} run — another sync is already in flight`);
      return null;
    }

    this.running = true;
    const startedAt = this.now().toISOString();
    const inserted = this.db
      .insert(syncRuns)
      .values({
        kind,
        status: "running",
        scheduledFor: scheduledFor?.toISOString() ?? null,
        startedAt,
      })
      .returning({ id: syncRuns.id })
      .get();

    try {
      const result = await this.sync(this.env);
      this.db
        .update(syncRuns)
        .set({ status: "success", finishedAt: this.now().toISOString() })
        .where(eq(syncRuns.id, inserted.id))
        .run();
      this.log(
        `${kind} run #${inserted.id} succeeded — ${result.cards} card(s), ${result.bouts} bout(s)`,
      );
      return result;
    } catch (error) {
      this.db
        .update(syncRuns)
        .set({
          status: "failure",
          finishedAt: this.now().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        })
        .where(eq(syncRuns.id, inserted.id))
        .run();
      this.log(
        `${kind} run #${inserted.id} failed — ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    } finally {
      this.running = false;
    }
  }

  /** Whether the most recent scheduled slot at-or-before now has no successful run recorded against it. */
  missedMostRecentSlot(): { missed: boolean; slot: Date } {
    const slot = mostRecentSlotAtOrBefore(this.now(), this.timeZone);
    const succeeded = this.db
      .select({ status: syncRuns.status })
      .from(syncRuns)
      .where(eq(syncRuns.scheduledFor, slot.toISOString()))
      .all()
      .some((row) => row.status === "success");
    return { missed: !succeeded, slot };
  }

  /** Call once at startup. Runs a catch-up sync if the last scheduled slot has no successful run. */
  async catchUpIfNeeded(): Promise<RunSyncResult | null> {
    const { missed, slot } = this.missedMostRecentSlot();
    if (!missed) {
      this.log(`most recent slot (${slot.toISOString()}) already synced — no catch-up needed`);
      return null;
    }
    this.log(`most recent slot (${slot.toISOString()}) was missed — running catch-up sync`);
    return this.runOnce("catchup", slot);
  }

  /** Schedules the next 6a/6p run and reschedules itself after each attempt. */
  start(): void {
    this.scheduleNext();
  }

  private scheduleNext(): void {
    const target = nextSlotAfter(this.now(), this.timeZone);
    const delay = Math.max(0, target.getTime() - this.now().getTime());
    this.timer = setTimeout(() => {
      void this.runOnce("scheduled", target)
        .catch(() => {
          // Failure already recorded in sync_runs; keep the schedule alive.
        })
        .finally(() => {
          this.scheduleNext();
        });
    }, delay);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
