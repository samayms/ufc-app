import type {
  Bout,
  DashboardState,
  ExpertConsensus,
  RoundStats,
  RoundUpdate,
  SherdogRoundObservation,
} from "../schema.ts";
import type { MarketSnapshot } from "../sources/contract.ts";
import type { ParsedExpertScore } from "../sources/x.ts";

export const DEFAULT_COLLECTOR_PORT = 8600;

export type CollectorConnectionState =
  | "connected"
  | "reconnecting"
  | "unavailable";

export type CollectorHealthStatus =
  | "healthy"
  | "stale"
  | "degraded"
  | "unavailable";

export interface CollectorSourceHealth {
  source: string;
  status: CollectorHealthStatus;
  fresh: boolean;
  checkedAt: string;
  sourceUpdatedAt?: string;
  message?: string;
}

interface CollectorFighterRoundStats extends RoundStats {
  significantStrikes: number;
  totalStrikes: number;
  takedowns: number;
  takedownsAttempted: number;
  controlTimeSeconds: number;
  knockdowns: number;
}

interface CollectorRoundStats {
  boutId: string;
  round: number;
  fighterA: CollectorFighterRoundStats;
  fighterB: CollectorFighterRoundStats;
  provisional: boolean;
  revision: number;
  sourceUpdatedAt?: string;
  firstObservedAt: string;
  lastObservedAt: string;
}

export interface CollectorUnifiedRound {
  boutId: string;
  round: number;
  detectedEndedAt: string;
  endingSignal:
    | "clock_zero_provisional"
    | "period_transition"
    | "fight_completed";
  citoStats?: CollectorRoundStats;
  sherdog?: SherdogRoundObservation;
  xScores?: ParsedExpertScore[];
  marketAtEnd: {
    kalshi?: MarketSnapshot;
    polymarket?: MarketSnapshot;
    oddsApiIo?: MarketSnapshot;
    theOddsApi?: MarketSnapshot;
  };
  expertConsensus?: ExpertConsensus;
  provisional: boolean;
  finalizedAt?: string;
}

type CollectorLifecycleEvent =
  | { type: "FIGHT_STARTED"; boutId: string; detectedAt: string }
  | {
      type: "PROVISIONAL_ROUND_ENDED";
      boutId: string;
      round: number;
      detectedAt: string;
    }
  | {
      type: "ROUND_ENDED";
      boutId: string;
      round: number;
      detectedAt: string;
      confirmation: "period_transition" | "fight_completed";
    }
  | {
      type: "FIGHT_ENDED";
      boutId: string;
      round: number;
      detectedAt: string;
    };

export interface CollectorLifecycleDelivery {
  boutId: string;
  source: "collector lifecycle";
  sourceUpdatedAt: string;
  receivedAt: string;
  provisional: boolean;
}

export interface CollectorValueDelivery {
  source: string;
  sourceUpdatedAt?: string;
  receivedAt: string;
  stale: boolean;
  provisional: boolean;
  revision?: number;
}

export interface CollectorSnapshot {
  connection: CollectorConnectionState;
  dashboard: DashboardState | null;
  health: Readonly<Record<string, CollectorSourceHealth>>;
  unifiedRounds: readonly CollectorUnifiedRound[];
  lifecycle: Readonly<Record<string, CollectorLifecycleDelivery>>;
  lastReceivedAt?: string;
}

export interface CollectorClient {
  getSnapshot(): CollectorSnapshot;
  start(): Promise<void>;
  subscribe(listener: (snapshot: CollectorSnapshot) => void): () => void;
  close(): void;
}

interface CollectorBootstrap {
  state: DashboardState | null;
  health: Record<string, CollectorSourceHealth>;
  unifiedRounds: CollectorUnifiedRound[];
}

interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: EventListener): void;
  close(): void;
}

export interface CollectorClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  createEventSource?: (url: string) => EventSourceLike;
  now?: () => string;
  bootstrapTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value))
  );
}

function isDashboardState(value: unknown): value is DashboardState {
  return (
    isRecord(value) &&
    isRecord(value.event) &&
    typeof value.event.id === "string" &&
    Array.isArray(value.event.bouts) &&
    isRecord(value.boutViews) &&
    Array.isArray(value.scorecardAccounts)
  );
}

