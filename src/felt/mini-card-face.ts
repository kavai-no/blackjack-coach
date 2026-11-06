import type { Rank, Suit } from "../counting/maps.ts";

/** Original `state.symMap`. */
export const SUIT_SYMBOL: Record<Suit, string> = {
  spades: "♠",
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
};

/** Original `.mini[data-suit]` colours in styles.css. */
export const MINI_SUIT_COLOR: Record<Suit, string> = {
  hearts: "#dc2626",
  diamonds: "#dc2626",
  spades: "#000000",
  clubs: "#000000",
};

/** Original `.mini` box in styles.css (desktop). */
export const MINI_CHROME = {
  className: "mini",
  width: "35px",
  height: "46px",
  borderRadius: "8px",
  margin: "0 auto -25px auto",
  flexShrink: "0",
  boxShadow: "0 4px 12px #0008,inset 0 0 20px rgba(255,255,255,0.1)",
  background: "linear-gradient(135deg,#fff,#f0f0f0)",
  border: "2px solid #333",
  position: "relative",
} as const;

export type MiniCardFace = {
  rank: Rank;
  suit: Suit;
  /** Painted rank + suit symbol. Ten is `T`, matching the corners. */
  face: string;
  className: "mini";
  dataset: { val: Rank; suit: Suit };
  corners: { topLeft: string; bottomRight: string };
  suits: { topRight: string; bottomLeft: string };
  color: string;
  chrome: typeof MINI_CHROME;
};

/** Original `addCard`: `'10'` is painted as `T`. */
export function displayRank(rank: Rank): string {
  return rank === "10" ? "T" : rank;
}

export function miniCardFace(rank: Rank, suit: Suit): MiniCardFace {
  const painted = displayRank(rank);
  const symbol = SUIT_SYMBOL[suit];
  return {
    rank,
    suit,
    face: `${painted}${symbol}`,
    className: "mini",
    dataset: { val: rank, suit },
    corners: { topLeft: painted, bottomRight: painted },
    suits: { topRight: symbol, bottomLeft: symbol },
    color: MINI_SUIT_COLOR[suit],
    chrome: MINI_CHROME,
  };
}

/** Same innerHTML template as `modules/cardHandler.js` `addCard`. */
export function miniCardInnerHtml(face: MiniCardFace): string {
  const displayVal = face.corners.topLeft;
  const sym = face.suits.topRight;
  return `
    <span class="corner top-left">${displayVal}</span>
    <span class="corner bottom-right">${displayVal}</span>
    <span class="suit top-right">${sym}</span>
    <span class="suit bottom-left">${sym}</span>
  `;
}
