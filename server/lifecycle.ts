import type { CollectorEvent, CollectorEventBus } from "./eventBus.ts";
import type { Storage } from "./storage.ts";

export type LifecycleSource = "espn" | "cito";

export interface FightLifecycleState {
  boutId: string;
  state: "pre" | "in" | "post";
  period: number;
  completed: boolean;
  clockSeconds?: number;
  sourceUpdatedAt?: string;
  receivedAt: string;
}

export interface FightLifecycleObservation extends FightLifecycleState {
  source: LifecycleSource;
}

export interface ProvisionalRoundSupersession {
  boutId: string;
  round: number;
  provisionalDetectedAt: string;
  supersededAt: string;
  source: LifecycleSource;
}

export const DEFAULT_ESPN_FRESHNESS_MS = 30_000;
export const DEFAULT_LIFECYCLE_STORAGE_STREAM = "fight-lifecycle";

interface SourceCursor {
  receivedAt: string;
  sourceUpdatedAt?: string;
}

interface ActiveProvisional {
  round: number;
  detectedAt: string;
}

interface PersistedFightLifecycle {
  version: 1;
  state: FightLifecycleState;
  activeSource: LifecycleSource;
  fightStartedEmitted: boolean;
  fightEndedEmitted: boolean;
  confirmedRounds: number[];
  activeProvisional?: ActiveProvisional;
  sourceCursors: Partial<Record<LifecycleSource, SourceCursor>>;
  supersessions: ProvisionalRoundSupersession[];
}

interface TransitionResult {
  persisted: PersistedFightLifecycle;
  events: CollectorEvent[];
  supersession?: ProvisionalRoundSupersession;
}

