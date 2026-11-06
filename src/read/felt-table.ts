import type { DomainEvent } from "../write/events.ts";

const SEAT_ORDER = ["D", "7", "6", "5", "4", "3", "2", "1"] as const;

export type FeltSeat = (typeof SEAT_ORDER)[number];

export type FeltTable = {
  seat_order: "D,7,6,5,4,3,2,1";
  seat_piles: { seat: FeltSeat; cards: readonly [] }[];
  split_piles: readonly [];
  hand_totals: readonly [];
  /** UI chrome from the felt screen contract. Not events. */
  screen: {
    focus_seat: "1";
    hero_seat: "1";
    split_button_visible: false;
    new_shoe: "start_shoe";
    next_hand: "complete_hand";
  };
};

function emptyFelt(): FeltTable {
  return {
    seat_order: "D,7,6,5,4,3,2,1",
    seat_piles: SEAT_ORDER.map((seat) => ({ seat, cards: [] })),
    split_piles: [],
    hand_totals: [],
    screen: {
      focus_seat: "1",
      hero_seat: "1",
      split_button_visible: false,
      new_shoe: "start_shoe",
      next_hand: "complete_hand",
    },
  };
}

/** Felt table after Shoe started / Hand completed. Both clear piles. */
export function projectFeltTable(events: readonly DomainEvent[]): FeltTable {
  let seenShoe = false;
  let table: FeltTable | undefined;

  for (const event of events) {
    if (event.type === "shoe_started") {
      seenShoe = true;
      table = emptyFelt();
    } else if (event.type === "hand_completed" && seenShoe) {
      table = emptyFelt();
    }
  }

  if (!table) {
    throw new Error("felt table requires shoe_started");
  }
  return table;
}
