import type { Rank, Suit } from "../counting/maps.ts";

/** Felt order. Dealer is `D`, then seats 7…1. */
export const SEATS = ["D", "7", "6", "5", "4", "3", "2", "1"] as const;

export type Seat = (typeof SEATS)[number];

/** Earned facts. Later slices widen the union. */
export type ShoeStarted = {
  type: "shoe_started";
  decks: number;
};

export type HandCompleted = {
  type: "hand_completed";
};

/** Rank landed on a seat. Suit is not on this fact. */
export type CardObserved = {
  type: "card_observed";
  rank: Rank;
  seat: Seat;
};

/** Suit for the latest observe on a seat. No rank — the seat targets that card. */
export type CardSuitSet = {
  type: "card_suit_set";
  suit: Suit;
  seat: Seat;
};

/** Hero seat split into piles A and B. Counts and remaining do not change. */
export type HandSplit = {
  type: "hand_split";
  seat: Seat;
};

/**
 * Last registered card removed.
 * Rank and seat are those recorded on that observe.
 * Suit is not stored — projectors restore a suit only when one was set.
 */
export type CardWithdrawn = {
  type: "card_withdrawn";
  rank: Rank;
  seat: Seat;
};

export type DomainEvent =
  | ShoeStarted
  | HandCompleted
  | CardObserved
  | CardSuitSet
  | HandSplit
  | CardWithdrawn;
