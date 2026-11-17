import type { Rank } from "../counting/maps.ts";

/**
 * Point value for the split rule (split_same_point_value, 03; Kristoffer
 * 2026-11-17 ~01:44 Oslo). 10, J, Q and K all count 10, so they mix freely.
 * A and 2-9 keep their own value, so they still need the same rank.
 * Deliberate deviation from the original's rank-string compare
 * (/workspace/bjc/modules/uiManager.js:76, cardHandler.js:128-132).
 */
export function splitValue(rank: Rank): number {
  if (rank === "A") return 11;
  if (rank === "10" || rank === "J" || rank === "Q" || rank === "K") return 10;
  return Number(rank);
}

/** Two cards split together when their point values match. */
export function sameSplitValue(first: Rank, second: Rank): boolean {
  return splitValue(first) === splitValue(second);
}
