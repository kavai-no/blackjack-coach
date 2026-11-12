import type { Rank } from "../counting/maps.ts";
import type { CardSeat, DomainEvent, Seat } from "./events.ts";
import {
  TABLE_STREAM,
  type InMemoryEventStore,
} from "./in-memory-store.ts";
import type { CommandAck } from "./start-shoe.ts";

export type WithdrawCardCommand = {
  rank: Rank;
  seat: CardSeat;
};

/**
 * Withdraw card.
 * Target is the last registered card (latest Card observed still on the
 * felt). Appends `card_withdrawn` with that observe's rank and seat.
 * An older card is not a target in this slice.
 */
export function withdrawCard(
  store: InMemoryEventStore,
  command: WithdrawCardCommand,
  streamId: string = TABLE_STREAM,
): CommandAck {
  const last = lastRegistered(store.read(streamId));
  if (!last) {
    throw new Error("withdraw_card requires a registered card");
  }
  if (last.rank !== command.rank || last.seat !== command.seat) {
    throw new Error("withdraw_card targets the last registered card");
  }

  const events = store.append(streamId, [
    {
      type: "card_withdrawn",
      rank: command.rank,
      seat: command.seat,
    },
  ]);
  const position = events.at(-1)?.position;
  if (position === undefined) {
    throw new Error("withdraw_card appended no events");
  }
  return { ack: true, events, position };
}

/** Cards still on the felt. Shoe started and Hand completed clear the hand. */
function lastRegistered(
  history: readonly DomainEvent[],
): { rank: Rank; seat: CardSeat } | undefined {
  const cards: { rank: Rank; seat: CardSeat }[] = [];

  for (const event of history) {
    if (event.type === "shoe_started" || event.type === "hand_completed") {
      cards.length = 0;
    } else if (event.type === "card_observed") {
      cards.push({ rank: event.rank, seat: event.seat });
    } else if (event.type === "card_withdrawn") {
      const removed = cards.pop();
      if (
        !removed ||
        removed.rank !== event.rank ||
        removed.seat !== event.seat
      ) {
        throw new Error("card_withdrawn is not the last registered card");
      }
    }
  }

  return cards.at(-1);
}
