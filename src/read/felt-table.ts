import type { Rank, Suit } from "../counting/maps.ts";
import { piledCard } from "../felt/piled-card.ts";
import type { MiniCardFace } from "../felt/mini-card-face.ts";
import { SEATS, type CardSeat, type DomainEvent, type Seat } from "../write/events.ts";

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
  /** Set on a split pile. Absent on an unsplit seat. */
  hand?: "A" | "B";
  total: number;
  /** bust=#ef4444; 21=rgb(0 255 245); ≥17=#22c55e; else=#ffd43f */
  colour: "#ef4444" | "rgb(0 255 245)" | "#22c55e" | "#ffd43f";
  label: string;
};

export type SplitPile = {
  seat: FeltSeat;
  hand: "A" | "B";
  cards: FeltCard[];
};

export type FeltTable = {
  seat_order: "D,7,6,5,4,3,2,1";
  seat_piles: { seat: FeltSeat; cards: FeltCard[] }[];
  split_piles: SplitPile[];
  hand_totals: HandTotal[];
  /** UI chrome from the felt screen contract. Not events. */
  screen: {
    focus_seat: FeltSeat;
    hero_seat: "1";
    split_button_visible: boolean;
    /** Original `activeSplit`. Pile A of the seat that split. Null when none is live. */
    active_split: `${FeltSeat}A` | null;
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
      active_split: null,
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
  if (total === 21) return "rgb(0 255 245)";
  if (total >= 17) return "#22c55e";
  return "#ffd43f";
}

function withHandTotals(table: FeltTable): FeltTable {
  const hand_totals: HandTotal[] = [];
  for (const pile of table.seat_piles) {
    if (pile.cards.length > 0) {
      const total = blackjackTotal(pile.cards.map((card) => card.rank));
      hand_totals.push({
        seat: pile.seat,
        total,
        colour: totalColour(total),
        label: `Total: ${total}`,
      });
    }
    for (const split of table.split_piles) {
      if (split.seat !== pile.seat || split.cards.length === 0) continue;
      const total = blackjackTotal(split.cards.map((card) => card.rank));
      hand_totals.push({
        seat: split.seat,
        hand: split.hand,
        total,
        colour: totalColour(total),
        label: `Total: ${total}`,
      });
    }
  }
  return {
    ...table,
    hand_totals,
    screen: {
      ...table.screen,
      split_button_visible: heroPairVisible(table),
    },
  };
}

/** Split button: hero seat, exactly two cards, identical rank, not already split. */
function heroPairVisible(table: FeltTable): boolean {
  const hero = table.screen.hero_seat;
  if (table.split_piles.some((pile) => pile.seat === hero)) return false;
  const pile = table.seat_piles.find((seat) => seat.seat === hero);
  const [first, second] = pile?.cards ?? [];
  return (
    pile?.cards.length === 2 &&
    first !== undefined &&
    second !== undefined &&
    first.rank === second.rank
  );
}

/**
 * Felt table.
 * Shoe started and Hand completed clear piles.
 * Card observed appends rank on that seat; suit stays unset.
 * Card suit set paints the latest card on that seat (rank + suit face).
 * Hand split moves that pair into split piles A (first card) and B (second).
 * Card withdrawn removes the last card of the named pile,
 * even when a later card sits on another pile.
 */
export function projectFeltTable(events: readonly DomainEvent[]): FeltTable {
  let seenShoe = false;
  let table: FeltTable | undefined;
  const live: LiveCard[] = [];

  for (const event of events) {
    if (event.type === "shoe_started") {
      seenShoe = true;
      live.length = 0;
      table = emptyFelt();
    } else if (event.type === "hand_completed" && seenShoe) {
      live.length = 0;
      table = emptyFelt();
    } else if (event.type === "card_observed" && table) {
      const decoded = decodeCardSeat(event.seat);
      if (decoded.hand === "main") {
        const pile = table.seat_piles.find((seat) => seat.seat === decoded.seat);
        if (!pile) {
          throw new Error(`no felt pile for seat ${event.seat}`);
        }
        pile.cards.push({ rank: event.rank, suit: null });
        live.push({ seat: event.seat, pile: "main" });
      } else {
        let split = table.split_piles.find(
          (pile) => pile.seat === decoded.seat && pile.hand === decoded.hand,
        );
        if (!split) {
          split = { seat: decoded.seat, hand: decoded.hand, cards: [] };
          table.split_piles = [...table.split_piles, split];
        }
        split.cards.push({ rank: event.rank, suit: null });
        live.push({ seat: event.seat, pile: decoded.hand });
        if (table.screen.active_split === event.seat && split.cards.length >= 2) {
          table.screen = {
            ...table.screen,
            active_split: null,
            focus_seat: seatToTheLeft(decoded.seat),
          };
        }
      }
    } else if (event.type === "card_suit_set" && table) {
      const cards = cardsForSeat(table, event.seat);
      const index = cards.length - 1;
      const card = cards[index];
      if (!card) {
        throw new Error(`no observed card on seat ${event.seat}`);
      }
      cards[index] = piledCard(card.rank, event.suit);
    } else if (event.type === "hand_split" && table) {
      const pile = table.seat_piles.find((seat) => seat.seat === event.seat);
      if (!pile) {
        throw new Error(`no felt pile for seat ${event.seat}`);
      }
      if (table.split_piles.some((split) => split.seat === event.seat)) {
        throw new Error(`hand_split on seat ${event.seat} is already split`);
      }
      const [first, second] = pile.cards;
      if (
        pile.cards.length !== 2 ||
        first === undefined ||
        second === undefined ||
        first.rank !== second.rank
      ) {
        throw new Error(`hand_split on seat ${event.seat} is not a pair`);
      }
      pile.cards = [];
      table.split_piles = [
        ...table.split_piles,
        { seat: event.seat, hand: "A", cards: [first] },
        { seat: event.seat, hand: "B", cards: [second] },
      ];
      const pending = live.filter(
        (card) => card.seat === event.seat && card.pile === "main",
      );
      const [left, right] = pending;
      if (pending.length !== 2 || left === undefined || right === undefined) {
        throw new Error(`hand_split on seat ${event.seat} lost its cards`);
      }
      left.pile = "A";
      right.pile = "B";
      table.screen = {
        ...table.screen,
        active_split: `${event.seat}A`,
      };
    } else if (event.type === "card_withdrawn" && table) {
      const cards = cardsForSeat(table, event.seat);
      const card = cards.at(-1);
      if (!card || card.rank !== event.rank) {
        throw new Error(
          card
            ? "card_withdrawn is not the last registered card of that pile"
            : "card_withdrawn with no registered card",
        );
      }
      cards.pop();
      if (!takeLive(live, event.seat)) {
        throw new Error("card_withdrawn with no registered card");
      }
    }
  }

  if (!table) {
    throw new Error("felt table requires shoe_started");
  }
  return withHandTotals(table);
}

type LiveCard = { seat: CardSeat; pile: "main" | "A" | "B" };

function decodeCardSeat(seat: CardSeat): {
  seat: FeltSeat;
  hand: "main" | "A" | "B";
} {
  if (seat.length === 2 && (seat.endsWith("A") || seat.endsWith("B"))) {
    return {
      seat: seat.slice(0, 1) as FeltSeat,
      hand: seat.endsWith("A") ? "A" : "B",
    };
  }
  return { seat: seat as FeltSeat, hand: "main" };
}

/** Next seat toward the dealer. Felt order is D,7..1, so left of 1 is 2. */
function seatToTheLeft(seat: FeltSeat): FeltSeat {
  const index = SEATS.indexOf(seat);
  return SEATS[index - 1] ?? seat;
}

function takeLive(live: LiveCard[], seat: CardSeat): boolean {
  const want = decodeCardSeat(seat);
  for (let index = live.length - 1; index >= 0; index -= 1) {
    const item = live[index];
    if (!item) continue;
    const base = decodeCardSeat(item.seat).seat;
    const hand = item.pile === "main" ? "main" : item.pile;
    if (base === want.seat && hand === want.hand) {
      live.splice(index, 1);
      return true;
    }
  }
  return false;
}

function cardsForSeat(table: FeltTable, seat: CardSeat): FeltCard[] {
  const decoded = decodeCardSeat(seat);
  if (decoded.hand === "main") {
    const pile = table.seat_piles.find((item) => item.seat === decoded.seat);
    if (!pile) {
      throw new Error(`no felt pile for seat ${seat}`);
    }
    return pile.cards;
  }
  const split = table.split_piles.find(
    (pile) => pile.seat === decoded.seat && pile.hand === decoded.hand,
  );
  if (!split) {
    throw new Error(`no split pile ${decoded.hand} for seat ${decoded.seat}`);
  }
  return split.cards;
}
