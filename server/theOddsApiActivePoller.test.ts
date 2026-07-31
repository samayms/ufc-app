import { describe, expect, it, vi } from "vitest";

import { CollectorEventBus } from "./eventBus.ts";
import { MemoryStorage } from "./storage.ts";
import {
  TheOddsApiActivePoller,
  theOddsApiPollingPolicy,
  THE_ODDS_API_DEFAULT_ACTIVE_INTERVAL_MS,
  THE_ODDS_API_LOW_INTERVAL_MS,
  THE_ODDS_API_MID_INTERVAL_MS,
} from "./theOddsApiActivePoller.ts";
import type { Bout, OddsSnapshot } from "../src/schema.ts";
import type { QuotaPolicy } from "./quota.ts";

const BOUT: Bout = {
  id: "bout-main",
  externalRefs: [],
  eventId: "event-1",
  cardPosition: 1,
  segment: "main-card",
  weightClass: "welterweight",
  scheduledRounds: 5,
  titleFight: true,
  fighters: {
    red: {
      id: "red",
      externalRefs: [],
      name: "Islam Makhachev",
      record: { wins: 27, losses: 1, draws: 0, noContests: 0 },
      provenance: { source: "espn", fetchedAt: "", synthetic: false },
    },
    blue: {
      id: "blue",
      externalRefs: [],
      name: "Ian Machado Garry",
      record: { wins: 16, losses: 0, draws: 0, noContests: 0 },
      provenance: { source: "espn", fetchedAt: "", synthetic: false },
    },
  },
  status: "in-round",
  provenance: { source: "espn", fetchedAt: "", synthetic: false },
};

function snapshot(): OddsSnapshot {
  return {
    boutId: BOUT.id,
    market: "sportsbook",
    quotes: [
      {
        corner: "red",
        native: { kind: "american-moneyline", moneyline: -230, book: "draftkings" },
        impliedProbability: 0.697,
      },
      {
        corner: "blue",
        native: { kind: "american-moneyline", moneyline: 190, book: "draftkings" },
        impliedProbability: 0.345,
      },
    ],
    provenance: { source: "odds-api", fetchedAt: "", synthetic: false },
  };
}

class ManualTimer {
  private handle = 0;

  readonly pending = new Map<number, { callback: () => void; delayMs: number }>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.handle += 1;
    this.pending.set(this.handle, { callback, delayMs });
    return this.handle;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  delays(): number[] {
    return [...this.pending.values()].map((entry) => entry.delayMs);
  }

  fireAll(): void {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, entry] of entries) entry.callback();
  }
}

interface Harness {
  poller: TheOddsApiActivePoller;
  eventBus: CollectorEventBus;
  timer: ManualTimer;
  getH2hSnapshot: ReturnType<typeof vi.fn>;
  ingest: ReturnType<typeof vi.fn>;
  snapshotSource: ReturnType<typeof vi.fn>;
}

async function harness(
  overrides: {
    quotaPolicy?: QuotaPolicy;
    activePollMs?: number;
    getH2hSnapshot?: ReturnType<typeof vi.fn>;
    enabled?: boolean | (() => boolean);
  } = {},
): Promise<Harness> {
  const eventBus = new CollectorEventBus();
  const timer = new ManualTimer();
  const getH2hSnapshot =
    overrides.getH2hSnapshot ?? vi.fn(async () => snapshot());
  const ingest = vi.fn(async () => undefined);
  const snapshotSource = vi.fn(async () => undefined);

  const poller = await TheOddsApiActivePoller.create({
    eventBus,
    storage: new MemoryStorage(),
    source: { getH2hSnapshot } as never,
    tickStore: { ingest, snapshotSource } as never,
    getBout: (boutId) => (boutId === BOUT.id ? BOUT : undefined),
    timer,
    ...(overrides.activePollMs === undefined
      ? {}
      : { activePollMs: overrides.activePollMs }),
    ...(overrides.quotaPolicy === undefined
      ? {}
      : { quotaPolicy: overrides.quotaPolicy }),
    ...(overrides.enabled === undefined
      ? {}
      : { enabled: overrides.enabled }),
  });

  return { poller, eventBus, timer, getH2hSnapshot, ingest, snapshotSource };
}