function isCollectorHealthStatus(
  value: unknown,
): value is CollectorHealthStatus {
  return (
    value === "healthy" ||
    value === "stale" ||
    value === "degraded" ||
    value === "unavailable"
  );
}

function parseHealth(value: unknown): CollectorSourceHealth | null {
  if (
    !isRecord(value) ||
    typeof value.source !== "string" ||
    !isCollectorHealthStatus(value.status) ||
    typeof value.fresh !== "boolean" ||
    !isTimestamp(value.checkedAt) ||
    (value.sourceUpdatedAt !== undefined &&
      !isTimestamp(value.sourceUpdatedAt)) ||
    (value.message !== undefined && typeof value.message !== "string")
  ) {
    return null;
  }

  return {
    source: value.source,
    status: value.status,
    fresh: value.fresh,
    checkedAt: value.checkedAt,
    ...(value.sourceUpdatedAt === undefined
      ? {}
      : { sourceUpdatedAt: value.sourceUpdatedAt }),
    ...(value.message === undefined ? {} : { message: value.message }),
  };
}

function parseHealthMap(
  value: unknown,
): Record<string, CollectorSourceHealth> {
  if (!isRecord(value)) return {};

  const health: Record<string, CollectorSourceHealth> = {};
  for (const entry of Object.values(value)) {
    const parsed = parseHealth(entry);
    if (parsed !== null) health[parsed.source] = parsed;
  }
  return health;
}

const STAT_KEYS = [
  "significantStrikes",
  "totalStrikes",
  "takedowns",
  "takedownsAttempted",
  "controlTimeSeconds",
  "knockdowns",
] as const;

function parseFighterStats(
  value: unknown,
): CollectorFighterRoundStats | null {
  if (!isRecord(value)) return null;

  const stats = {} as CollectorFighterRoundStats;
  for (const key of STAT_KEYS) {
    const stat = value[key];
    if (
      typeof stat !== "number" ||
      !Number.isFinite(stat) ||
      stat < 0
    ) {
      return null;
    }
    stats[key] = stat;
  }
  return stats;
}

function parseRoundStats(value: unknown): CollectorRoundStats | null {
  if (!isRecord(value)) return null;
  const fighterA = parseFighterStats(value.fighterA);
  const fighterB = parseFighterStats(value.fighterB);

  if (
    typeof value.boutId !== "string" ||
    !Number.isSafeInteger(value.round) ||
    (value.round as number) < 1 ||
    fighterA === null ||
    fighterB === null ||
    typeof value.provisional !== "boolean" ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    (value.sourceUpdatedAt !== undefined &&
      !isTimestamp(value.sourceUpdatedAt)) ||
    !isTimestamp(value.firstObservedAt) ||
    !isTimestamp(value.lastObservedAt)
  ) {
    return null;
  }

  return {
    boutId: value.boutId,
    round: value.round as number,
    fighterA,
    fighterB,
    provisional: value.provisional,
    revision: value.revision as number,
    ...(value.sourceUpdatedAt === undefined
      ? {}
      : { sourceUpdatedAt: value.sourceUpdatedAt }),
    firstObservedAt: value.firstObservedAt,
    lastObservedAt: value.lastObservedAt,
  };
}

