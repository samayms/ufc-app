import { describe, expect, it, vi } from "vitest";
import type { Fighter, UfcEvent } from "../src/schema.ts";
import type { RoundJobClock, RoundJobTimer } from "./roundJobs.ts";
import {
  SHERDOG_EVENT_DISCOVERY_STORAGE_STREAM,
  SherdogEventDiscovery,
} from "./sherdogEventDiscovery.ts";
import { MemoryStorage } from "./storage.ts";

class ManualTime implements RoundJobClock, RoundJobTimer {
  value: number;

  private nextId = 1;

  private readonly timers = new Map<
    number,
    { callback: () => void; dueAt: number }
  >();

  constructor(value: number) {
    this.value = value;
  }

  now(): number {
    return this.value;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { callback, dueAt: this.value + delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  async advance(milliseconds: number): Promise<void> {
    this.value += milliseconds;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.value)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.dueAt - right.dueAt || leftId - rightId,
        )[0];
      if (due === undefined) return;
      this.timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
      await Promise.resolve();
    }
  }
}

function fighter(id: string, name: string): Fighter {
  return {
    id,
    externalRefs: [{ source: "espn", id }],
    name,
    record: { wins: 10, losses: 1, draws: 0, noContests: 0 },
    provenance: {
      source: "espn",
      fetchedAt: "2026-07-01T00:00:00.000Z",
      synthetic: false,
    },
  };
}

function event(): UfcEvent {
  const provenance = {
    source: "espn" as const,
    fetchedAt: "2026-07-01T00:00:00.000Z",
    synthetic: false,
  };
  return {
    id: "event-1",
    externalRefs: [{ source: "espn", id: "event-1" }],
    name: "UFC Belgrade: Medic vs. Rodriguez",
    startsAt: "2026-08-01T17:00:00.000Z",
    bouts: [
      {
        id: "bout-main",
        externalRefs: [{ source: "espn", id: "bout-main" }],
        eventId: "event-1",
        cardPosition: 1,
        segment: "main-card",
        weightClass: "welterweight",
        scheduledRounds: 5,
        titleFight: false,
        fighters: {
          red: fighter("medic", "Uros Medic"),
          blue: fighter("rodriguez", "Daniel Rodriguez"),
        },
        status: "upcoming",
        provenance,
      },
      {
        id: "bout-prelim",
        externalRefs: [{ source: "espn", id: "bout-prelim" }],
        eventId: "event-1",
        cardPosition: 2,
        segment: "prelims",
        weightClass: "lightweight",
        scheduledRounds: 3,
        titleFight: false,
        fighters: {
          red: fighter("nikolic", "Boris Nikolic"),
          blue: fighter("vologdin", "Mark Vologdin"),
        },
        status: "upcoming",
        provenance,
      },
    ],
    provenance,
  };
}

const mainArticle = {
  title: "Preview: UFC Belgrade",
  url: "https://www.sherdog.com/news/articles/UFC-Belgrade-202100",
};
const prelimsArticle = {
  title: "Preview: UFC Belgrade Prelims",
  url: "https://www.sherdog.com/news/articles/UFC-Belgrade-Prelims-202101",
};
const liveArticle = {
  title: "UFC Belgrade play-by-play",
  url: "https://www.sherdog.com/news/news/UFC-Belgrade-playbyplay-202102",
};

