import { SUITS, type Suit } from "../counting/maps.ts";

/** One rank×suit cell from the remaining view. Not a projector call. */
export type RankSuitCount = {
  rank: string;
  suit: string;
  count: number;
};

/**
 * Original `modules/deck.js` `pickSuit`, suits in `state.js` order:
 * spades, hearts, diamonds, clubs.
 * `random` is the unit-interval draw. Production passes `Math.random`.
 * A zero total returns the first suit.
 */
export function pickSuit(
  rank: string,
  remainingByRankSuit: readonly RankSuitCount[],
  random: () => number,
): Suit {
  let total = 0;
  const counts = SUITS.map((suit) => {
    const count = remainingByRankSuit.find(
      (cell) => cell.rank === rank && cell.suit === suit,
    )?.count ?? 0;
    total += count;
    return count;
  });
  const first = SUITS[0];
  if (total === 0) return first;
  let rand = random() * total;
  for (let index = 0; index < SUITS.length; index += 1) {
    rand -= counts[index] ?? 0;
    if (rand <= 0) return SUITS[index] ?? first;
  }
  return first;
}