function parseSherdogObservation(
  value: unknown,
): SherdogRoundObservation | null {
  if (
    !isRecord(value) ||
    typeof value.boutId !== "string" ||
    !Number.isSafeInteger(value.round) ||
    (value.round as number) < 1 ||
    typeof value.commentary !== "string" ||
    /<[^>]*>/.test(value.commentary) ||
    !Array.isArray(value.scorerCards) ||
    typeof value.sourceUrl !== "string" ||
    (value.publishedAt !== undefined &&
      !isTimestamp(value.publishedAt)) ||
    !isTimestamp(value.fetchedAt) ||
    typeof value.parserVersion !== "string" ||
    typeof value.payloadHash !== "string"
  ) {
    return null;
  }
  const scorerCards = value.scorerCards.flatMap((card) => {
    if (
      !isRecord(card) ||
      typeof card.scorer !== "string" ||
      (card.winner !== undefined && typeof card.winner !== "string") ||
      (card.roundScore !== undefined &&
        typeof card.roundScore !== "string") ||
      (card.cumulativeScore !== undefined &&
        typeof card.cumulativeScore !== "string")
    ) {
      return [];
    }
    return [
      {
        scorer: card.scorer,
        ...(card.winner === undefined ? {} : { winner: card.winner }),
        ...(card.roundScore === undefined
          ? {}
          : { roundScore: card.roundScore }),
        ...(card.cumulativeScore === undefined
          ? {}
          : { cumulativeScore: card.cumulativeScore }),
      },
    ];
  });
  if (scorerCards.length !== value.scorerCards.length) return null;

  return {
    boutId: value.boutId,
    round: value.round as number,
    commentary: value.commentary,
    scorerCards,
    sourceUrl: value.sourceUrl,
    ...(value.publishedAt === undefined
      ? {}
      : { publishedAt: value.publishedAt }),
    fetchedAt: value.fetchedAt,
    parserVersion: value.parserVersion,
    payloadHash: value.payloadHash,
  };
}

function parseExpertScore(value: unknown): ParsedExpertScore | null {
  if (
    !isRecord(value) ||
    value.source !== "x" ||
    typeof value.sourcePostId !== "string" ||
    typeof value.scorer !== "string" ||
    !Number.isSafeInteger(value.round) ||
    (value.round as number) < 1 ||
    !isRecord(value.score) ||
    !Number.isSafeInteger(value.score.red) ||
    !Number.isSafeInteger(value.score.blue) ||
    !isTimestamp(value.fetchedAt) ||
    typeof value.parseConfidence !== "number" ||
    value.parseConfidence < 0 ||
    value.parseConfidence > 1 ||
    (value.mode !== "embed" &&
      value.mode !== "manual" &&
      value.mode !== "api") ||
    typeof value.postUrl !== "string"
  ) {
    return null;
  }
  return {
    source: "x",
    sourcePostId: value.sourcePostId,
    scorer: value.scorer,
    round: value.round as number,
    score: {
      red: value.score.red as number,
      blue: value.score.blue as number,
    },
    fetchedAt: value.fetchedAt,
    parseConfidence: value.parseConfidence,
    mode: value.mode,
    postUrl: value.postUrl,
  };
}

function parseExpertConsensus(value: unknown): ExpertConsensus | null {
  if (!isRecord(value)) return null;
  const result: ExpertConsensus = {};
  for (const source of ["sherdog", "x"] as const) {
    const candidate = value[source];
    if (candidate === undefined) continue;
    if (
      !isRecord(candidate) ||
      candidate.source !== source ||
      !Number.isSafeInteger(candidate.redVotes) ||
      (candidate.redVotes as number) < 0 ||
      !Number.isSafeInteger(candidate.blueVotes) ||
      (candidate.blueVotes as number) < 0 ||
      !Number.isSafeInteger(candidate.drawVotes) ||
      (candidate.drawVotes as number) < 0 ||
      !Number.isSafeInteger(candidate.total) ||
      (candidate.total as number) < 1 ||
      (candidate.leader !== undefined &&
        candidate.leader !== "red" &&
        candidate.leader !== "blue" &&
        candidate.leader !== "draw")
    ) {
      return null;
    }
    result[source] = {
      source,
      redVotes: candidate.redVotes as number,
      blueVotes: candidate.blueVotes as number,
      drawVotes: candidate.drawVotes as number,
      total: candidate.total as number,
      ...(candidate.leader === undefined
        ? {}
        : { leader: candidate.leader }),
    };
  }
  return result;
}

