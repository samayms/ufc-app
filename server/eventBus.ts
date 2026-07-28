export type CollectorEvent =
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
  | { type: "FIGHT_ENDED"; boutId: string; round: number; detectedAt: string };

type CollectorEventType = CollectorEvent["type"];
type CollectorEventOfType<Type extends CollectorEventType> = Extract<
  CollectorEvent,
  { type: Type }
>;

export type CollectorEventListener<Type extends CollectorEventType> = (
  event: CollectorEventOfType<Type>,
) => void;

type StoredListener = (event: never) => void;

export class CollectorEventBus {
  private readonly listeners = new Map<
    CollectorEventType,
    Set<StoredListener>
  >();

  private readonly eventLog: CollectorEvent[] = [];

  subscribe<Type extends CollectorEventType>(
    type: Type,
    listener: CollectorEventListener<Type>,
  ): () => void {
    const listeners = this.listeners.get(type) ?? new Set<StoredListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);

    return () => {
      this.unsubscribe(type, listener);
    };
  }

  unsubscribe<Type extends CollectorEventType>(
    type: Type,
    listener: CollectorEventListener<Type>,
  ): void {
    const listeners = this.listeners.get(type);
    listeners?.delete(listener);

    if (listeners?.size === 0) {
      this.listeners.delete(type);
    }
  }

  emit(event: CollectorEvent): void {
    this.eventLog.push(event);

    for (const listener of this.listeners.get(event.type) ?? []) {
      const typedListener = listener as (emittedEvent: CollectorEvent) => void;
      typedListener(event);
    }
  }

  getEventLog(): readonly CollectorEvent[] {
    return [...this.eventLog];
  }
}
