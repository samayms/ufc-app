/**
 * The Lab's watcher — the instrument that answers the timing question.
 *
 * You press "fight started" at the opening bell and ESPN is sampled throughout
 * the fight. At a horn, the round marker arms the latency measurement and the
 * other sources race to be the first to answer:
 *
 *   ESPN     — every reported clock/period, plus the round-end transition
 *   Cito     — when do that round's per-fighter stats actually exist?
 *   Sherdog  — when does the round's commentary and scoring appear?
 *
 * Design rules, learned from the collector:
 *   - **First appearance only.** A round's stats appearing is recorded once.
 *     Re-recording every poll would bury the one timestamp that matters.
 *   - **Poll only what is pending.** A (bout, round) pair leaves the pending
 *     set the moment it is found, so quota is spent on unanswered questions.
 *   - **Quota is finite and shared with the collector.** Every poller reads the
 *     vendor's own rate-limit header and backs off when it runs low, and says
 *     so on the timeline rather than dying quietly.
 *   - **A poller may never throw into the interval.** A failing source
 *     increments a counter and keeps going; it must not stop the other two.
 */

import {
  buildEspnScoreboardUrl,
  parseEspnScoreboardLifecycle,
  type EspnLifecycleEntry,
} from "../../src/sources/espn.ts";
import { buildCitoRoundStatsUrl } from "../../src/sources/cito.ts";
import { matchFighterPair } from "../../src/lib/boutMatch.ts";
import {
  buildKalshiUpcomingUrl,
  parseKalshiUpcomingMarkets,
} from "../../src/sources/upcoming/kalshiUpcoming.ts";
import { parseSherdogRoundObservations } from "../../src/sources/sherdog.ts";
import type { WatchStatus, WatchTarget } from "./contract.ts";
import { redactSecrets } from "./contract.ts";
import {
  diffEspnCoreStats,
  fetchEspnCoreStats,
  hasNonzeroEspnCoreStats,
  type EspnCoreStatsSample,
} from "./espnStats.ts";
import type { LabTimeline } from "./timeline.ts";

const DEFAULT_ESPN_INTERVAL_MS = 2_500;
const DEFAULT_CITO_INTERVAL_MS = 5_000;
const DEFAULT_KALSHI_INTERVAL_MS = 5_000;
const DEFAULT_SHERDOG_INTERVAL_MS = 20_000;

/** Sherdog is a courtesy read of someone else's page. Never poll it harder. */
const MIN_SHERDOG_INTERVAL_MS = 15_000;
const MIN_INTERVAL_MS = 1_000;

/** Below this many remaining vendor requests, slow down and say so. */
const QUOTA_FLOOR = 25;
const QUOTA_BACKOFF_MS = 30_000;

/**
 * How many polls to keep chasing one (bout, round) before giving up. At a 5s
 * cadence this is ten minutes — longer than any plausible publication delay,
 * short enough that a cancelled round stops costing quota.
 */
const MAX_PENDING_POLLS = 120;

const REQUEST_TIMEOUT_MS = 12_000;

interface PollerState {
  name: string;
  polls: number;
  failures: number;
  lastAt?: string;
  lastMs?: number;
  lastError?: string;
  timer?: ReturnType<typeof setInterval>;
  intervalMs: number;
  nextAtMs?: number;
}

/** One unanswered question: "does this bout's round N exist yet?" */
interface PendingRound {
  boutId: string;
  round: number;
  polls: number;
}

interface PendingEspnRound {
  labBoutId: string;
  espnBoutId: string;
  round: number;
}

interface EspnSample {
  atMs: number;
  entry: EspnLifecycleEntry;
}

interface EspnStatsPairSample {
  boutId: string;
  red: EspnCoreStatsSample;
  blue: EspnCoreStatsSample;
}

