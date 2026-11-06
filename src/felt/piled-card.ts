import type { Rank, Suit } from "../counting/maps.ts";
import { miniCardFace, type MiniCardFace } from "./mini-card-face.ts";

/** A card in a seat pile. Always carries original `.mini` chrome. */
export type PiledCard = {
  rank: Rank;
  suit: Suit;
  mini_card_face: MiniCardFace;
};

export function piledCard(rank: Rank, suit: Suit): PiledCard {
  return {
    rank,
    suit,
    mini_card_face: miniCardFace(rank, suit),
  };
}