function parseUnifiedRound(value: unknown): CollectorUnifiedRound | null {
  if (!isRecord(value)) return null;
  const citoStats =
    value.citoStats === undefined
      ? undefined
      : parseRoundStats(value.citoStats);
  const sherdog =
    value.sherdog === undefined
      ? undefined
      : parseSherdogObservation(value.sherdog);
  const xScores =
    value.xScores === undefined
      ? undefined
      : Array.isArray(value.xScores)
        ? value.xScores
            .map(parseExpertScore)
            .filter(
              (score): score is ParsedExpertScore => score !== null,
            )
        : null;
  const expertConsensus =
    value.expertConsensus === undefined
      ? undefined
      : parseExpertConsensus(value.expertConsensus);

  if (
    typeof value.boutId !== "string" ||
    !Number.isSafeInteger(value.round) ||
    (value.round as number) < 1 ||
    !isTimestamp(value.detectedEndedAt) ||
    (value.endingSignal !== "clock_zero_provisional" &&
      value.endingSignal !== "period_transition" &&
      value.endingSignal !== "fight_completed") ||
    (value.citoStats !== undefined && citoStats === null) ||
    (value.sherdog !== undefined && sherdog === null) ||
    xScores === null ||
    (Array.isArray(value.xScores) &&
      (xScores?.length ?? 0) !== value.xScores.length) ||
    (value.expertConsensus !== undefined &&
      expertConsensus === null) ||
    !isRecord(value.marketAtEnd) ||
    typeof value.provisional !== "boolean" ||
    (value.finalizedAt !== undefined && !isTimestamp(value.finalizedAt))
  ) {
    return null;
  }

  return {
    boutId: value.boutId,
    round: value.round as number,
    detectedEndedAt: value.detectedEndedAt,
    endingSignal: value.endingSignal,
    ...(citoStats == null ? {} : { citoStats }),
    ...(sherdog == null ? {} : { sherdog }),
    ...(xScores === undefined ? {} : { xScores }),
    marketAtEnd: value.marketAtEnd as CollectorUnifiedRound["marketAtEnd"],
    ...(expertConsensus == null ? {} : { expertConsensus }),
    provisional: value.provisional,
    ...(value.finalizedAt === undefined
      ? {}
      : { finalizedAt: value.finalizedAt }),
  };
}

function parseBootstrap(value: unknown): CollectorBootstrap | null {
  if (
    !isRecord(value) ||
    (value.state !== null && !isDashboardState(value.state)) ||
    !Array.isArray(value.unifiedRounds)
  ) {
    return null;
  }

  return {
    state: value.state,
    health: parseHealthMap(value.health),
    unifiedRounds: value.unifiedRounds
      .map(parseUnifiedRound)
      .filter(
        (round): round is CollectorUnifiedRound => round !== null,
      ),
  };
}

function parseLifecycleEvent(
  value: unknown,
): CollectorLifecycleEvent | null {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    typeof value.boutId !== "string" ||
    !isTimestamp(value.detectedAt)
  ) {
    return null;
  }

  if (value.type === "FIGHT_STARTED") {
    return {
      type: value.type,
      boutId: value.boutId,
      detectedAt: value.detectedAt,
    };
  }

  if (
    (value.type === "PROVISIONAL_ROUND_ENDED" ||
      value.type === "FIGHT_ENDED") &&
    Number.isSafeInteger(value.round) &&
    (value.round as number) >= 1
  ) {
    return {
      type: value.type,
      boutId: value.boutId,
      round: value.round as number,
      detectedAt: value.detectedAt,
    };
  }

  if (
    value.type === "ROUND_ENDED" &&
    Number.isSafeInteger(value.round) &&
    (value.round as number) >= 1 &&
    (value.confirmation === "period_transition" ||
      value.confirmation === "fight_completed")
  ) {
    return {
      type: value.type,
      boutId: value.boutId,
      round: value.round as number,
      detectedAt: value.detectedAt,
      confirmation: value.confirmation,
    };
  }

  return null;
}

function replaceBout(
  dashboard: DashboardState,
  boutId: string,
  update: (bout: Bout) => Bout,
): DashboardState {
  const currentView = dashboard.boutViews[boutId];
  if (currentView === undefined) return dashboard;
  const nextBout = update(currentView.bout);

  return {
    ...dashboard,
    event: {
      ...dashboard.event,
      bouts: dashboard.event.bouts.map((bout) =>
        bout.id === boutId ? nextBout : bout,
      ),
    },
    boutViews: {
      ...dashboard.boutViews,
      [boutId]: {
        ...currentView,
        bout: nextBout,
      },
    },
  };
}

