import type { Bout, UfcEvent } from "../src/schema.ts";
import type { FightOutlookSummarizer } from "./sherdogOutlookSummarizer.ts";
import {
  collectSherdogOutlookContent,
  SherdogForbiddenError,
  type SherdogOutlookMatch,
} from "./sherdogOutlookContent.ts";
import {
  findSherdogOutlookPreview,
  findSherdogPrelimsOutlookPreview,
} from "./sherdogOutlookDiscovery.ts";
import {
  OUTLOOK_RETRY_INTERVAL_MS,
  hasEventStarted,
  msUntilOutlookWindowOpens,
} from "./sherdogOutlookSchedule.ts";
import {
  SherdogLiveBlogWatcher,
  type SherdogLiveBlogWatcherOptions,
} from "./sherdogLiveBlogSchedule.ts";
import {
  fetchSherdogNewsFeed,
  SHERDOG_ARTICLES_FEED_PATH,
  type SherdogNewsItem,
} from "./sherdogFeed.ts";
import type { RoundJobClock, RoundJobTimer } from "./roundJobs.ts";
import type { Storage } from "./storage.ts";

export const SHERDOG_EVENT_DISCOVERY_STORAGE_STREAM =
  "sherdog-event-discovery";

const MAX_TIMER_DELAY_MS = 2_147_000_000;

export interface SherdogDiscoveredEventState {
  eventId: string;
  liveBlogUrl?: string;
  mainOutlookUrl?: string;
  prelimsOutlookUrl?: string;
  outlooks: Readonly<Record<string, string>>;
  updatedAt: string;
}

interface PersistedSherdogEventDiscovery {
  version: 1;
  value: SherdogDiscoveredEventState;
}

interface DiscoveredOutlookArticles {
  main?: SherdogNewsItem;
  prelims?: SherdogNewsItem;
}

export interface SherdogEventDiscoveryOptions {
  event: UfcEvent;
  storage: Storage;
  permissionScope: string;
  baseUrl: string;
  summarizer: FightOutlookSummarizer;
  initialLiveBlogUrl?: string;
  onChanged?: (state: SherdogDiscoveredEventState) => Promise<void> | void;
  onError?: (stage: "live-blog" | "outlook", error: unknown) => void;
  discoverLiveBlog?: NonNullable<
    SherdogLiveBlogWatcherOptions["discover"]
  >;
  discoverOutlooks?: () => Promise<DiscoveredOutlookArticles>;
  collectOutlooks?: (
    mainUrl: string,
    prelimsUrl: string | undefined,
  ) => Promise<SherdogOutlookMatch[]>;
  clock?: RoundJobClock;
  timer?: RoundJobTimer;
}

