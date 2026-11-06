import type { Rank } from "../counting/maps.ts";

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

export type DomainEvent = ShoeStarted | HandCompleted | CardObserved;
