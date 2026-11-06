import type { DomainEvent } from "./events.ts";
import {
  TABLE_STREAM,
  type InMemoryEventStore,
  type RecordedEvent,
} from "./in-memory-store.ts";

export type StartShoeCommand = {
  decks: number;
};

/** Ack plus appended events and log position. Not a view. */
export type CommandAck = {
  ack: true;
  events: RecordedEvent[];
  position: number;
};

/**
 * Start shoe.
 * First shoe of a session (no Shoe started yet): `shoe_started` only.
 * Shoe already in progress: `hand_completed` then `shoe_started`.
 */
export function startShoe(
  store: InMemoryEventStore,
  command: StartShoeCommand,
  streamId: string = TABLE_STREAM,
): CommandAck {
  const shoeInProgress = store
    .read(streamId)
    .some((event) => event.type === "shoe_started");

  const toAppend: DomainEvent[] = shoeInProgress
    ? [
        { type: "hand_completed" },
        { type: "shoe_started", decks: command.decks },
      ]
    : [{ type: "shoe_started", decks: command.decks }];

  const events = store.append(streamId, toAppend);
  const position = events.at(-1)?.position;
  if (position === undefined) {
    throw new Error("start_shoe appended no events");
  }
  return { ack: true, events, position };
}
