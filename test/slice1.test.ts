import assert from "node:assert/strict";
import test from "node:test";
import { COUNT_MAPS, type Rank } from "../src/counting/maps.ts";
import { miniCardInnerHtml } from "../src/felt/mini-card-face.ts";
import { piledCard } from "../src/felt/piled-card.ts";
import { projectCountsAfterShoeStarted } from "../src/read/counts-info-bar.ts";

const RANKS: Rank[] = [
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
];

/** Hi-Lo and Zen match the balanced maps. APC is Uston. Omega II is standard. */
const LOCKED_MAPS = {
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
    "3": 2,
    "4": 2,
    "5": 3,
    "6": 2,
    "7": 2,
    "8": 1,
    "9": -1,
    "10": -3,
    J: -3,
    Q: -3,
    K: -3,
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
    A: 0,
    "2": 1,
    "3": 1,
    "4": 2,
    "5": 2,
    "6": 2,
    "7": 1,
    "8": 0,
    "9": -1,
    "10": -2,
    J: -2,
    Q: -2,
    K: -2,
  },
} as const;

test("RA empty-shoe assertion uses -0.875 from acesLeft/(32·decksLeft)−1", () => {
  const bar = projectCountsAfterShoeStarted([
    { type: "shoe_started", decks: 8 },
  ]);
  assert.equal(bar.acesLeft, 32);
  assert.equal(bar.decksLeft, 8);
  assert.equal(bar.ra, bar.acesLeft / (32 * bar.decksLeft) - 1);
  assert.equal(bar.ra, -0.875);

  const fourDot = bar.acesLeft / (4 * bar.decksLeft) - 1;
  assert.equal(fourDot, 0);
  assert.notEqual(bar.ra, fourDot);
  assert.notEqual(bar.ra, 0);
});

test("count maps are Uston APC and standard Omega II; J/Q/K stay distinct", () => {
  assert.equal(COUNT_MAPS.APC["5"], 3);
  assert.notEqual(COUNT_MAPS.APC["5"], 2);
  assert.equal(COUNT_MAPS.APC["10"], -3);
  assert.notEqual(COUNT_MAPS.APC["10"], -4);
  assert.equal(COUNT_MAPS.APC["3"], 2);
  assert.equal(COUNT_MAPS.APC["9"], -1);
  assert.equal(COUNT_MAPS.OmegaII.A, 0);
  assert.notEqual(COUNT_MAPS.OmegaII.A, -2);
  assert.equal(COUNT_MAPS.OmegaII["5"], 2);
  assert.notEqual(COUNT_MAPS.OmegaII["5"], 3);
  assert.equal(COUNT_MAPS.OmegaII["8"], 0);
  assert.notEqual(COUNT_MAPS.OmegaII["8"], -1);
  assert.equal(COUNT_MAPS.APC.J, COUNT_MAPS.APC["10"]);
  assert.equal(COUNT_MAPS.APC.Q, COUNT_MAPS.APC["10"]);
  assert.equal(COUNT_MAPS.APC.K, COUNT_MAPS.APC["10"]);
  assert.equal(COUNT_MAPS.OmegaII.J, COUNT_MAPS.OmegaII["10"]);
  assert.notEqual(COUNT_MAPS.HiLo.K, COUNT_MAPS.HiLo["5"]);
  assert.equal("ES3" in COUNT_MAPS, false);
  assert.deepEqual(COUNT_MAPS, LOCKED_MAPS);
  for (const rank of RANKS) {
    assert.equal(COUNT_MAPS.HiLo[rank], LOCKED_MAPS.HiLo[rank]);
    assert.equal(COUNT_MAPS.Zen[rank], LOCKED_MAPS.Zen[rank]);
    assert.equal(COUNT_MAPS.OmegaII[rank], LOCKED_MAPS.OmegaII[rank]);
    assert.equal(COUNT_MAPS.APC[rank], LOCKED_MAPS.APC[rank]);
  }
});

test("piled cards expose mini_card_face", () => {
  const king = piledCard("K", "spades");
  assert.equal("mini_card_face" in king, true);
  assert.equal(king.mini_card_face.rank, "K");
  assert.equal(king.mini_card_face.suit, "spades");
  assert.equal(king.mini_card_face.face, "K♠");
  assert.equal(king.mini_card_face.className, "mini");
  assert.deepEqual(king.mini_card_face.dataset, { val: "K", suit: "spades" });
  assert.deepEqual(king.mini_card_face.corners, {
    topLeft: "K",
    bottomRight: "K",
  });
  assert.deepEqual(king.mini_card_face.suits, {
    topRight: "♠",
    bottomLeft: "♠",
  });
  assert.equal(king.mini_card_face.color, "#000000");
  assert.equal(king.mini_card_face.chrome.width, "35px");
  assert.equal(king.mini_card_face.chrome.height, "46px");
  assert.equal(king.mini_card_face.chrome.borderRadius, "8px");
  assert.equal(
    king.mini_card_face.chrome.background,
    "linear-gradient(135deg,#fff,#f0f0f0)",
  );
  assert.equal(
    miniCardInnerHtml(king.mini_card_face),
    `
    <span class="corner top-left">K</span>
    <span class="corner bottom-right">K</span>
    <span class="suit top-right">♠</span>
    <span class="suit bottom-left">♠</span>
  `,
  );

  const ten = piledCard("10", "hearts");
  assert.equal(ten.rank, "10");
  assert.equal(ten.mini_card_face.face, "T♥");
  assert.equal(ten.mini_card_face.dataset.val, "10");
  assert.equal(ten.mini_card_face.corners.topLeft, "T");
  assert.equal(ten.mini_card_face.color, "#dc2626");
  assert.equal(ten.mini_card_face.suits.bottomLeft, "♥");
});
