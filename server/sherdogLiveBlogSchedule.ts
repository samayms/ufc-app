import {
  discoverSherdogLiveBlog,
  type DiscoverSherdogLiveBlogOptions,
  type SherdogLiveBlogTarget,
  type SherdogNewsItem,
} from "./sherdogDiscovery.ts";
import type { RoundJobClock, RoundJobTimer } from "./roundJobs.ts";

/**
 * Fixed checkpoints for finding the Sherdog play-by-play link. The original
 * pre-event checks remain sparse; if the link is late, discovery continues
 * every 15 minutes for a bounded two-hour post-start recovery window.
 */
export const SHERDOG_LIVE_BLOG_CHECKPOINT_OFFSETS_MS = [
  -2 * 60 * 60 * 1000,
  -1 * 60 * 60 * 1000,
  -30 * 60 * 1000,
  0,
  15 * 60 * 1000,
  30 * 60 * 1000,
  45 * 60 * 1000,
  60 * 60 * 1000,
  75 * 60 * 1000,
  90 * 60 * 1000,
  105 * 60 * 1000,
  120 * 60 * 1000,
] as const;

export const SHERDOG_LIVE_BLOG_MAX_ATTEMPTS =
  SHERDOG_LIVE_BLOG_CHECKPOINT_OFFSETS_MS.length;

/** Every bounded discovery checkpoint, ascending from T-2h through T+2h. */
export function sherdogLiveBlogCheckpoints(startsAt: string): Date[] {
  const startMs = new Date(startsAt).getTime();
  return SHERDOG_LIVE_BLOG_CHECKPOINT_OFFSETS_MS.map(
    (offsetMs) => new Date(startMs + offsetMs),
  );
}

/**
 * The next checkpoint that hasn't been attempted yet, given how many
 * checkpoints have already run, in order. Returns undefined once the bounded
 * post-start recovery window has been exhausted.
 */
export function nextUnattemptedSherdogLiveBlogCheckpoint(
  startsAt: string,
  attemptedCount: number,
): Date | undefined {
  const checkpoints = sherdogLiveBlogCheckpoints(startsAt);
  return checkpoints[attemptedCount];
}

/**
 * Ms until the next unattempted checkpoint is due (0 if it is already due or
 * past), or undefined once every checkpoint has been attempted.
 */
export function msUntilNextSherdogLiveBlogCheckpoint(
  now: Date,
  startsAt: string,
  attemptedCount: number,
): number | undefined {
  const checkpoint = nextUnattemptedSherdogLiveBlogCheckpoint(
    startsAt,
    attemptedCount,
  );
  if (checkpoint === undefined) return undefined;
  return Math.max(0, checkpoint.getTime() - now.getTime());
}

export interface SherdogLiveBlogWatcherOptions {
  target: SherdogLiveBlogTarget;
  startsAt: string;
  discoverOptions: DiscoverSherdogLiveBlogOptions;
  onFound: (match: SherdogNewsItem) => Promise<void> | void;
  attemptedCount?: number;
  onAttempted?: (attemptedCount: number) => Promise<void> | void;
  onCheckpointFailed?: (error: unknown, attemptNumber: number) => void;
  onExhausted?: () => void;
  discover?: (
    target: SherdogLiveBlogTarget,
    options: DiscoverSherdogLiveBlogOptions,
  ) => Promise<SherdogNewsItem | undefined>;
  clock?: RoundJobClock;
  timer?: RoundJobTimer;
}

/**
 * Drives the fixed live-blog checkpoints from T-2h through T+2h: searches
 * Sherdog's news feed at each one until the link is found, then stops for
 * good. The persisted attempt count makes the schedule restart-safe.
 *
 * Clock/timer are injectable (same shape as `RoundJobClock`/`RoundJobTimer`)
 * so this is testable without waiting on real time, matching the rest of
 * this codebase's scheduling code (see `RoundJobScheduler`).
 */
export class SherdogLiveBlogWatcher {
  private readonly target: SherdogLiveBlogTarget;

