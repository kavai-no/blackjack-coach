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
 * Target is the last card of the named pile, not the global latest observe.
 * Ordinary seat `1`; split pile `1A` or `1B`. An older card in that pile
 * is not a target. An empty pile is not a target.
 */
export function withdrawCard(
  store: InMemoryEventStore,
  command: WithdrawCardCommand,
  streamId: string = TABLE_STREAM,
): CommandAck {
  const pile = pilesFrom(store.read(streamId)).get(command.seat) ?? [];
  const last = pile.at(-1);
  if (!last) {
    throw new Error("withdraw_card requires a registered card");
  }
  if (last.rank !== command.rank) {
    throw new Error("withdraw_card targets the last registered card of that pile");
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

type PileCard = { rank: Rank };

/** Cards still on each pile key. Shoe started and Hand completed clear the hand. */
function pilesFrom(history: readonly DomainEvent[]): Map<string, PileCard[]> {
  const piles = new Map<string, PileCard[]>();
  const pile = (seat: string): PileCard[] => {
    const found = piles.get(seat);
    if (found) return found;
    const created: PileCard[] = [];
    piles.set(seat, created);
    return created;
  };

  for (const event of history) {
    if (event.type === "shoe_started" || event.type === "hand_completed") {
      piles.clear();
    } else if (event.type === "card_observed") {
      pile(event.seat).push({ rank: event.rank });
    } else if (event.type === "hand_split") {
      moveSplit(piles, event.seat);
    } else if (event.type === "card_withdrawn") {
      const cards = pile(event.seat);
      const removed = cards.at(-1);
      if (!removed || removed.rank !== event.rank) {
        throw new Error("card_withdrawn is not the last registered card of that pile");
      }
      cards.pop();
    }
  }

  return piles;
}

function moveSplit(piles: Map<string, PileCard[]>, seat: Seat): void {
  const cards = piles.get(seat) ?? [];
  const [first, second] = cards;
  if (cards.length !== 2 || first === undefined || second === undefined) {
    throw new Error(`hand_split on seat ${seat} lost its cards`);
  }
  piles.set(seat, []);
  piles.set(`${seat}A`, [first]);
  piles.set(`${seat}B`, [second]);
}