describe("theOddsApiPollingPolicy", () => {
  it("uses the configured target while quota is healthy", () => {
    expect(
      theOddsApiPollingPolicy({ hour: 60, day: 400 }, 45_000),
    ).toEqual({ mode: "periodic", intervalMs: 45_000 });
  });

  it("slows down as the hourly reserve drops", () => {
    expect(
      theOddsApiPollingPolicy({ hour: 20, day: 400 }, 45_000).intervalMs,
    ).toBe(THE_ODDS_API_MID_INTERVAL_MS);
    expect(
      theOddsApiPollingPolicy({ hour: 5, day: 400 }, 45_000).intervalMs,
    ).toBe(THE_ODDS_API_LOW_INTERVAL_MS);
  });

  it("stops periodic polling before exhausting the day's reserve", () => {
    expect(theOddsApiPollingPolicy({ hour: 60, day: 5 }, 45_000)).toEqual({
      mode: "boundary-only",
    });
  });

  it("never lets a fast target override a degraded tier", () => {
    // Quota protection beats the configured interval, always.
    expect(
      theOddsApiPollingPolicy({ hour: 5, day: 400 }, 1_000).intervalMs,
    ).toBe(THE_ODDS_API_LOW_INTERVAL_MS);
  });

  it("defaults to the documented 45s target", () => {
    expect(theOddsApiPollingPolicy({ hour: 60, day: 400 }).intervalMs).toBe(
      THE_ODDS_API_DEFAULT_ACTIVE_INTERVAL_MS,
    );
  });
});