describe("SherdogEventDiscovery", () => {
  it("waits until three days before the event, then imports and persists every preview", async () => {
    const card = event();
    const time = new ManualTime(
      Date.parse("2026-07-28T17:00:00.000Z"),
    );
    const storage = new MemoryStorage();
    const discoverOutlooks = vi.fn(async () => ({
      main: mainArticle,
      prelims: prelimsArticle,
    }));
    const collectOutlooks = vi.fn(async () =>
      card.bouts.map((bout) => ({
        bout,
        rawPreviewText: `Long Sherdog preview for ${bout.fighters.red.name}.`,
      })),
    );
    const summarize = vi.fn(async ({ redName }: { redName: string }) =>
      `${redName} summarized outlook.`,
    );
    const onChanged = vi.fn();
    const discovery = await SherdogEventDiscovery.create({
      event: card,
      storage,
      permissionScope: "sherdog-read",
      baseUrl: "https://www.sherdog.com",
      summarizer: { summarize },
      discoverOutlooks,
      collectOutlooks,
      discoverLiveBlog: vi.fn(async () => undefined),
      onChanged,
      clock: time,
      timer: time,
    });

    discovery.start();
    await time.advance(23 * 60 * 60 * 1000);
    expect(discoverOutlooks).not.toHaveBeenCalled();

    await time.advance(60 * 60 * 1000);
    await discovery.idle();

    expect(discoverOutlooks).toHaveBeenCalledTimes(1);
    expect(collectOutlooks).toHaveBeenCalledExactlyOnceWith(
      mainArticle.url,
      prelimsArticle.url,
    );
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(discovery.getOutlooks()).toEqual({
      "bout-main": "Uros Medic summarized outlook.",
      "bout-prelim": "Boris Nikolic summarized outlook.",
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(
      await storage.read(SHERDOG_EVENT_DISCOVERY_STORAGE_STREAM),
    ).toHaveLength(1);
    await discovery.close();
  });

  it("discovers the live blog before the event and restores it without another fetch", async () => {
    const card = event();
    const time = new ManualTime(
      Date.parse("2026-08-01T15:00:00.000Z"),
    );
    const storage = new MemoryStorage();
    const discoverLiveBlog = vi.fn(async () => liveArticle);
    const discovery = await SherdogEventDiscovery.create({
      event: card,
      storage,
      permissionScope: "sherdog-read",
      baseUrl: "https://www.sherdog.com",
      summarizer: { summarize: vi.fn(async () => "") },
      discoverLiveBlog,
      discoverOutlooks: vi.fn(async () => ({})),
      collectOutlooks: vi.fn(async () => []),
      clock: time,
      timer: time,
    });

    discovery.start();
    await time.advance(0);
    await discovery.idle();
    expect(discovery.getLiveBlogUrl()).toBe(liveArticle.url);
    expect(discoverLiveBlog).toHaveBeenCalledTimes(1);
    await discovery.close();

    const restoredFetch = vi.fn(async () => undefined);
    const restored = await SherdogEventDiscovery.create({
      event: card,
      storage,
      permissionScope: "sherdog-read",
      baseUrl: "https://www.sherdog.com",
      summarizer: { summarize: vi.fn(async () => "") },
      discoverLiveBlog: restoredFetch,
      discoverOutlooks: vi.fn(async () => ({})),
      collectOutlooks: vi.fn(async () => []),
      clock: time,
      timer: time,
    });
    restored.start();
    await time.advance(0);

    expect(restored.getLiveBlogUrl()).toBe(liveArticle.url);
    expect(restoredFetch).not.toHaveBeenCalled();
    await restored.close();
  });

  it("does not retry a missing preview after the event has started", async () => {
    const time = new ManualTime(
      Date.parse("2026-08-01T15:00:00.000Z"),
    );
    const discoverOutlooks = vi.fn(async () => ({}));
    const discovery = await SherdogEventDiscovery.create({
      event: event(),
      storage: new MemoryStorage(),
      permissionScope: "sherdog-read",
      baseUrl: "https://www.sherdog.com",
      summarizer: { summarize: vi.fn(async () => "") },
      discoverLiveBlog: vi.fn(async () => undefined),
      discoverOutlooks,
      collectOutlooks: vi.fn(async () => []),
      clock: time,
      timer: time,
    });

    discovery.start();
    await time.advance(0);
    await discovery.idle();
    expect(discoverOutlooks).toHaveBeenCalledTimes(1);

    await time.advance(12 * 60 * 60 * 1000);
    await discovery.idle();
    expect(discoverOutlooks).toHaveBeenCalledTimes(1);
    await discovery.close();
  });

  it("restores live-blog checkpoint progress instead of replaying missed checks", async () => {
    const time = new ManualTime(
      Date.parse("2026-08-01T15:00:00.000Z"),
    );
    const storage = new MemoryStorage();
    const firstFetch = vi.fn(async () => undefined);
    const first = await SherdogEventDiscovery.create({
      event: event(),
      storage,
      permissionScope: "sherdog-read",
      baseUrl: "https://www.sherdog.com",
      summarizer: { summarize: vi.fn(async () => "") },
      discoverLiveBlog: firstFetch,
      discoverOutlooks: vi.fn(async () => ({})),
      collectOutlooks: vi.fn(async () => []),
      clock: time,
      timer: time,
    });
    first.start();
    await time.advance(0);
    await first.idle();
    expect(firstFetch).toHaveBeenCalledTimes(1);
    await first.close();

    const restoredFetch = vi.fn(async () => liveArticle);
    const restored = await SherdogEventDiscovery.create({
      event: event(),
      storage,
      permissionScope: "sherdog-read",
      baseUrl: "https://www.sherdog.com",
      summarizer: { summarize: vi.fn(async () => "") },
      discoverLiveBlog: restoredFetch,
      discoverOutlooks: vi.fn(async () => ({})),
      collectOutlooks: vi.fn(async () => []),
      clock: time,
      timer: time,
    });
    restored.start();
    await time.advance(0);
    expect(restoredFetch).not.toHaveBeenCalled();

    await time.advance(60 * 60 * 1000);
    await restored.idle();
    expect(restoredFetch).toHaveBeenCalledTimes(1);
    expect(restored.getLiveBlogUrl()).toBe(liveArticle.url);
    await restored.close();
  });
});