export interface LabWatcherOptions {
  timeline: LabTimeline;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class LabWatcher {
  private readonly timeline: LabTimeline;

  private readonly env: Record<string, string | undefined>;

  private readonly fetchImpl: typeof fetch;

  private readonly now: () => number;

  private running = false;

  private startedAt?: string;

  private target?: WatchTarget;

  private readonly pollers = new Map<string, PollerState>();

  /** Last lifecycle entry seen per ESPN bout id, for change detection. */
  private readonly espnSeen = new Map<string, string>();

  private espnLastSample?: EspnSample;

  private espnPending?: PendingEspnRound;

  private espnStatsLast?: EspnStatsPairSample;

  private espnStatsSampleNumber = 0;

  /** (bout,round) keys already recorded as found — never recorded twice. */
  private readonly foundCito = new Set<string>();

  private readonly foundSherdog = new Set<string>();

  private kalshiComplete = false;

  private citoPending: PendingRound[] = [];

  private sherdogPending: PendingRound[] = [];

  constructor(options: LabWatcherOptions) {
    this.timeline = options.timeline;
    this.env = options.env;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * A marker for a finished round is what makes a round *interesting*: from
   * then on, all three sources are asked whether they have it yet. The server
   * calls this when the owner presses the button.
   */
  markRoundEnded(round: number, boutId?: string): void {
    if (!Number.isSafeInteger(round) || round < 1) return;
    const labBoutId =
      boutId ?? this.target?.boutId ?? this.target?.citoBoutIds?.[0];
    const cito = labBoutId ?? this.target?.citoBoutIds?.[0];
    if (cito !== undefined && !this.foundCito.has(`${cito}:${round}`)) {
      this.addPending(this.citoPending, cito, round);
    }
    const espnBoutId = this.target?.espnBoutId;
    if (labBoutId !== undefined && espnBoutId !== undefined) {
      this.espnPending = { labBoutId, espnBoutId, round };
    }
    if (
      this.target?.sherdogUrl !== undefined &&
      !this.foundSherdog.has(`sherdog:${round}`)
    ) {
      this.addPending(this.sherdogPending, "sherdog", round);
    }
  }

  private addPending(list: PendingRound[], boutId: string, round: number): void {
    if (list.some((entry) => entry.boutId === boutId && entry.round === round)) {
      return;
    }
    list.push({ boutId, round, polls: 0 });
  }

  start(target: WatchTarget): WatchStatus {
    const sameEspnStatsFight = this.target?.boutId === target.boutId;
    const previousEspnStats = sameEspnStatsFight
      ? this.espnStatsLast
      : undefined;
    if (this.running) this.stop();

    this.pollers.clear();
    this.running = true;
    this.startedAt = new Date(this.now()).toISOString();
    this.target = target;
    this.espnSeen.clear();
    this.espnLastSample = undefined;
    this.espnPending = undefined;
    this.espnStatsLast = previousEspnStats;
    if (!sameEspnStatsFight) this.espnStatsSampleNumber = 0;
    this.foundCito.clear();
    this.foundSherdog.clear();
    this.kalshiComplete = false;
    this.citoPending = [];
    this.sherdogPending = [];
    if (target.round !== undefined) {
      this.markRoundEnded(target.round, target.boutId);
    }

    this.timeline.record({
      kind: "note",
      source: "lab",
      label: `watcher started (espn=${target.espnEventId ?? "-"}, cito=${(target.citoBoutIds ?? []).join("|") || "-"}, kalshi=${target.redFighter !== undefined && target.blueFighter !== undefined ? "on" : "off"})`,
      detail: { ...target },
    });

    if ((target.espnEventId ?? "").trim().length > 0) {
      this.schedule(
        "espn",
        Math.max(MIN_INTERVAL_MS, target.espnIntervalMs ?? DEFAULT_ESPN_INTERVAL_MS),
        () => this.pollEspn(),
      );
    }
    if (
      (target.espnEventId ?? "").trim().length > 0 &&
      (target.espnBoutId ?? "").trim().length > 0 &&
      (target.espnRedAthleteId ?? "").trim().length > 0 &&
      (target.espnBlueAthleteId ?? "").trim().length > 0
    ) {
      this.schedule(
        "espn-stats",
        Math.max(
          MIN_INTERVAL_MS,
          target.espnStatsIntervalMs ??
            target.espnIntervalMs ??
            DEFAULT_ESPN_INTERVAL_MS,
        ),
        () => this.pollEspnStats(),
      );
    }
    if ((target.citoBoutIds ?? []).length > 0) {
      this.schedule(
        "cito",
        Math.max(MIN_INTERVAL_MS, target.citoIntervalMs ?? DEFAULT_CITO_INTERVAL_MS),
        () => this.pollCito(),
      );
    }
    if (
      (target.redFighter ?? "").trim().length > 0 &&
      (target.blueFighter ?? "").trim().length > 0
    ) {
      this.schedule(
        "kalshi",
        Math.max(
          MIN_INTERVAL_MS,
          target.kalshiIntervalMs ?? DEFAULT_KALSHI_INTERVAL_MS,
        ),
        () => this.pollKalshi(),
      );
    }
    if ((target.sherdogUrl ?? "").trim().length > 0) {
      this.schedule(
        "sherdog",
        Math.max(
          MIN_SHERDOG_INTERVAL_MS,
          target.sherdogIntervalMs ?? DEFAULT_SHERDOG_INTERVAL_MS,
        ),
        () => this.pollSherdog(),
      );
    }

    return this.status();
  }

  stop(): WatchStatus {
    for (const poller of this.pollers.values()) {
      if (poller.timer !== undefined) clearInterval(poller.timer);
      poller.timer = undefined;
      poller.nextAtMs = undefined;
    }
    if (this.running) {
      this.timeline.record({
        kind: "note",
        source: "lab",
        label: "watcher stopped",
      });
    }
    this.running = false;
    const status = this.status();
    this.startedAt = undefined;
    return status;
  }

  stopSource(source: "espn" | "cito"): WatchStatus {
    const names = source === "espn" ? ["espn", "espn-stats"] : ["cito"];
    const active = names.some(
      (name) => this.pollers.get(name)?.timer !== undefined,
    );
    for (const name of names) this.pausePoller(name);
    if (active) {
      this.timeline.record({
        kind: "note",
        source,
        label:
          source === "espn"
            ? "ESPN lifecycle and core-stat polling stopped by user"
            : "CITO polling stopped by user",
      });
    }
    return this.status();
  }

  status(): WatchStatus {
    const nowMs = this.now();
    return {
      running: this.running,
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
      ...(this.target === undefined ? {} : { target: this.target }),
      pollers: [...this.pollers.values()].map((poller) => ({
        name: poller.name,
        active: poller.timer !== undefined,
        polls: poller.polls,
        failures: poller.failures,
        ...(poller.lastAt === undefined ? {} : { lastAt: poller.lastAt }),
        ...(poller.lastMs === undefined ? {} : { lastMs: poller.lastMs }),
        ...(poller.lastError === undefined ? {} : { lastError: poller.lastError }),
        ...(poller.nextAtMs === undefined
          ? {}
          : { nextInMs: Math.max(0, poller.nextAtMs - nowMs) }),
      })),
    };
  }

  /**
   * Runs `body` now and on an interval. `body` is never allowed to reject into
   * the timer: every failure is counted and written to the timeline instead.
   */
  private schedule(
    name: string,
    intervalMs: number,
    body: () => Promise<void>,
  ): void {
    const state: PollerState = this.pollers.get(name) ?? {
      name,
      polls: 0,
      failures: 0,
      intervalMs,
    };
    state.intervalMs = intervalMs;
    this.pollers.set(name, state);

    const tick = (): void => {
      const startedMs = this.now();
      state.nextAtMs = startedMs + state.intervalMs;
      void body()
        .then(() => {
          state.polls += 1;
          state.lastAt = new Date(startedMs).toISOString();
          state.lastMs = this.now() - startedMs;
          state.lastError = undefined;
        })
        .catch((error: unknown) => {
          state.polls += 1;
          state.failures += 1;
          state.lastAt = new Date(startedMs).toISOString();
          state.lastMs = this.now() - startedMs;
          const message =
            error instanceof Error ? error.message : String(error);
          state.lastError = redactSecrets(message);
          this.timeline.record({
            kind: "note",
            source: name,
            label: `poll failed: ${redactSecrets(message)}`,
          });
        });
    };

    const timer = setInterval(tick, intervalMs);
    // The lab must never keep the process alive on its own account.
    timer.unref?.();
    state.timer = timer;
    tick();
  }

  private pausePoller(name: string): void {
    const state = this.pollers.get(name);
    if (state?.timer !== undefined) clearInterval(state.timer);
    if (state !== undefined) {
      state.timer = undefined;
      state.nextAtMs = undefined;
    }
  }

  private async getJson(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<{ json: unknown; remaining?: number }> {
    const response = await this.fetchImpl(url, {
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${text.slice(0, 160)}`);
    }
    const remainingHeader =
      response.headers.get("x-ratelimit-remaining") ??
      response.headers.get("x-requests-remaining");
    const remaining =
      remainingHeader === null ? undefined : Number(remainingHeader);
    return {
      json: JSON.parse(text),
      ...(remaining === undefined || !Number.isFinite(remaining)
        ? {}
        : { remaining }),
    };
  }

  // -- ESPN -----------------------------------------------------------------

  /**
   * ESPN is free and is the lifecycle authority, so every five-second sample
   * is logged while a fight watch is active. That preserves the raw reported
   * clock, period and state alongside the locally projected clock correction.
   * A round marker additionally arms the explicit round-end signal detector.
   */
  private async pollEspn(): Promise<void> {
    const pending = this.espnPending;
    const eventId = this.target?.espnEventId?.trim() ?? "";
    const labBoutId = pending?.labBoutId ?? this.target?.boutId;
    const espnBoutId = pending?.espnBoutId ?? this.target?.espnBoutId;
    if (
      eventId.length === 0 ||
      labBoutId === undefined ||
      espnBoutId === undefined
    ) {
      return;
    }

    const { json } = await this.getJson(buildEspnScoreboardUrl());
    // ESPN ignores an `event` query param, so the event is selected here.
    const entries = parseEspnScoreboardLifecycle(json, eventId);
    const observedAtMs = this.now();
    const observedAt = new Date(observedAtMs).toISOString();
    const entry = entries.find(
      (candidate) => candidate.externalId === espnBoutId,
    );
    if (entry === undefined) {
      if (this.espnSeen.get(espnBoutId) !== "missing") {
        this.espnSeen.set(espnBoutId, "missing");
        this.timeline.record({
          kind: "observation",
          source: "espn",
          at: observedAt,
          boutId: labBoutId,
          ...(pending === undefined ? {} : { round: pending.round }),
          label: "ESPN response did not include the selected fight",
          detail: {
            roundEnded: false,
            espnBoutId,
            fightsInResponse: entries.length,
          },
        });
      }
      return;
    }

    const key = espnFingerprint(entry);
    const previous = this.espnSeen.get(entry.externalId);
    const signal =
      pending === undefined
        ? undefined
        : espnRoundEndSignal(entry, pending.round);
    const clockCorrectionSeconds = espnClockCorrectionSeconds(
      this.espnLastSample,
      entry,
      observedAtMs,
    );
    const transition = espnTransition(this.espnLastSample?.entry, entry);
    this.espnSeen.set(entry.externalId, key);
    this.espnLastSample = { atMs: observedAtMs, entry };

    const roundEnded = signal !== undefined;
    this.timeline.record({
      kind: "observation",
      source: "espn",
      at: observedAt,
      boutId: labBoutId,
      round: pending?.round ?? entry.period,
      label: roundEnded
        ? `ESPN announced round ${pending?.round ?? entry.period} done (${describeEspnSignal(signal)})`
        : transition === undefined
          ? `ESPN reports ${describeEspnState(entry)}`
          : `ESPN changed ${describeEspnTransition(transition, entry)}`,
      detail: {
        roundEnded,
        ...(signal === undefined ? {} : { signal }),
        changed: previous !== key,
        ...(transition === undefined ? {} : { transition }),
        ...(clockCorrectionSeconds === undefined
          ? {}
          : { clockCorrectionSeconds }),
        espnBoutId,
        lifecycle: { ...entry },
      },
    });

    if (roundEnded) {
      this.espnPending = undefined;
      if (this.target?.continuousEspn !== true) {
        this.pausePoller("espn");
      }
    }
  }

  /**
   * ESPN's core endpoint exposes one fight-cumulative split per fighter. Every
   * sample is kept, including identical ones, because the lab is measuring
   * publication timing and cache behavior rather than manufacturing rounds.
   */
  private async pollEspnStats(): Promise<void> {
    const eventId = this.target?.espnEventId?.trim() ?? "";
    const competitionId = this.target?.espnBoutId?.trim() ?? "";
    const redAthleteId = this.target?.espnRedAthleteId?.trim() ?? "";
    const blueAthleteId = this.target?.espnBlueAthleteId?.trim() ?? "";
    const boutId = this.target?.boutId;
    if (
      eventId.length === 0 ||
      competitionId.length === 0 ||
      redAthleteId.length === 0 ||
      blueAthleteId.length === 0 ||
      boutId === undefined
    ) {
      return;
    }

    const [red, blue] = await Promise.all([
      fetchEspnCoreStats({
        eventId,
        competitionId,
        athleteId: redAthleteId,
        fetchImpl: this.fetchImpl,
        now: this.now,
      }),
      fetchEspnCoreStats({
        eventId,
        competitionId,
        athleteId: blueAthleteId,
        fetchImpl: this.fetchImpl,
        now: this.now,
      }),
    ]);
    const previous =
      this.espnStatsLast?.boutId === boutId
        ? this.espnStatsLast
        : undefined;
    const redChanges = diffEspnCoreStats(previous?.red, red);
    const blueChanges = diffEspnCoreStats(previous?.blue, blue);
    const previousHadValues =
      previous !== undefined &&
      (hasNonzeroEspnCoreStats(previous.red) ||
        hasNonzeroEspnCoreStats(previous.blue));
    const hasValues =
      hasNonzeroEspnCoreStats(red) || hasNonzeroEspnCoreStats(blue);
    const firstNonzero = !previousHadValues && hasValues;
    const changedFields = [
      ...redChanges.map((change) => ({ corner: "red", ...change })),
      ...blueChanges.map((change) => ({ corner: "blue", ...change })),
    ];
    const sampleNumber = ++this.espnStatsSampleNumber;
    this.espnStatsLast = { boutId, red, blue };

    this.timeline.record({
      kind: "observation",
      source: "espn-stats",
      at: maxIsoTimestamp(red.response.receivedAt, blue.response.receivedAt),
      boutId,
      ...(this.target?.round === undefined
        ? {}
        : { round: this.target.round }),
      label:
        changedFields.length === 0
          ? `ESPN cumulative stats sample ${sampleNumber} — no field changes`
          : `ESPN cumulative stats sample ${sampleNumber} — ${changedFields.length} fields changed`,
      detail: {
        cumulativeOnly: true,
        exactRoundStats: false,
        sampleNumber,
        firstNonzero,
        hasValues,
        changedCount: changedFields.length,
        changedFields,
        responseChanged:
          previous === undefined ||
          previous.red.response.sha256 !== red.response.sha256 ||
          previous.blue.response.sha256 !== blue.response.sha256,
        red,
        blue,
      },
    });
  }

  // -- Cito -----------------------------------------------------------------

  /**
   * Asks only about rounds nobody has answered yet, and records the first
   * moment a round's stats exist. `availability` is reported as well, because
   * "HTTP 200 with an empty array" is Cito's way of saying "not yet" and it is
   * indistinguishable from a parse failure unless you look.
   */
  private async pollCito(): Promise<void> {
    if (this.citoPending.length === 0) return;

    const base = this.env.CITO_API_BASE_URL?.trim() ?? "";
    const apiKey = this.env.CITO_API_KEY?.trim() ?? "";
    if (base.length === 0 || apiKey.length === 0) {
      throw new Error("CITO_API_BASE_URL and CITO_API_KEY must be set");
    }

    // One pending question per tick keeps the cadence honest: the latency we
    // report is the latency of a single request, not of a queue.
    const pending = this.citoPending[0];
    if (pending === undefined) return;
    pending.polls += 1;

    const { json, remaining } = await this.getJson(
      buildCitoRoundStatsUrl(base, pending.boutId, pending.round),
      { "x-api-key": apiKey },
    );
    const observedAt = new Date(this.now()).toISOString();

    const data = (json as { data?: unknown }).data;
    const rows = Array.isArray((data as { roundStats?: unknown })?.roundStats)
      ? ((data as { roundStats: unknown[] }).roundStats)
      : [];
    const availability = (data as { availability?: unknown })?.availability;

    if (rows.length > 0) {
      this.foundCito.add(`${pending.boutId}:${pending.round}`);
      this.citoPending = this.citoPending.filter((entry) => entry !== pending);
      this.timeline.record({
        kind: "observation",
        source: "cito",
        at: observedAt,
        boutId: pending.boutId,
        round: pending.round,
        label: `round ${pending.round} stats published (${rows.length} rows, ${pending.polls} polls)`,
        detail: { availability, rows },
      });
      this.pausePoller("cito");
      return;
    }

    if (pending.polls >= MAX_PENDING_POLLS) {
      this.citoPending = this.citoPending.filter((entry) => entry !== pending);
      this.timeline.record({
        kind: "note",
        source: "cito",
        at: observedAt,
        boutId: pending.boutId,
        round: pending.round,
        label: `gave up on round ${pending.round} after ${pending.polls} polls (availability: ${String(availability)})`,
      });
      return;
    }

    this.applyQuotaBackoff("cito", remaining);
  }

  // -- Kalshi ---------------------------------------------------------------

  /** Captures the selected fight's public win-market prices at the horn. */
  private async pollKalshi(): Promise<void> {
    if (this.kalshiComplete) return;
    const labBoutId = this.target?.boutId;
    const round = this.target?.round;
    const redFighter = this.target?.redFighter?.trim();
    const blueFighter = this.target?.blueFighter?.trim();
    if (
      labBoutId === undefined ||
      round === undefined ||
      redFighter === undefined ||
      blueFighter === undefined
    ) {
      return;
    }

    const { json } = await this.getJson(buildKalshiUpcomingUrl(200));
    const observedAt = new Date(this.now()).toISOString();
    const markets = parseKalshiUpcomingMarkets(json);
    const match = markets
      .map((market) => ({
        market,
        pair: matchFighterPair(
          { redFighter, blueFighter },
          {
            redFighter: market.firstFighter,
            blueFighter: market.secondFighter,
          },
        ),
      }))
      .sort((left, right) => right.pair.confidence - left.pair.confidence)[0];

    if (match === undefined || match.pair.confidence < 0.85) {
      this.timeline.record({
        kind: "observation",
        source: "kalshi",
        at: observedAt,
        boutId: labBoutId,
        round,
        label: "No matching Kalshi market is listed for this fight",
        detail: { listed: false, marketsInResponse: markets.length },
      });
    } else {
      const first = match.market.quotes.find((quote) => quote.side === "first");
      const second = match.market.quotes.find((quote) => quote.side === "second");
      const [redQuote, blueQuote] = match.pair.cornersReversed
        ? [second, first]
        : [first, second];
      const red = {
        fighter: redFighter,
        yesCents: kalshiYesCents(redQuote?.native),
        probability: redQuote?.impliedProbability,
      };
      const blue = {
        fighter: blueFighter,
        yesCents: kalshiYesCents(blueQuote?.native),
        probability: blueQuote?.impliedProbability,
      };
      this.timeline.record({
        kind: "observation",
        source: "kalshi",
        at: observedAt,
        boutId: labBoutId,
        round,
        label: `Kalshi snapshot: ${redFighter} ${displayCents(red.yesCents)}, ${blueFighter} ${displayCents(blue.yesCents)}`,
        detail: {
          listed: true,
          externalId: match.market.externalId,
          confidence: match.pair.confidence,
          red,
          blue,
        },
      });
    }

    this.kalshiComplete = true;
    this.pausePoller("kalshi");
  }

  // -- Sherdog --------------------------------------------------------------

  /** Records the first poll on which a pending round's commentary exists. */
  private async pollSherdog(): Promise<void> {
    if (this.sherdogPending.length === 0) return;
    const url = this.target?.sherdogUrl?.trim() ?? "";
    if (url.length === 0) return;
    if ((this.env.SHERDOG_PERMISSION_SCOPE?.trim() ?? "").length === 0) {
      throw new Error("SHERDOG_PERMISSION_SCOPE is not set");
    }

    const observedAt = new Date(this.now()).toISOString();
    const response = await this.fetchImpl(url, {
      headers: { "user-agent": "ufc-live-dashboard/0.1 (personal use)" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const html = await response.text();
    if (!response.ok) {
      // 403 is a stop signal by design, never something to work around.
      throw new Error(`HTTP ${response.status}`);
    }

    const observations = await parseSherdogRoundObservations({
      boutId: "lab-watch",
      html,
      sourceUrl: url,
      fetchedAt: observedAt,
    });

    for (const pending of [...this.sherdogPending]) {
      pending.polls += 1;
      const match = observations.find(
        (observation) => observation.round === pending.round,
      );
      if (match !== undefined) {
        this.foundSherdog.add(`sherdog:${pending.round}`);
        this.sherdogPending = this.sherdogPending.filter(
          (entry) => entry !== pending,
        );
        this.timeline.record({
          kind: "observation",
          source: "sherdog",
          at: observedAt,
          round: pending.round,
          label: `round ${pending.round} published (${match.commentary.length} chars, ${match.scorerCards.length} scorer cards, ${pending.polls} polls)`,
          detail: {
            commentary: match.commentary.slice(0, 400),
            scorerCards: match.scorerCards,
          },
        });
        continue;
      }
      if (pending.polls >= MAX_PENDING_POLLS) {
        this.sherdogPending = this.sherdogPending.filter(
          (entry) => entry !== pending,
        );
        this.timeline.record({
          kind: "note",
          source: "sherdog",
          at: observedAt,
          round: pending.round,
          label: `gave up on round ${pending.round} after ${pending.polls} polls`,
        });
      }
    }
  }

  /**
   * Slows a poller down when the vendor says the allowance is nearly gone.
   * Announced on the timeline, because a silently slower poller would corrupt
   * every latency measured after it.
   */
  private applyQuotaBackoff(name: string, remaining: number | undefined): void {
    if (remaining === undefined || remaining > QUOTA_FLOOR) return;
    const state = this.pollers.get(name);
    if (state === undefined || state.intervalMs >= QUOTA_BACKOFF_MS) return;

    this.timeline.record({
      kind: "note",
      source: name,
      label: `quota low (${remaining} left) — slowing polls to ${QUOTA_BACKOFF_MS / 1000}s; latencies after this are coarser`,
    });
    if (state.timer !== undefined) clearInterval(state.timer);
    state.timer = undefined;
    this.schedule(name, QUOTA_BACKOFF_MS, async () => {
      if (name === "cito") await this.pollCito();
    });
  }
}

function espnFingerprint(entry: EspnLifecycleEntry): string {
  // The clock is bucketed to whole seconds so a poll that lands mid-second
  // does not read as a change; zero is kept distinct because "clock reached
  // 0:00" is one of the transitions being measured.
  return [
    entry.state,
    entry.period,
    entry.completed,
    entry.clockSeconds === undefined ? "-" : Math.round(entry.clockSeconds),
  ].join("/");
}

function maxIsoTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function espnClockCorrectionSeconds(
  previous: EspnSample | undefined,
  current: EspnLifecycleEntry,
  currentAtMs: number,
): number | undefined {
  if (
    previous?.entry.clockSeconds === undefined ||
    current.clockSeconds === undefined ||
    previous.entry.period !== current.period ||
    previous.entry.state !== "in" ||
    current.state !== "in"
  ) {
    return undefined;
  }
  const elapsedSeconds = Math.max(0, (currentAtMs - previous.atMs) / 1_000);
  const projectedClock = Math.max(
    0,
    previous.entry.clockSeconds - elapsedSeconds,
  );
  return Number((current.clockSeconds - projectedClock).toFixed(3));
}

interface EspnTransition {
  previousPeriod: number;
  period: number;
  previousState: EspnLifecycleEntry["state"];
  state: EspnLifecycleEntry["state"];
  previousCompleted: boolean;
  completed: boolean;
}

function espnTransition(
  previous: EspnLifecycleEntry | undefined,
  current: EspnLifecycleEntry,
): EspnTransition | undefined {
  if (
    previous === undefined ||
    (previous.period === current.period &&
      previous.state === current.state &&
      previous.completed === current.completed)
  ) {
    return undefined;
  }
  return {
    previousPeriod: previous.period,
    period: current.period,
    previousState: previous.state,
    state: current.state,
    previousCompleted: previous.completed,
    completed: current.completed,
  };
}

function describeEspnTransition(
  transition: EspnTransition,
  current: EspnLifecycleEntry,
): string {
  const clock =
    current.clockSeconds === undefined
      ? "no clock"
      : formatEspnClock(current.clockSeconds);
  if (transition.previousPeriod !== transition.period) {
    return `round ${transition.previousPeriod} → ${transition.period} · ${clock} · ${current.state}`;
  }
  if (transition.previousState !== transition.state) {
    return `state ${transition.previousState} → ${transition.state} · round ${current.period} · ${clock}`;
  }
  return `completion ${transition.previousCompleted} → ${transition.completed} · round ${current.period} · ${clock}`;
}

function formatEspnClock(clockSeconds: number): string {
  const seconds = Math.max(0, Math.round(clockSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

type EspnRoundEndSignal = "clock_zero" | "period_advanced" | "bout_completed";

function espnRoundEndSignal(
  entry: EspnLifecycleEntry,
  round: number,
): EspnRoundEndSignal | undefined {
  if (entry.completed && entry.period >= round) return "bout_completed";
  if (entry.period > round) return "period_advanced";
  if (entry.period === round && entry.clockSeconds === 0) return "clock_zero";
  return undefined;
}

function describeEspnState(entry: EspnLifecycleEntry): string {
  const clock =
    entry.clockSeconds === undefined
      ? "no clock"
      : `clock ${entry.clockSeconds}s`;
  return `${entry.state} · round ${entry.period} · ${clock}`;
}

function describeEspnSignal(signal: EspnRoundEndSignal): string {
  switch (signal) {
    case "clock_zero":
      return "clock reached 0:00";
    case "period_advanced":
      return "next round appeared";
    case "bout_completed":
      return "bout marked complete";
  }
}

function kalshiYesCents(native: unknown): number | undefined {
  if (typeof native !== "object" || native === null) return undefined;
  const value = native as { kind?: unknown; yesCents?: unknown };
  return value.kind === "kalshi-cents" &&
    typeof value.yesCents === "number" &&
    Number.isFinite(value.yesCents)
    ? value.yesCents
    : undefined;
}

function displayCents(value: number | undefined): string {
  return value === undefined ? "unpriced" : `${value.toFixed(1)}¢`;
}