describe("TheOddsApiActivePoller", () => {
  it("starts collecting when ESPN says the fight started", async () => {
    const { poller, eventBus, getH2hSnapshot } = await harness();

    eventBus.emit({
      type: "FIGHT_STARTED",
      boutId: BOUT.id,
      detectedAt: "2026-08-15T21:05:00.000Z",
    });
    await poller.idle();

    expect(poller.isActive(BOUT.id)).toBe(true);
    expect(getH2hSnapshot).toHaveBeenCalledTimes(1);
    await poller.close();
  });

  it("schedules the next poll at the configured interval", async () => {
    const { poller, eventBus, timer } = await harness({ activePollMs: 45_000 });

    eventBus.emit({
      type: "FIGHT_STARTED",
      boutId: BOUT.id,
      detectedAt: "2026-08-15T21:05:00.000Z",
    });
    await poller.idle();

    expect(timer.delays()).toEqual([45_000]);
    await poller.close();
  });

  it("stops polling and takes a final snapshot when the fight ends", async () => {
    const { poller, eventBus, timer, snapshotSource } = await harness();

    eventBus.emit({
      type: "FIGHT_STARTED",
      boutId: BOUT.id,
      detectedAt: "2026-08-15T21:05:00.000Z",
    });
    await poller.idle();
    eventBus.emit({
      type: "FIGHT_ENDED",
      boutId: BOUT.id,
      round: 3,
      detectedAt: "2026-08-15T21:30:00.000Z",
    });
    await poller.idle();

    expect(poller.isActive(BOUT.id)).toBe(false);
    expect(timer.pending.size).toBe(0);
    expect(snapshotSource).toHaveBeenCalledWith(
      BOUT.id,
      3,
      "the-odds-api",
      "confirmed",
      expect.any(String),
    );
    await poller.close();
  });

  it("never runs two requests at once", async () => {
    let inFlight = 0;
    let overlapped = false;
    const getH2hSnapshot = vi.fn(async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await Promise.resolve();
      inFlight -= 1;
      return snapshot();
    });
    const { poller, eventBus, timer } = await harness({ getH2hSnapshot });

    eventBus.emit({
      type: "FIGHT_STARTED",
      boutId: BOUT.id,
      detectedAt: "2026-08-15T21:05:00.000Z",
    });
    // A timer firing while a fight-end fetch is queued is the realistic race.
    timer.fireAll();
    eventBus.emit({
      type: "FIGHT_ENDED",
      boutId: BOUT.id,
      round: 1,
      detectedAt: "2026-08-15T21:10:00.000Z",
    });
    await poller.idle();

    expect(overlapped).toBe(false);
    await poller.close();
  });

  it("stops periodic polling once the quota policy is exhausted", async () => {
    // Two requests allowed, ever: the fight-start fetch consumes one and the
    // scheduler must not queue another.
    const { poller, eventBus, timer } = await harness({
      quotaPolicy: { perMinute: 1, perHour: 1, perDay: 1 },
    });

    eventBus.emit({
      type: "FIGHT_STARTED",
      boutId: BOUT.id,
      detectedAt: "2026-08-15T21:05:00.000Z",
    });
    await poller.idle();

    expect(timer.pending.size).toBe(0);
    await poller.close();
  });

  it("keeps polling after a failed request rather than giving up", async () => {
    const getH2hSnapshot = vi
      .fn<() => Promise<OddsSnapshot>>()
      .mockRejectedValueOnce(new Error("gateway timeout"))
      .mockResolvedValue(snapshot());
    const { poller, eventBus, timer, ingest } = await harness({
      getH2hSnapshot: getH2hSnapshot as never,
    });

    eventBus.emit({
      type: "FIGHT_STARTED",
      boutId: BOUT.id,
      detectedAt: "2026-08-15T21:05:00.000Z",
    });
    await poller.idle();

    // The failure ingested nothing — the previous price stays put — but the
    // next poll is still scheduled.
    expect(ingest).not.toHaveBeenCalled();
    expect(timer.pending.size).toBe(1);

    timer.fireAll();
    await poller.idle();
    expect(ingest).toHaveBeenCalled();
    await poller.close();
  });

  it("ignores a fight it has no bout for", async () => {
    const { poller, eventBus, getH2hSnapshot } = await harness();

    eventBus.emit({
      type: "FIGHT_STARTED",
      boutId: "bout-unknown",
      detectedAt: "2026-08-15T21:05:00.000Z",
    });
    await poller.idle();

    expect(getH2hSnapshot).not.toHaveBeenCalled();
    await poller.close();
  });

  it("never starts polling when disabled with a boolean", async () => {
    const { poller, eventBus, getH2hSnapshot } = await harness({
      enabled: false,
    });

    eventBus.emit({
      type: "FIGHT_STARTED",
      boutId: BOUT.id,
      detectedAt: "2026-08-15T21:05:00.000Z",
    });
    await poller.idle();

    expect(poller.isActive(BOUT.id)).toBe(false);
    expect(getH2hSnapshot).not.toHaveBeenCalled();
    await poller.close();
  });

  it("never starts polling when the enabled predicate returns false", async () => {
    const { poller, eventBus, getH2hSnapshot } = await harness({
      enabled: () => false,
    });

    eventBus.emit({
      type: "FIGHT_STARTED",
      boutId: BOUT.id,
      detectedAt: "2026-08-15T21:05:00.000Z",
    });
    await poller.idle();

    expect(poller.isActive(BOUT.id)).toBe(false);
    expect(getH2hSnapshot).not.toHaveBeenCalled();
    await poller.close();
  });

  it("stops scheduling further polls once the predicate flips to false mid-event", async () => {
    let enabled = true;
    const { poller, eventBus, timer, getH2hSnapshot } = await harness({
      enabled: () => enabled,
    });

    eventBus.emit({
      type: "FIGHT_STARTED",
      boutId: BOUT.id,
      detectedAt: "2026-08-15T21:05:00.000Z",
    });
    await poller.idle();
    expect(getH2hSnapshot).toHaveBeenCalledTimes(1);
    expect(timer.pending.size).toBe(1);

    enabled = false;
    timer.fireAll();
    await poller.idle();

    expect(getH2hSnapshot).toHaveBeenCalledTimes(1);
    expect(timer.pending.size).toBe(0);
    await poller.close();
  });
});