export function applyCollectorLifecycle(
  dashboard: DashboardState,
  event: CollectorLifecycleEvent,
): DashboardState {
  return replaceBout(dashboard, event.boutId, (bout) => {
    switch (event.type) {
      case "FIGHT_STARTED":
        return {
          ...bout,
          status: "in-round",
          currentRound: bout.currentRound ?? 1,
        };
      case "PROVISIONAL_ROUND_ENDED":
      case "ROUND_ENDED":
        return {
          ...bout,
          status: "between-rounds",
          currentRound: event.round,
        };
      case "FIGHT_ENDED":
        return {
          ...bout,
          status: "final",
          currentRound: event.round,
        };
    }
  });
}

function applyCollectorRound(
  dashboard: DashboardState,
  record: CollectorUnifiedRound,
): DashboardState {
  const withLifecycle = replaceBout(
    dashboard,
    record.boutId,
    (bout) => {
      if (
        bout.status === "final" ||
        bout.status === "canceled" ||
        bout.status === "postponed"
      ) {
        return bout;
      }
      return {
        ...bout,
        status:
          record.endingSignal === "fight_completed"
            ? "final"
            : "between-rounds",
        currentRound: record.round,
      };
    },
  );
  const view = withLifecycle.boutViews[record.boutId];
  if (view === undefined) return withLifecycle;

  const nextRounds = { ...view.rounds };
  if (record.citoStats !== undefined) {
    const stats = record.citoStats;
    const existing = view.rounds.cito ?? [];
    const previous = existing.find(
      (round) => round.round === record.round,
    );
    const update: RoundUpdate = {
      ...(previous ?? {
        boutId: record.boutId,
        round: record.round,
      }),
      stats: {
        red: { ...stats.fighterA },
        blue: { ...stats.fighterB },
      },
      provenance: {
        source: "cito",
        fetchedAt: stats.lastObservedAt,
        synthetic: withLifecycle.event.provenance.synthetic,
      },
    };
    nextRounds.cito = [
      ...existing.filter((round) => round.round !== record.round),
      update,
    ].sort((left, right) => left.round - right.round);
  }

  if (record.sherdog !== undefined) {
    const observation = record.sherdog;
    const existing = view.rounds.sherdog ?? [];
    const scoreCard = observation.scorerCards.find(
      (card) => card.roundScore !== undefined && card.winner !== undefined,
    );
    const scoreMatch = /^(\d+)\s*-\s*(\d+)$/.exec(
      scoreCard?.roundScore ?? "",
    );
    const normalizedWinner = scoreCard?.winner
      ?.normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^\p{Letter}\p{Number}]/gu, "")
      .toLocaleLowerCase("en");
    const winner = (["red", "blue"] as const).find((corner) => {
      const name = view.bout.fighters[corner].name;
      const full = name
        .normalize("NFKD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/[^\p{Letter}\p{Number}]/gu, "")
        .toLocaleLowerCase("en");
      const last = name
        .split(/\s+/)
        .at(-1)
        ?.normalize("NFKD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/[^\p{Letter}\p{Number}]/gu, "")
        .toLocaleLowerCase("en");
      return normalizedWinner === full || normalizedWinner === last;
    });
    const high = Number(scoreMatch?.[1]);
    const low = Number(scoreMatch?.[2]);
    const update: RoundUpdate = {
      boutId: record.boutId,
      round: record.round,
      ...(observation.commentary.length === 0
        ? {}
        : { summary: observation.commentary }),
      ...(winner === undefined ||
      !Number.isFinite(high) ||
      !Number.isFinite(low)
        ? {}
        : {
            score:
              winner === "red"
                ? { red: high, blue: low }
                : { red: low, blue: high },
          }),
      provenance: {
        source: "sherdog",
        fetchedAt: observation.fetchedAt,
        synthetic: withLifecycle.event.provenance.synthetic,
      },
    };
    nextRounds.sherdog = [
      ...existing.filter((round) => round.round !== record.round),
      update,
    ].sort((left, right) => left.round - right.round);
  }

  const scorecards = [
    ...view.scorecards,
    ...(record.xScores ?? []).flatMap((score) =>
      score.mode !== "embed"
        ? []
        : [
            {
              boutId: record.boutId,
              handle: score.scorer.replace(/^@/, ""),
              postId: score.sourcePostId,
              round: score.round,
              provenance: {
                source: "x-embed" as const,
                fetchedAt: score.fetchedAt,
                synthetic: withLifecycle.event.provenance.synthetic,
              },
            },
          ],
    ),
  ].filter(
    (scorecard, index, all) =>
      all.findIndex(
        (candidate) => candidate.postId === scorecard.postId,
      ) === index,
  );

  return {
    ...withLifecycle,
    boutViews: {
      ...withLifecycle.boutViews,
      [record.boutId]: {
        ...view,
        rounds: nextRounds,
        scorecards,
      },
    },
  };
}

