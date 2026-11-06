import {
  TABLE_STREAM,
  type InMemoryEventStore,
} from "./in-memory-store.ts";
import type { CommandAck } from "./start-shoe.ts";

/**
 * Complete hand (NEXT HAND).
 * Appends `hand_completed` with no payload. Piles clear; the shoe stays.
 * Mid-shoe Start shoe already emits this fact before Shoe started —
 * this command is the standalone path.
 */
export function completeHand(
  store: InMemoryEventStore,
  streamId: string = TABLE_STREAM,
): CommandAck {
  const events = store.append(streamId, [{ type: "hand_completed" }]);
  const position = events.at(-1)?.position;
  if (position === undefined) {
    throw new Error("complete_hand appended no events");
  }
  return { ack: true, events, position };
}
