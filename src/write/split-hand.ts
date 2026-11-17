import type { Rank } from "../counting/maps.ts";
import { sameSplitValue } from "../felt/split-value.ts";
import { PLAYER_SEATS, type DomainEvent, type Seat } from "./events.ts";
import {
  TABLE_STREAM,
  type InMemoryEventStore,
} from "./in-memory-store.ts";
import type { CommandAck } from "./start-shoe.ts";

/** Original seat key for the dealer. HCL names it 'dealer' (dealer_cannot_split). */
const DEALER_SEAT: Seat = "D";

export type SplitHandCommand = {
  seat: Seat;
};

/**
 * Split hand.
 * Appends `hand_split` for any player seat 1-7 (split_on_every_player_seat)
 * when that seat's unsplit hand holds exactly its first two cards of this
 * hand (split_first_two_cards_only) with the same point value
 * (split_same_point_value: K+K and 10+K yes, 9+K no).
 * The dealer cannot split (dealer_cannot_split). A pile key such as `1A`
 * is not a Seat, so a split pile can never be split again.
 */
export function splitHand(
  store: InMemoryEventStore,
  command: SplitHandCommand,
  streamId: string = TABLE_STREAM,
): CommandAck {
  assertCanSplit(store.read(streamId), command.seat);

  const events = store.append(streamId, [
    { type: "hand_split", seat: command.seat },
  ]);
  const position = events.at(-1)?.position;
  if (position === undefined) {
    throw new Error("split_hand appended no events");
  }
  return { ack: true, events, position };
}

function assertCanSplit(history: readonly DomainEvent[], seat: Seat): void {
  if (seat === DEALER_SEAT) {
    throw new Error("split_hand rejected: the dealer cannot split");
  }
  // Runtime guard for untyped callers: only a base player seat splits.
  if (!(PLAYER_SEATS as readonly string[]).includes(seat)) {
    throw new Error("split_hand rejected: a split pile cannot be split again");
  }

  let shoe = false;
  let split = false;
  const ranks: Rank[] = [];

  for (const event of history) {
    if (event.type === "shoe_started") {
      shoe = true;
      split = false;
      ranks.length = 0;
    } else if (event.type === "hand_completed") {
      split = false;
      ranks.length = 0;
    } else if (event.type === "card_observed" && event.seat === seat) {
      ranks.push(event.rank);
    } else if (event.type === "card_withdrawn" && event.seat === seat) {
      const removed = ranks.pop();
      if (removed !== event.rank) {
        throw new Error("card_withdrawn is not the last registered card");
      }
    } else if (event.type === "hand_split" && event.seat === seat) {
      split = true;
      ranks.length = 0;
    }
  }

  if (!shoe) {
    throw new Error("split_hand requires a shoe");
  }
  if (split) {
    throw new Error("split_hand rejected: seat is already split");
  }
  const [first, second] = ranks;
  if (ranks.length !== 2 || first === undefined || second === undefined) {
    throw new Error("split_hand rejected: split is only allowed on the first two cards");
  }
  if (!sameSplitValue(first, second)) {
    throw new Error("split_hand rejected: cards must have the same point value");
  }
}