function applyCollectorRounds(
  dashboard: DashboardState | null,
  records: readonly CollectorUnifiedRound[],
): DashboardState | null {
  return records.reduce<DashboardState | null>(
    (state, record) =>
      state === null ? null : applyCollectorRound(state, record),
    dashboard,
  );
}

function upsertRound(
  rounds: readonly CollectorUnifiedRound[],
  record: CollectorUnifiedRound,
): CollectorUnifiedRound[] {
  return [
    ...rounds.filter(
      (round) =>
        round.boutId !== record.boutId || round.round !== record.round,
    ),
    record,
  ].sort(
    (left, right) =>
      left.boutId.localeCompare(right.boutId) ||
      left.round - right.round,
  );
}

function collectorBaseUrl(explicit?: string): string {
  const configured =
    explicit ??
    import.meta.env.VITE_COLLECTOR_URL ??
    `http://localhost:${DEFAULT_COLLECTOR_PORT}`;
  return configured.replace(/\/+$/, "");
}

function eventData(event: Event): unknown {
  if (!("data" in event) || typeof event.data !== "string") return null;
  try {
    return JSON.parse(event.data) as unknown;
  } catch {
    return null;
  }
}

export function getCollectorRoundDelivery(
  snapshot: CollectorSnapshot | undefined,
  boutId: string,
  round: number,
): CollectorValueDelivery | undefined {
  const record = snapshot?.unifiedRounds.find(
    (candidate) =>
      candidate.boutId === boutId && candidate.round === round,
  );
  if (record === undefined) return undefined;
  const stats = record.citoStats;
  const citoHealth = snapshot?.health.cito;

  return {
    source: stats === undefined ? "collector lifecycle" : "Cito",
    ...(stats?.sourceUpdatedAt === undefined
      ? { sourceUpdatedAt: record.detectedEndedAt }
      : { sourceUpdatedAt: stats.sourceUpdatedAt }),
    receivedAt: stats?.lastObservedAt ?? snapshot?.lastReceivedAt ??
      record.detectedEndedAt,
    stale:
      snapshot?.connection !== "connected" ||
      citoHealth?.fresh === false,
    provisional: record.provisional || stats?.provisional === true,
    ...(stats === undefined ? {} : { revision: stats.revision }),
  };
}