export interface SherdogEventDiscoveryController {
  getLiveBlogUrl(): string | undefined;
  getOutlooks(): Readonly<Record<string, string>>;
  start(): void;
  close(): Promise<void>;
  idle(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPersistedState(
  value: unknown,
): value is PersistedSherdogEventDiscovery {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isRecord(value.value) &&
    typeof value.value.eventId === "string" &&
    typeof value.value.updatedAt === "string" &&
    isRecord(value.value.outlooks) &&
    Object.values(value.value.outlooks).every(
      (outlook) => typeof outlook === "string",
    ) &&
    (value.value.liveBlogUrl === undefined ||
      typeof value.value.liveBlogUrl === "string") &&
    (value.value.mainOutlookUrl === undefined ||
      typeof value.value.mainOutlookUrl === "string") &&
    (value.value.prelimsOutlookUrl === undefined ||
      typeof value.value.prelimsOutlookUrl === "string")
  );
}

function mainEvent(event: UfcEvent): Bout | undefined {
  return [...event.bouts].sort(
    (left, right) => left.cardPosition - right.cardPosition,
  )[0];
}

function copyState(
  state: SherdogDiscoveredEventState,
): SherdogDiscoveredEventState {
  return { ...state, outlooks: { ...state.outlooks } };
}

export class SherdogEventDiscovery
  implements SherdogEventDiscoveryController
{
  private readonly options: SherdogEventDiscoveryOptions;

  private readonly clock: RoundJobClock;

  private readonly timer: RoundJobTimer;

  private readonly liveBlogWatcher: SherdogLiveBlogWatcher | undefined;

  private state: SherdogDiscoveredEventState;

  private outlookTimer: unknown;

  private readonly pending = new Set<Promise<void>>();

  private started = false;

  private stopped = false;

  private outlookForbidden = false;

  private outlookAttempted = false;

  private constructor(
    options: SherdogEventDiscoveryOptions,
    state: SherdogDiscoveredEventState,
  ) {
    this.options = options;
    this.state = state;
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

    const bout = mainEvent(options.event);
    this.liveBlogWatcher =
      bout === undefined || this.state.liveBlogUrl !== undefined
        ? undefined
        : new SherdogLiveBlogWatcher({
            target: {
              eventName: options.event.name,
              redFighter: bout.fighters.red.name,
              blueFighter: bout.fighters.blue.name,
            },
            startsAt: options.event.startsAt,
            discoverOptions: {
              permissionScope: options.permissionScope,
              baseUrl: options.baseUrl,
            },
            onFound: async (match) => {
              this.state = {
                ...this.state,
                liveBlogUrl: match.url,
                updatedAt: new Date(this.clock.now()).toISOString(),
              };
              const task = this.persistAndNotify().finally(() => {
                this.pending.delete(task);
              });
              this.pending.add(task);
              await task;
            },
            onCheckpointFailed: (error) =>
              options.onError?.("live-blog", error),
            ...(options.discoverLiveBlog === undefined
              ? {}
              : { discover: options.discoverLiveBlog }),
            clock: this.clock,
            timer: this.timer,
          });
  }

  static async create(
    options: SherdogEventDiscoveryOptions,
  ): Promise<SherdogEventDiscovery> {
    const records = await options.storage.read<unknown>(
      SHERDOG_EVENT_DISCOVERY_STORAGE_STREAM,
    );
    const restored = records.filter(isPersistedState).at(-1)?.value;
    const initialUrl = options.initialLiveBlogUrl?.trim() || undefined;
    const state: SherdogDiscoveredEventState =
      restored?.eventId === options.event.id
        ? {
            ...copyState(restored),
            ...(initialUrl === undefined
              ? {}
              : { liveBlogUrl: initialUrl }),
          }
        : {
            eventId: options.event.id,
            ...(initialUrl === undefined
              ? {}
              : { liveBlogUrl: initialUrl }),
            outlooks: {},
            updatedAt: new Date(
              options.clock?.now() ?? Date.now(),
            ).toISOString(),
          };
    return new SherdogEventDiscovery(options, state);
  }

  getLiveBlogUrl(): string | undefined {
    return this.state.liveBlogUrl;
  }

  getOutlooks(): Readonly<Record<string, string>> {
    return { ...this.state.outlooks };
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.liveBlogWatcher?.start();
    this.scheduleOutlook();
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.liveBlogWatcher?.stop();
    if (this.outlookTimer !== undefined) {
      this.timer.clearTimeout(this.outlookTimer);
      this.outlookTimer = undefined;
    }
    await this.idle();
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  private scheduleOutlook(): void {
    if (this.stopped || this.outlookForbidden) return;
    const now = new Date(this.clock.now());
    if (hasEventStarted(now, this.options.event.startsAt)) return;
    if (this.outlookComplete()) return;

    const untilWindow = msUntilOutlookWindowOpens(
      now,
      this.options.event.startsAt,
    );
    const delay = Math.min(
      untilWindow > 0
        ? untilWindow
        : this.outlookAttempted
          ? OUTLOOK_RETRY_INTERVAL_MS
          : 0,
      MAX_TIMER_DELAY_MS,
    );
    this.outlookTimer = this.timer.setTimeout(() => {
      this.outlookTimer = undefined;
      if (
        this.stopped ||
        hasEventStarted(
          new Date(this.clock.now()),
          this.options.event.startsAt,
        )
      ) {
        return;
      }
      if (
        msUntilOutlookWindowOpens(
          new Date(this.clock.now()),
          this.options.event.startsAt,
        ) > 0
      ) {
        this.scheduleOutlook();
        return;
      }
      this.outlookAttempted = true;
      const task = this.runOutlookAttempt()
        .catch((error: unknown) => {
          if (
            error instanceof SherdogForbiddenError ||
            (error instanceof Error && /\b403\b/u.test(error.message))
          ) {
            this.outlookForbidden = true;
          }
          this.options.onError?.("outlook", error);
        })
        .finally(() => {
          this.pending.delete(task);
          this.scheduleOutlook();
        });
      this.pending.add(task);
    }, delay);
  }

  private async runOutlookAttempt(): Promise<void> {
    const articles = await (this.options.discoverOutlooks?.() ??
      this.discoverOutlooks());
    const mainUrl = this.state.mainOutlookUrl ?? articles.main?.url;
    const prelimsUrl =
      this.state.prelimsOutlookUrl ?? articles.prelims?.url;
    this.state = {
      ...this.state,
      ...(mainUrl === undefined ? {} : { mainOutlookUrl: mainUrl }),
      ...(prelimsUrl === undefined
        ? {}
        : { prelimsOutlookUrl: prelimsUrl }),
      updatedAt: new Date(this.clock.now()).toISOString(),
    };
    if (mainUrl === undefined) {
      await this.persistAndNotify();
      return;
    }

    let matches: SherdogOutlookMatch[];
    try {
      matches = await (this.options.collectOutlooks?.(
        mainUrl,
        prelimsUrl,
      ) ?? this.collectOutlooks(mainUrl, prelimsUrl));
    } catch (error) {
      if (error instanceof SherdogForbiddenError) {
        this.outlookForbidden = true;
      }
      throw error;
    }

    const outlooks = { ...this.state.outlooks };
    for (const match of matches) {
      if (outlooks[match.bout.id] !== undefined) continue;
      const outlook = await this.options.summarizer.summarize({
        redName: match.bout.fighters.red.name,
        blueName: match.bout.fighters.blue.name,
        weightClass: match.bout.weightClass,
        titleFight: match.bout.titleFight,
        rawPreviewText: match.rawPreviewText,
      });
      if (outlook.length > 0) outlooks[match.bout.id] = outlook;
    }
    this.state = {
      ...this.state,
      outlooks,
      updatedAt: new Date(this.clock.now()).toISOString(),
    };
    await this.persistAndNotify();
  }

  private async discoverOutlooks(): Promise<DiscoveredOutlookArticles> {
    const bout = mainEvent(this.options.event);
    if (bout === undefined) return {};
    const items = await fetchSherdogNewsFeed({
      permissionScope: this.options.permissionScope,
      baseUrl: this.options.baseUrl,
      feedPath: SHERDOG_ARTICLES_FEED_PATH,
    });
    const main = findSherdogOutlookPreview(items, {
      eventName: this.options.event.name,
      redFighter: bout.fighters.red.name,
      blueFighter: bout.fighters.blue.name,
    });
    const prelims = findSherdogPrelimsOutlookPreview(items, {
      eventName: this.options.event.name,
    });
    return {
      ...(main === undefined ? {} : { main }),
      ...(prelims === undefined ? {} : { prelims }),
    };
  }

  private collectOutlooks(
    mainUrl: string,
    prelimsUrl: string | undefined,
  ): Promise<SherdogOutlookMatch[]> {
    const mainCardBouts = this.options.event.bouts.filter(
      (bout) => bout.segment === "main-card",
    );
    const prelimsBouts = this.options.event.bouts.filter(
      (bout) => bout.segment !== "main-card",
    );
    return collectSherdogOutlookContent(
      {
        baseArticleUrl: mainUrl,
        mainCardBoutCount: mainCardBouts.length,
        ...(prelimsUrl === undefined
          ? {}
          : {
              prelimsArticleUrl: prelimsUrl,
              prelimsBoutCount: prelimsBouts.length,
            }),
        bouts: this.options.event.bouts,
      },
      {
        permissionScope: this.options.permissionScope,
      },
    );
  }

  private outlookComplete(): boolean {
    const hasPrelims = this.options.event.bouts.some(
      (bout) => bout.segment !== "main-card",
    );
    return (
      this.state.mainOutlookUrl !== undefined &&
      (!hasPrelims || this.state.prelimsOutlookUrl !== undefined) &&
      Object.keys(this.state.outlooks).length >=
        this.options.event.bouts.length
    );
  }

  private async persistAndNotify(): Promise<void> {
    const value = copyState(this.state);
    await this.options.storage.replace(
      SHERDOG_EVENT_DISCOVERY_STORAGE_STREAM,
      [{ version: 1, value } satisfies PersistedSherdogEventDiscovery],
    );
    await this.options.onChanged?.(copyState(value));
  }
}
