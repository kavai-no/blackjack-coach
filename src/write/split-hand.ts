import type { Rank } from "../counting/maps.ts";
import type { DomainEvent, Seat } from "./events.ts";
import {
  TABLE_STREAM,
  type InMemoryEventStore,
} from "./in-memory-store.ts";
import type { CommandAck } from "./start-shoe.ts";

/**
 * Felt chrome default. Hero-seat domain fact stays parked.
 * Non-hero split is out of scope.
 */
const HERO_SEAT: Seat = "1";

export type SplitHandCommand = {
  seat: Seat;
};

/**
 * Split hand.
 * Appends `hand_split` for the hero seat when it holds exactly two cards
 * of the same rank (K+K yes, 10+K no).
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
  if (seat !== HERO_SEAT) {
    throw new Error("split_hand is hero-only");
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
    } else if (event.type === "hand_split" && event.seat === seat) {
      split = true;
      ranks.length = 0;
    }
  }

  if (!shoe) {
    throw new Error("split_hand requires a shoe");
  }
  if (split) {
    throw new Error("split_hand seat is already split");
  }
  if (ranks.length !== 2 || ranks[0] !== ranks[1]) {
    throw new Error("split_hand requires exactly two cards of the same rank");
  }
}
