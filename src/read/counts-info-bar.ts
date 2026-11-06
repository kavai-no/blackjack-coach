import { runningAce } from "../counting/running-ace.ts";

/** Original shoe is 8 decks (`SHOE_DECKS` in modules/state.js). */
export const SHOE_DECKS = 8;
const CARDS_PER_DECK = 52;
const ACES_PER_DECK = 4;

export type ShoeStarted = {
  type: "shoe_started";
  decks: number;
};

export type EmptyShoeCounts = {
  acesLeft: number;
  decksLeft: number;
  ra: number;
};

/** Fresh shoe, no cards dealt: initRemaining + updateAll decksLeft / acesLeft. */
export function emptyShoeCounts(decks: number = SHOE_DECKS): EmptyShoeCounts {
  const totalRemaining = decks * CARDS_PER_DECK;
  const decksLeft = Math.max(totalRemaining / CARDS_PER_DECK, 0.01);
  const acesLeft = decks * ACES_PER_DECK;
  return {
    acesLeft,
    decksLeft,
    ra: runningAce(acesLeft, decksLeft),
  };
}

/** Counts / info bar after Shoe started, before any card is observed. */
export function projectCountsAfterShoeStarted(
  events: readonly ShoeStarted[],
): EmptyShoeCounts {
  const last = [...events].reverse().find((event) => event.type === "shoe_started");
  if (!last) {
    throw new Error("empty shoe requires shoe_started");
  }
  return emptyShoeCounts(last.decks);
}