export function createCollectorClient(
  options: CollectorClientOptions = {},
): CollectorClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const createEventSource =
    options.createEventSource ??
    ((url: string) => new EventSource(url));
  const now = options.now ?? (() => new Date().toISOString());
  const timeoutMs = options.bootstrapTimeoutMs ?? 1_500;
  const baseUrl = collectorBaseUrl(options.baseUrl);
  const listeners = new Set<(snapshot: CollectorSnapshot) => void>();
  let eventSource: EventSourceLike | undefined;
  let abortController: AbortController | undefined;
  let closed = false;
  let snapshot: CollectorSnapshot = {
    connection: "unavailable",
    dashboard: null,
    health: {},
    unifiedRounds: [],
    lifecycle: {},
  };

  const publish = (next: CollectorSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };

  const receiveBootstrap = (
    bootstrap: CollectorBootstrap,
    receivedAt: string,
  ): void => {
    publish({
      ...snapshot,
      connection: "connected",
      dashboard: applyCollectorRounds(
        bootstrap.state,
        bootstrap.unifiedRounds,
      ),
      health: bootstrap.health,
      unifiedRounds: bootstrap.unifiedRounds,
      lastReceivedAt: receivedAt,
    });
  };

  const receiveHealth = (
    health: CollectorSourceHealth,
    receivedAt: string,
  ): void => {
    publish({
      ...snapshot,
      connection: "connected",
      health: {
        ...snapshot.health,
        [health.source]: health,
      },
      lastReceivedAt: receivedAt,
    });
  };

  const receiveUpdate = (value: unknown, receivedAt: string): void => {
    if (!isRecord(value)) return;

    if (value.kind === "lifecycle") {
      const event = parseLifecycleEvent(value.event);
      if (event === null) return;
      publish({
        ...snapshot,
        connection: "connected",
        dashboard:
          snapshot.dashboard === null
            ? null
            : applyCollectorLifecycle(snapshot.dashboard, event),
        lifecycle: {
          ...snapshot.lifecycle,
          [event.boutId]: {
            boutId: event.boutId,
            source: "collector lifecycle",
            sourceUpdatedAt: event.detectedAt,
            receivedAt,
            provisional:
              event.type === "FIGHT_STARTED" ||
              event.type === "PROVISIONAL_ROUND_ENDED",
          },
        },
        lastReceivedAt: receivedAt,
      });
      return;
    }

    if (value.kind === "round") {
      const record = parseUnifiedRound(value.record);
      if (record === null) return;
      const unifiedRounds = upsertRound(snapshot.unifiedRounds, record);
      publish({
        ...snapshot,
        connection: "connected",
        dashboard:
          snapshot.dashboard === null
            ? null
            : applyCollectorRound(snapshot.dashboard, record),
        unifiedRounds,
        lastReceivedAt: receivedAt,
      });
    }
  };

  const listen = (
    type: "bootstrap" | "health" | "update",
    handler: (value: unknown, receivedAt: string) => void,
  ): void => {
    eventSource?.addEventListener(type, ((event: Event) => {
      const value = eventData(event);
      if (value !== null) handler(value, now());
    }) as EventListener);
  };

  return {
    getSnapshot() {
      return snapshot;
    },
    async start() {
      if (closed) return;
      publish({ ...snapshot, connection: "reconnecting" });
      abortController = new AbortController();
      const timeout = setTimeout(
        () => abortController?.abort(),
        timeoutMs,
      );

      try {
        const response = await fetchImpl(`${baseUrl}/api/bootstrap`, {
          headers: { Accept: "application/json" },
          signal: abortController.signal,
        });
        if (!response.ok) {
          throw new Error(`Collector bootstrap failed (${response.status})`);
        }
        const bootstrap = parseBootstrap(await response.json());
        if (bootstrap === null) {
          throw new Error("Collector bootstrap was not normalized");
        }
        if (closed) return;
        receiveBootstrap(bootstrap, now());
      } catch {
        if (!closed) {
          publish({ ...snapshot, connection: "unavailable" });
        }
        return;
      } finally {
        clearTimeout(timeout);
        abortController = undefined;
      }

      try {
        eventSource = createEventSource(`${baseUrl}/api/events`);
        eventSource.onopen = () => {
          if (!closed) publish({ ...snapshot, connection: "connected" });
        };
        eventSource.onerror = () => {
          if (!closed) {
            publish({
              ...snapshot,
              connection:
                snapshot.dashboard === null
                  ? "unavailable"
                  : "reconnecting",
            });
          }
        };
        listen("bootstrap", (value, receivedAt) => {
          const bootstrap = parseBootstrap(value);
          if (bootstrap !== null) receiveBootstrap(bootstrap, receivedAt);
        });
        listen("health", (value, receivedAt) => {
          const health = parseHealth(value);
          if (health !== null) receiveHealth(health, receivedAt);
        });
        listen("update", receiveUpdate);
      } catch {
        publish({ ...snapshot, connection: "unavailable" });
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      abortController?.abort();
      eventSource?.close();
      listeners.clear();
    },
  };
}
