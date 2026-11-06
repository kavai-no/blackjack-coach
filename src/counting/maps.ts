/** Count tags copied from gatepoet/BlackJack-Coach modules/state.js `state.map`.
 *  Do not substitute textbook maps (APC five is +3, not +2; Omega II ace is −2).
 */
export const RANKS = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
] as const;

export type Rank = (typeof RANKS)[number];

export const SUITS = ["spades", "hearts", "diamonds", "clubs"] as const;

export type Suit = (typeof SUITS)[number];

export const COUNT_SYSTEMS = ["HiLo", "APC", "Zen", "OmegaII"] as const;

export type CountSystem = (typeof COUNT_SYSTEMS)[number];

export type CountMap = Record<Rank, number>;

export const COUNT_MAPS: Record<CountSystem, CountMap> = {
  HiLo: {
    A: -1,
    "2": 1,
    "3": 1,
    "4": 1,
    "5": 1,
    "6": 1,
    "7": 0,
    "8": 0,
    "9": 0,
    "10": -1,
    J: -1,
    Q: -1,
    K: -1,
  },
  APC: {
    A: 0,
    "2": 1,
    "3": 1,
    "4": 2,
    "5": 3,
    "6": 2,
    "7": 2,
    "8": 1,
    "9": -3,
    "10": -4,
    J: -4,
    Q: -4,
    K: -4,
  },
  Zen: {
    A: -1,
    "2": 1,
    "3": 1,
    "4": 2,
    "5": 2,
    "6": 2,
    "7": 1,
    "8": 0,
    "9": 0,
    "10": -2,
    J: -2,
    Q: -2,
    K: -2,
  },
  OmegaII: {
    A: -2,
    "2": 1,
    "3": 1,
    "4": 2,
    "5": 3,
    "6": 2,
    "7": 1,
    "8": -1,
    "9": -1,
    "10": -2,
    J: -2,
    Q: -2,
    K: -2,
  },
};

export function countTag(system: CountSystem, rank: Rank): number {
  return COUNT_MAPS[system][rank];
}
