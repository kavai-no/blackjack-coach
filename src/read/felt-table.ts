import type { Rank, Suit } from "../counting/maps.ts";
import { piledCard } from "../felt/piled-card.ts";
import type { MiniCardFace } from "../felt/mini-card-face.ts";
import { SEATS, type DomainEvent, type Seat } from "../write/events.ts";

export type FeltSeat = Seat;

/** Observed card. Suit stays unset until card_suit_set — no mini face yet. */
export type UnsuitedFeltCard = {
  rank: Rank;
  suit: null;
};

/** Latest observe on a seat after card_suit_set. Face is the slice-1 mini card. */
export type SuitedFeltCard = {
  rank: Rank;
  suit: Suit;
  mini_card_face: MiniCardFace;
};

export type FeltCard = UnsuitedFeltCard | SuitedFeltCard;

export type HandTotal = {
  seat: FeltSeat;
  total: number;
  /** bust=#ef4444; 21=cyan; ≥17=#22c55e; else=#ffd43f */
  colour: "#ef4444" | "cyan" | "#22c55e" | "#ffd43f";
  label: string;
};

export type FeltTable = {
  seat_order: "D,7,6,5,4,3,2,1";
  seat_piles: { seat: FeltSeat; cards: FeltCard[] }[];
  split_piles: readonly [];
  hand_totals: HandTotal[];
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
    seat_piles: SEATS.map((seat) => ({ seat, cards: [] })),
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

/** Blackjack total. Soft ace counts as 11 until that would bust. */
function blackjackTotal(ranks: readonly Rank[]): number {
  let total = 0;
  let aces = 0;
  for (const rank of ranks) {
    if (rank === "A") {
      total += 11;
      aces += 1;
    } else if (rank === "10" || rank === "J" || rank === "Q" || rank === "K") {
      total += 10;
    } else {
      total += Number(rank);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function totalColour(total: number): HandTotal["colour"] {
  if (total > 21) return "#ef4444";
  if (total === 21) return "cyan";
  if (total >= 17) return "#22c55e";
  return "#ffd43f";
}

function withHandTotals(table: FeltTable): FeltTable {
  const hand_totals: HandTotal[] = [];
  for (const pile of table.seat_piles) {
    if (pile.cards.length === 0) continue;
    const total = blackjackTotal(pile.cards.map((card) => card.rank));
    hand_totals.push({
      seat: pile.seat,
      total,
      colour: totalColour(total),
      label: `Total: ${total}`,
    });
  }
  return { ...table, hand_totals };
}

/**
 * Felt table.
 * Shoe started and Hand completed clear piles.
 * Card observed appends rank on that seat; suit stays unset.
 * Card suit set paints the latest card on that seat (rank + suit face).
 */
export function projectFeltTable(events: readonly DomainEvent[]): FeltTable {
  let seenShoe = false;
  let table: FeltTable | undefined;

  for (const event of events) {
    if (event.type === "shoe_started") {
      seenShoe = true;
      table = emptyFelt();
    } else if (event.type === "hand_completed" && seenShoe) {
      table = emptyFelt();
    } else if (event.type === "card_observed" && table) {
      const pile = table.seat_piles.find((seat) => seat.seat === event.seat);
      if (!pile) {
        throw new Error(`no felt pile for seat ${event.seat}`);
      }
      pile.cards.push({ rank: event.rank, suit: null });
    } else if (event.type === "card_suit_set" && table) {
      const pile = table.seat_piles.find((seat) => seat.seat === event.seat);
      if (!pile) {
        throw new Error(`no felt pile for seat ${event.seat}`);
      }
      const index = pile.cards.length - 1;
      const card = pile.cards[index];
      if (!card) {
        throw new Error(`no observed card on seat ${event.seat}`);
      }
      pile.cards[index] = piledCard(card.rank, event.suit);
    }
  }

  if (!table) {
    throw new Error("felt table requires shoe_started");
  }
  return withHandTotals(table);
}