  private readonly startsAt: string;

  private readonly discoverOptions: DiscoverSherdogLiveBlogOptions;

  private readonly discover: NonNullable<
    SherdogLiveBlogWatcherOptions["discover"]
  >;

  private readonly onFound: SherdogLiveBlogWatcherOptions["onFound"];

  private readonly onCheckpointFailed:
    | SherdogLiveBlogWatcherOptions["onCheckpointFailed"];

  private readonly onExhausted: SherdogLiveBlogWatcherOptions["onExhausted"];

  private readonly onAttempted: SherdogLiveBlogWatcherOptions["onAttempted"];

  private readonly clock: RoundJobClock;

  private readonly timer: RoundJobTimer;

  private attemptedCount: number;

  private found = false;

  private stopped = false;

  private handle: unknown;

  private activeRun: Promise<void> | undefined;

  constructor(options: SherdogLiveBlogWatcherOptions) {
    this.target = options.target;
    this.startsAt = options.startsAt;
    this.discoverOptions = options.discoverOptions;
    this.discover = options.discover ?? discoverSherdogLiveBlog;
    this.onFound = options.onFound;
    const attemptedCount = options.attemptedCount ?? 0;
    if (
      !Number.isSafeInteger(attemptedCount) ||
      attemptedCount < 0 ||
      attemptedCount > SHERDOG_LIVE_BLOG_MAX_ATTEMPTS
    ) {
      throw new TypeError(
        `Sherdog attempted checkpoint count must be 0-${SHERDOG_LIVE_BLOG_MAX_ATTEMPTS}`,
      );
    }
    this.attemptedCount = attemptedCount;
    this.onAttempted = options.onAttempted;
    this.onCheckpointFailed = options.onCheckpointFailed;
    this.onExhausted = options.onExhausted;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.timer =
      options.timer ??
      ({
        setTimeout: (callback, delayMs) =>
          globalThis.setTimeout(callback, delayMs),
        clearTimeout: (handle) =>
          globalThis.clearTimeout(
            handle as ReturnType<typeof globalThis.setTimeout>,
          ),
      } satisfies RoundJobTimer);
  }

  /** Arms the next unattempted checkpoint (a no-op once found or stopped). */
  start(): void {
    this.armNext();
  }

  /** Cancels any pending checkpoint without marking the link as found. */
  stop(): void {
    this.stopped = true;
    if (this.handle !== undefined) {
      this.timer.clearTimeout(this.handle);
      this.handle = undefined;
    }
  }

  isFound(): boolean {
    return this.found;
  }

  /** Waits for an in-flight checkpoint, including persistence callbacks. */
  async idle(): Promise<void> {
    while (this.activeRun !== undefined) {
      await this.activeRun;
    }
  }

  private armNext(): void {
    if (this.stopped || this.found) return;
    const delayMs = msUntilNextSherdogLiveBlogCheckpoint(
      new Date(this.clock.now()),
      this.startsAt,
      this.attemptedCount,
    );
    if (delayMs === undefined) {
      this.onExhausted?.();
      return;
    }
    this.handle = this.timer.setTimeout(() => {
      this.handle = undefined;
      const run = this.runCheckpoint().finally(() => {
        if (this.activeRun === run) this.activeRun = undefined;
      });
      this.activeRun = run;
    }, delayMs);
  }

  private async runCheckpoint(): Promise<void> {
    if (this.stopped || this.found) return;
    this.attemptedCount += 1;
    await this.onAttempted?.(this.attemptedCount);
    if (this.stopped) return;

    let match: SherdogNewsItem | undefined;
    try {
      match = await this.discover(this.target, this.discoverOptions);
    } catch (error) {
      this.onCheckpointFailed?.(error, this.attemptedCount);
      match = undefined;
    }

    if (this.stopped) return;
    if (match !== undefined) {
      this.found = true;
      await this.onFound(match);
      return;
    }

    this.armNext();
  }
}
