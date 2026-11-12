import type { Rank, Suit } from "../counting/maps.ts";

/** Player seats at the table. The dealer is not one of these and cannot split. */
export const PLAYER_SEAT_COUNT = 7;

type Enumerate<N extends number, Acc extends number[] = []> = Acc["length"] extends N
  ? Acc[number]
  : Enumerate<N, [...Acc, Acc["length"]]>;

type SeatNumber = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** `"1"` … the configured count. Excludes the dealer. */
export type PlayerSeat = `${SeatNumber[Enumerate<typeof PLAYER_SEAT_COUNT>]}`;

export type Seat = "D" | PlayerSeat;

export const PLAYER_SEATS: readonly PlayerSeat[] = Array.from(
  { length: PLAYER_SEAT_COUNT },
  (_, index) => `${index + 1}` as PlayerSeat,
);

/** Felt order. Dealer, then the highest player seat down to 1. */
export const SEATS: readonly Seat[] = ["D", ...[...PLAYER_SEATS].reverse()];

/** Table seat, or a player split pile key (`1A`). Never `DA` / `DB`. */
export type CardSeat = Seat | `${PlayerSeat}${"A" | "B"}`;

/** Earned facts. Later slices widen the union. */
export type ShoeStarted = {
  type: "shoe_started";
  decks: number;
};

export type HandCompleted = {
  type: "hand_completed";
};

/** Rank landed on a seat or split pile. Suit is not on this fact. */
export type CardObserved = {
  type: "card_observed";
  rank: Rank;
  seat: CardSeat;
};

/** Suit for the latest observe on a seat or split pile. No rank — the seat targets that card. */
export type CardSuitSet = {
  type: "card_suit_set";
  suit: Suit;
  seat: CardSeat;
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
  seat: CardSeat;
};

export type DomainEvent =
  | ShoeStarted
  | HandCompleted
  | CardObserved
  | CardSuitSet
  | HandSplit
  | CardWithdrawn;
