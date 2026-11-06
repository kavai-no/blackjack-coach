import type { Rank } from "../counting/maps.ts";
import type { Seat } from "./events.ts";
import {
  TABLE_STREAM,
  type InMemoryEventStore,
} from "./in-memory-store.ts";
import type { CommandAck } from "./start-shoe.ts";

export type ObserveCardCommand = {
  rank: Rank;
  seat: Seat;
};

/**
 * Observe card.
 * Appends `card_observed` with rank + seat only. No suit.
 */
export function observeCard(
  store: InMemoryEventStore,
  command: ObserveCardCommand,
  streamId: string = TABLE_STREAM,
): CommandAck {
  const events = store.append(streamId, [
    {
      type: "card_observed",
      rank: command.rank,
      seat: command.seat,
    },
  ]);
  const position = events.at(-1)?.position;
  if (position === undefined) {
    throw new Error("observe_card appended no events");
  }
  return { ack: true, events, position };
}
