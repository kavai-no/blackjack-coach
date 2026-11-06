import type { DomainEvent } from "./events.ts";

export type { DomainEvent } from "./events.ts";

/** Aggregate `table` stream. */
export const TABLE_STREAM = "table";

export type RecordedEvent = DomainEvent & { position: number };

export type InMemoryEventStore = {
  read(streamId: string): readonly RecordedEvent[];
  append(streamId: string, events: readonly DomainEvent[]): RecordedEvent[];
};

/** Fake in-memory event store. Positions are 1-based per stream. */
export function createInMemoryEventStore(): InMemoryEventStore {
  const streams = new Map<string, RecordedEvent[]>();

  return {
    read(streamId) {
      return streams.get(streamId) ?? [];
    },

    append(streamId, events) {
      const current = streams.get(streamId) ?? [];
      const recorded: RecordedEvent[] = events.map((event, index) => ({
        ...event,
        position: current.length + index + 1,
      }));
      streams.set(streamId, [...current, ...recorded]);
      return recorded;
    },
  };
}
