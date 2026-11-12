import type { Suit } from "../counting/maps.ts";
import type { CardSeat } from "./events.ts";
import {
  TABLE_STREAM,
  type InMemoryEventStore,
} from "./in-memory-store.ts";
import type { CommandAck } from "./start-shoe.ts";

export type SetSuitCommand = {
  suit: Suit;
  seat: CardSeat;
};

/**
 * Set suit.
 * Appends `card_suit_set` with suit + seat. Target is the latest
 * observe on that seat; this command does not name a card id.
 */
export function setSuit(
  store: InMemoryEventStore,
  command: SetSuitCommand,
  streamId: string = TABLE_STREAM,
): CommandAck {
  const events = store.append(streamId, [
    {
      type: "card_suit_set",
      suit: command.suit,
      seat: command.seat,
    },
  ]);
  const position = events.at(-1)?.position;
  if (position === undefined) {
    throw new Error("set_suit appended no events");
  }
  return { ack: true, events, position };
}