export interface FightLifecycleMachineOptions {
  eventBus: Pick<CollectorEventBus, "emit">;
  storage: Storage;
  storageStream?: string;
  espnFreshnessMs?: number;
  onProvisionalSuperseded?: (
    supersession: ProvisionalRoundSupersession,
  ) => void;
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${field} must be a valid ISO-8601 timestamp`);
  }

  return parsed;
}

function validateObservation(observation: FightLifecycleObservation): void {
  if (observation.boutId.trim().length === 0) {
    throw new TypeError("boutId must not be empty");
  }

  if (!Number.isInteger(observation.period) || observation.period < 0) {
    throw new TypeError("period must be a non-negative integer");
  }

  if (
    observation.clockSeconds !== undefined &&
    (!Number.isFinite(observation.clockSeconds) ||
      observation.clockSeconds < 0)
  ) {
    throw new TypeError("clockSeconds must be a non-negative number");
  }

  if (observation.completed && observation.period < 1) {
    throw new TypeError("a completed fight must have a positive period");
  }

  timestamp(observation.receivedAt, "receivedAt");

  if (observation.sourceUpdatedAt !== undefined) {
    timestamp(observation.sourceUpdatedAt, "sourceUpdatedAt");
  }
}

function copyState(state: FightLifecycleState): FightLifecycleState {
  return {
    boutId: state.boutId,
    state: state.state,
    period: state.period,
    completed: state.completed,
    ...(state.clockSeconds === undefined
      ? {}
      : { clockSeconds: state.clockSeconds }),
    ...(state.sourceUpdatedAt === undefined
      ? {}
      : { sourceUpdatedAt: state.sourceUpdatedAt }),
    receivedAt: state.receivedAt,
  };
}

function stateFromObservation(
  observation: FightLifecycleObservation,
): FightLifecycleState {
  return copyState(observation);
}

function copyPersisted(
  persisted: PersistedFightLifecycle,
): PersistedFightLifecycle {
  return {
    version: 1,
    state: copyState(persisted.state),
    activeSource: persisted.activeSource,
    fightStartedEmitted: persisted.fightStartedEmitted,
    fightEndedEmitted: persisted.fightEndedEmitted,
    confirmedRounds: [...persisted.confirmedRounds],
    ...(persisted.activeProvisional === undefined
      ? {}
      : { activeProvisional: { ...persisted.activeProvisional } }),
    sourceCursors: {
      ...(persisted.sourceCursors.espn === undefined
        ? {}
        : { espn: { ...persisted.sourceCursors.espn } }),
      ...(persisted.sourceCursors.cito === undefined
        ? {}
        : { cito: { ...persisted.sourceCursors.cito } }),
    },
    supersessions: persisted.supersessions.map((entry) => ({ ...entry })),
  };
}

function initialPersisted(
  observation: FightLifecycleObservation,
): PersistedFightLifecycle {
  return {
    version: 1,
    state: stateFromObservation(observation),
    activeSource: observation.source,
    fightStartedEmitted: observation.state !== "pre",
    fightEndedEmitted: observation.completed,
    confirmedRounds:
      observation.completed && observation.period > 0
        ? [observation.period]
        : [],
    sourceCursors: {
      [observation.source]: {
        receivedAt: observation.receivedAt,
        ...(observation.sourceUpdatedAt === undefined
          ? {}
          : { sourceUpdatedAt: observation.sourceUpdatedAt }),
      },
    },
    supersessions: [],
  };
}

function isEspnFresh(
  persisted: PersistedFightLifecycle,
  observation: FightLifecycleObservation,
  espnFreshnessMs: number,
): boolean {
  const espn = persisted.sourceCursors.espn;
  if (espn === undefined) return false;

  return (
    timestamp(observation.receivedAt, "receivedAt") -
      timestamp(espn.receivedAt, "ESPN receivedAt") <=
    espnFreshnessMs
  );
}

function updateSourceCursor(
  persisted: PersistedFightLifecycle,
  observation: FightLifecycleObservation,
): PersistedFightLifecycle {
  const next = copyPersisted(persisted);
  const previous = persisted.sourceCursors[observation.source];
  const previousSourceTime = previous?.sourceUpdatedAt;
  const observationSourceTime = observation.sourceUpdatedAt;
  const latestSourceTime =
    previousSourceTime === undefined
      ? observationSourceTime
      : observationSourceTime === undefined ||
          timestamp(previousSourceTime, "previous sourceUpdatedAt") >
            timestamp(observationSourceTime, "sourceUpdatedAt")
        ? previousSourceTime
        : observationSourceTime;

  next.sourceCursors[observation.source] = {
    receivedAt: observation.receivedAt,
    ...(latestSourceTime === undefined
      ? {}
      : { sourceUpdatedAt: latestSourceTime }),
  };

  return next;
}

function isReplayedSourceObservation(
  persisted: PersistedFightLifecycle,
  observation: FightLifecycleObservation,
): boolean {
  const cursor = persisted.sourceCursors[observation.source];
  if (cursor === undefined) return false;

  if (
    timestamp(observation.receivedAt, "receivedAt") <=
    timestamp(cursor.receivedAt, "previous receivedAt")
  ) {
    return true;
  }

  return (
    observation.sourceUpdatedAt !== undefined &&
    cursor.sourceUpdatedAt !== undefined &&
    timestamp(observation.sourceUpdatedAt, "sourceUpdatedAt") <
      timestamp(cursor.sourceUpdatedAt, "previous sourceUpdatedAt")
  );
}

function isLifecycleRegression(
  persisted: PersistedFightLifecycle,
  observation: FightLifecycleObservation,
): boolean {
  const stateRank = { pre: 0, in: 1, post: 2 } as const;

  return (
    observation.period < persisted.state.period ||
    stateRank[observation.state] < stateRank[persisted.state.state] ||
    (persisted.state.completed && !observation.completed)
  );
}

function addConfirmedRound(
  persisted: PersistedFightLifecycle,
  round: number,
  detectedAt: string,
  confirmation: "period_transition" | "fight_completed",
  events: CollectorEvent[],
): void {
  if (round < 1 || persisted.confirmedRounds.includes(round)) return;

  persisted.confirmedRounds.push(round);
  persisted.confirmedRounds.sort((left, right) => left - right);
  events.push({
    type: "ROUND_ENDED",
    boutId: persisted.state.boutId,
    round,
    detectedAt,
    confirmation,
  });

  if (persisted.activeProvisional?.round === round) {
    delete persisted.activeProvisional;
  }
}

function transition(
  current: PersistedFightLifecycle,
  observation: FightLifecycleObservation,
): TransitionResult {
  const previousState = current.state;
  const next = updateSourceCursor(current, observation);
  const events: CollectorEvent[] = [];

  next.state = stateFromObservation(observation);
  next.activeSource = observation.source;

  if (
    previousState.state === "pre" &&
    observation.state === "in" &&
    !next.fightStartedEmitted
  ) {
    next.fightStartedEmitted = true;
    events.push({
      type: "FIGHT_STARTED",
      boutId: observation.boutId,
      detectedAt: observation.receivedAt,
    });
  }

  const periodAdvanced =
    previousState.state === "in" &&
    observation.period > previousState.period;

  if (periodAdvanced) {
    addConfirmedRound(
      next,
      previousState.period,
      observation.receivedAt,
      "period_transition",
      events,
    );
  }

  const fightCompleted = !previousState.completed && observation.completed;

  if (fightCompleted) {
    const finalRound =
      next.activeProvisional?.round ?? observation.period;

    addConfirmedRound(
      next,
      finalRound,
      observation.receivedAt,
      "fight_completed",
      events,
    );

    if (!next.fightEndedEmitted) {
      next.fightEndedEmitted = true;
      events.push({
        type: "FIGHT_ENDED",
        boutId: observation.boutId,
        round: finalRound,
        detectedAt: observation.receivedAt,
      });
    }
  }

  let supersession: ProvisionalRoundSupersession | undefined;
  const clockResumed =
    next.activeProvisional !== undefined &&
    next.activeProvisional.round === observation.period &&
    previousState.period === observation.period &&
    previousState.completed === observation.completed &&
    observation.state === "in" &&
    observation.clockSeconds !== undefined &&
    observation.clockSeconds > 0;

  if (clockResumed && next.activeProvisional !== undefined) {
    supersession = {
      boutId: observation.boutId,
      round: observation.period,
      provisionalDetectedAt: next.activeProvisional.detectedAt,
      supersededAt: observation.receivedAt,
      source: observation.source,
    };
    next.supersessions.push(supersession);
    delete next.activeProvisional;
  }

  const reachedProvisionalBoundary =
    observation.state === "in" &&
    observation.clockSeconds === 0 &&
    !observation.completed &&
    observation.period > 0 &&
    !next.confirmedRounds.includes(observation.period) &&
    next.activeProvisional?.round !== observation.period;

  if (reachedProvisionalBoundary) {
    next.activeProvisional = {
      round: observation.period,
      detectedAt: observation.receivedAt,
    };
    events.push({
      type: "PROVISIONAL_ROUND_ENDED",
      boutId: observation.boutId,
      round: observation.period,
      detectedAt: observation.receivedAt,
    });
  }

  return {
    persisted: next,
    events,
    ...(supersession === undefined ? {} : { supersession }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLifecycleState(value: unknown): value is FightLifecycleState {
  if (!isRecord(value)) return false;

  return (
    typeof value.boutId === "string" &&
    (value.state === "pre" ||
      value.state === "in" ||
      value.state === "post") &&
    typeof value.period === "number" &&
    typeof value.completed === "boolean" &&
    (value.clockSeconds === undefined ||
      typeof value.clockSeconds === "number") &&
    (value.sourceUpdatedAt === undefined ||
      typeof value.sourceUpdatedAt === "string") &&
    typeof value.receivedAt === "string"
  );
}

function isPersistedLifecycle(
  value: unknown,
): value is PersistedFightLifecycle {
  if (!isRecord(value)) return false;

  return (
    value.version === 1 &&
    isLifecycleState(value.state) &&
    (value.activeSource === "espn" || value.activeSource === "cito") &&
    typeof value.fightStartedEmitted === "boolean" &&
    typeof value.fightEndedEmitted === "boolean" &&
    Array.isArray(value.confirmedRounds) &&
    value.confirmedRounds.every((round) => typeof round === "number") &&
    isRecord(value.sourceCursors) &&
    Array.isArray(value.supersessions)
  );
}

export class FightLifecycleMachine {
  private readonly eventBus: Pick<CollectorEventBus, "emit">;

  private readonly storage: Storage;

  private readonly storageStream: string;

  private readonly espnFreshnessMs: number;

  private readonly onProvisionalSuperseded:
    | ((supersession: ProvisionalRoundSupersession) => void)
    | undefined;

  private readonly bouts = new Map<string, PersistedFightLifecycle>();

  private restorePromise: Promise<void> | undefined;

  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: FightLifecycleMachineOptions) {
    if (
      !Number.isFinite(options.espnFreshnessMs ?? DEFAULT_ESPN_FRESHNESS_MS) ||
      (options.espnFreshnessMs ?? DEFAULT_ESPN_FRESHNESS_MS) < 0
    ) {
      throw new TypeError("espnFreshnessMs must be a non-negative number");
    }

    this.eventBus = options.eventBus;
    this.storage = options.storage;
    this.storageStream =
      options.storageStream ?? DEFAULT_LIFECYCLE_STORAGE_STREAM;
    this.espnFreshnessMs =
      options.espnFreshnessMs ?? DEFAULT_ESPN_FRESHNESS_MS;
    this.onProvisionalSuperseded = options.onProvisionalSuperseded;
  }

  static async create(
    options: FightLifecycleMachineOptions,
  ): Promise<FightLifecycleMachine> {
    const machine = new FightLifecycleMachine(options);
    await machine.restore();
    return machine;
  }

  async restore(): Promise<void> {
    this.restorePromise ??= this.restoreFromStorage();
    await this.restorePromise;
  }

  observe(
    observation: FightLifecycleObservation,
  ): Promise<readonly CollectorEvent[]> {
    const operation = this.operationQueue.then(async () => {
      await this.restore();
      return this.processObservation(observation);
    });

    this.operationQueue = operation.then(
      () => undefined,
      () => undefined,
    );

    return operation;
  }

  getState(boutId: string): FightLifecycleState | undefined {
    const state = this.bouts.get(boutId)?.state;
    return state === undefined ? undefined : copyState(state);
  }

  getStates(): readonly FightLifecycleState[] {
    return [...this.bouts.values()].map(({ state }) => copyState(state));
  }

  getActiveSource(boutId: string): LifecycleSource | undefined {
    return this.bouts.get(boutId)?.activeSource;
  }

  getSupersessionLog(
    boutId?: string,
  ): readonly ProvisionalRoundSupersession[] {
    return [...this.bouts.values()]
      .flatMap(({ supersessions }) => supersessions)
      .filter((entry) => boutId === undefined || entry.boutId === boutId)
      .map((entry) => ({ ...entry }));
  }

  private async restoreFromStorage(): Promise<void> {
    const records = await this.storage.read<unknown>(this.storageStream);

    this.bouts.clear();
    for (const record of records) {
      if (isPersistedLifecycle(record)) {
        this.bouts.set(record.state.boutId, copyPersisted(record));
      }
    }
  }

  private async processObservation(
    observation: FightLifecycleObservation,
  ): Promise<readonly CollectorEvent[]> {
    validateObservation(observation);

    const current = this.bouts.get(observation.boutId);
    if (current === undefined) {
      const initial = initialPersisted(observation);
      await this.storage.append(this.storageStream, initial);
      this.bouts.set(observation.boutId, initial);
      return [];
    }

    const cursor = current.sourceCursors[observation.source];
    if (
      cursor !== undefined &&
      timestamp(observation.receivedAt, "receivedAt") <=
        timestamp(cursor.receivedAt, "previous receivedAt")
    ) {
      return [];
    }

    if (
      observation.source === "cito" &&
      isEspnFresh(current, observation, this.espnFreshnessMs)
    ) {
      return [];
    }

    if (
      isReplayedSourceObservation(current, observation) ||
      isLifecycleRegression(current, observation)
    ) {
      const cursorOnly = updateSourceCursor(current, observation);
      await this.storage.append(this.storageStream, cursorOnly);
      this.bouts.set(observation.boutId, cursorOnly);
      return [];
    }

    const result = transition(current, observation);

    await this.storage.append(this.storageStream, result.persisted);
    this.bouts.set(observation.boutId, result.persisted);

    if (result.supersession !== undefined) {
      this.onProvisionalSuperseded?.({ ...result.supersession });
    }

    for (const event of result.events) {
      this.eventBus.emit(event);
    }

    return [...result.events];
  }
}
