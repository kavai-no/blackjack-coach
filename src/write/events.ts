/** Earned facts this slice appends. Later slices widen the union. */
export type ShoeStarted = {
  type: "shoe_started";
  decks: number;
};

export type HandCompleted = {
  type: "hand_completed";
};

export type DomainEvent = ShoeStarted | HandCompleted;
