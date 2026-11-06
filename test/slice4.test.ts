import assert from "node:assert/strict";
import test from "node:test";
import { RANKS, type Rank, type Suit } from "../src/counting/maps.ts";
import { piledCard } from "../src/felt/piled-card.ts";
import { projectCountsInfoBar } from "../src/read/counts-info-bar.ts";
import { projectFeltTable } from "../src/read/felt-table.ts";
import { projectRemainingComposition } from "../src/read/remaining-composition.ts";
import {
  TABLE_STREAM,
  createInMemoryEventStore,
} from "../src/write/in-memory-store.ts";
import { observeCard } from "../src/write/observe-card.ts";
import { setSuit } from "../src/write/set-suit.ts";
import { startShoe } from "../src/write/start-shoe.ts";

const DECKS = 8;
const SEATS = ["D", "7", "6", "5", "4", "3", "2", "1"] as const;
/** Donut draw order — not `state.js` storage order. */
const SUIT_DRAW = ["spades", "clubs", "hearts", "diamonds"] as const;

function cell(
  rows: readonly { rank: Rank; suit: Suit; count: number }[],
  rank: Rank,
  suit: Suit,
): number {
  const found = rows.find((row) => row.rank === rank && row.suit === suit);
  assert.ok(found);
  return found.count;
}

test("GWT set_suit_happy: shoe + observe → card_suit_set suit+seat", () => {
  const store = createInMemoryEventStore();
  startShoe(store, { decks: DECKS });
  observeCard(store, { rank: "5", seat: "1" });

  const result = setSuit(store, { suit: "hearts", seat: "1" });

  assert.equal(result.ack, true);
  assert.deepEqual(Object.keys(result).sort(), ["ack", "events", "position"]);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["card_suit_set"],
  );
  const event = result.events[0];
  assert.ok(event);
  assert.equal(event.type, "card_suit_set");
  if (event.type === "card_suit_set") {
    assert.equal(event.suit, "hearts");
    assert.equal(event.seat, "1");
  }
  assert.equal(Object.hasOwn(event, "rank"), false);
  assert.deepEqual(Object.keys(event).sort(), [
    "position",
    "seat",
    "suit",
    "type",
  ]);
  assert.equal(result.position, 3);
  assert.equal(event.position, 3);
  assert.equal(result.position, result.events.at(-1)?.position);

  const stored = store.read(TABLE_STREAM);
  assert.deepEqual(
    stored.map((recorded) => recorded.type),
    ["shoe_started", "card_observed", "card_suit_set"],
  );
  assert.equal("seat_piles" in result, false);
  assert.equal("penetration" in result, false);
  assert.equal("remaining_by_rank" in result, false);
  assert.equal("remaining_by_suit" in result, false);
  assert.equal("ra" in result, false);
  assert.equal("hand_totals" in result, false);
  assert.equal("mini_card_face" in result, false);
});

test("GWT felt after suit: latest observe on that seat paints rank+suit; order D,7..1", () => {
  const store = createInMemoryEventStore();
  startShoe(store, { decks: DECKS });
  observeCard(store, { rank: "5", seat: "1" });
  observeCard(store, { rank: "K", seat: "1" });
  observeCard(store, { rank: "10", seat: "D" });
  observeCard(store, { rank: "6", seat: "3" });

  const before = projectFeltTable(store.read(TABLE_STREAM));
  setSuit(store, { suit: "hearts", seat: "1" });
  setSuit(store, { suit: "spades", seat: "D" });
  const felt = projectFeltTable(store.read(TABLE_STREAM));

  assert.equal(felt.seat_order, "D,7,6,5,4,3,2,1");
  assert.deepEqual(
    felt.seat_piles.map((pile) => pile.seat),
    [...SEATS],
  );
  const hero = felt.seat_piles.find((pile) => pile.seat === "1");
  const dealer = felt.seat_piles.find((pile) => pile.seat === "D");
  const three = felt.seat_piles.find((pile) => pile.seat === "3");
  assert.ok(hero);
  assert.ok(dealer);
  assert.ok(three);
  // Latest observe on seat 1 is K, not the earlier 5. Dealer's 10 is not that seat.
  assert.deepEqual(hero.cards[0], { rank: "5", suit: null });
  assert.equal("mini_card_face" in hero.cards[0], false);
  const king = hero.cards[1];
  assert.ok(king && king.suit === "hearts");
  assert.deepEqual(king, piledCard("K", "hearts"));
  assert.equal(king.mini_card_face.face, "K♥");
  const ten = dealer.cards[0];
  assert.ok(ten && ten.suit === "spades");
  assert.deepEqual(ten, piledCard("10", "spades"));
  assert.equal(ten.mini_card_face.face, "T♠");
  assert.notEqual(ten.mini_card_face.face, "10♠");
  assert.deepEqual(three.cards, [{ rank: "6", suit: null }]);
  for (const pile of felt.seat_piles) {
    if (pile.seat !== "D" && pile.seat !== "1" && pile.seat !== "3") {
      assert.deepEqual(pile.cards, []);
    }
  }
  assert.deepEqual(felt.split_piles, []);
  assert.equal(felt.screen.focus_seat, "1");
  assert.equal(felt.screen.hero_seat, "1");
  assert.equal(felt.screen.split_button_visible, false);
  assert.deepEqual(
    felt.hand_totals.find((hand) => hand.seat === "1"),
    before.hand_totals.find((hand) => hand.seat === "1"),
  );
  assert.deepEqual(felt.hand_totals.find((hand) => hand.seat === "1"), {
    seat: "1",
    total: 15,
    colour: "#ffd43f",
    label: "Total: 15",
  });
});

test("GWT remaining_after_suit_set: one suit unit moves; outer rank ring stays", () => {
  const store = createInMemoryEventStore();
  startShoe(store, { decks: DECKS });
  observeCard(store, { rank: "5", seat: "1" });
  observeCard(store, { rank: "K", seat: "1" });

  const before = projectRemainingComposition(store.read(TABLE_STREAM));
  setSuit(store, { suit: "hearts", seat: "1" });
  const after = projectRemainingComposition(store.read(TABLE_STREAM));

  assert.deepEqual(after.remaining_by_rank, before.remaining_by_rank);
  assert.equal(
    after.remaining_by_rank.find((slice) => slice.rank === "K")?.count,
    31,
  );
  assert.equal(
    after.remaining_by_rank.find((slice) => slice.rank === "5")?.count,
    31,
  );
  assert.deepEqual(
    after.remaining_by_rank.map((slice) => slice.rank),
    [...RANKS],
  );
  assert.deepEqual(
    after.remaining_by_suit.map((slice) => slice.suit),
    [...SUIT_DRAW],
  );
  assert.deepEqual(
    after.remaining_by_suit.map((slice) => slice.count),
    [104, 104, 103, 104],
  );
  assert.equal(cell(after.remaining_by_rank_suit, "K", "hearts"), 7);
  for (const suit of SUIT_DRAW) {
    if (suit === "hearts") continue;
    assert.equal(cell(after.remaining_by_rank_suit, "K", suit), 8);
  }
  // Earlier 5 on the same seat is not the target, so its suit cells stay full.
  for (const suit of SUIT_DRAW) {
    assert.equal(cell(after.remaining_by_rank_suit, "5", suit), 8);
  }
  assert.deepEqual(after.outer_rank_ring, before.outer_rank_ring);
  assert.deepEqual(after.inner_suit_pie, before.inner_suit_pie);
  assert.equal(after.inner_suit_pie.draw_order, "spades, clubs, hearts, diamonds");
  assert.equal(
    after.tooltip.format.replace("{label}", "♥").replace("{value}", "103"),
    "♥: 103",
  );
  const suitSum = after.remaining_by_suit.reduce((sum, slice) => sum + slice.count, 0);
  const rankSum = after.remaining_by_rank.reduce((sum, slice) => sum + slice.count, 0);
  // One observed card still has no suit, so the pie is one ahead of the rank ring.
  assert.equal(suitSum, rankSum + 1);
  const kingSuits = SUIT_DRAW.reduce(
    (sum, suit) => sum + cell(after.remaining_by_rank_suit, "K", suit),
    0,
  );
  assert.equal(
    kingSuits,
    after.remaining_by_rank.find((slice) => slice.rank === "K")?.count,
  );
});

test("GWT suit correction: re-set moves one unit between suits, does not decrement twice", () => {
  const store = createInMemoryEventStore();
  startShoe(store, { decks: DECKS });
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "hearts", seat: "1" });
  const once = projectRemainingComposition(store.read(TABLE_STREAM));

  setSuit(store, { suit: "spades", seat: "1" });
  const twice = projectRemainingComposition(store.read(TABLE_STREAM));
  const felt = projectFeltTable(store.read(TABLE_STREAM));

  assert.deepEqual(twice.remaining_by_rank, once.remaining_by_rank);
  assert.equal(
    twice.remaining_by_rank.find((slice) => slice.rank === "K")?.count,
    31,
  );
  assert.deepEqual(
    twice.remaining_by_suit.map((slice) => slice.count),
    [103, 104, 104, 104],
  );
  assert.equal(cell(twice.remaining_by_rank_suit, "K", "hearts"), 8);
  assert.equal(cell(twice.remaining_by_rank_suit, "K", "spades"), 7);
  assert.equal(cell(twice.remaining_by_rank_suit, "K", "clubs"), 8);
  assert.equal(cell(twice.remaining_by_rank_suit, "K", "diamonds"), 8);
  const correctedKing = felt.seat_piles.find((pile) => pile.seat === "1")?.cards[0];
  assert.ok(correctedKing && correctedKing.suit === "spades");
  assert.deepEqual(correctedKing, piledCard("K", "spades"));
  assert.equal(correctedKing.mini_card_face.face, "K♠");

  setSuit(store, { suit: "spades", seat: "1" });
  const same = projectRemainingComposition(store.read(TABLE_STREAM));
  assert.deepEqual(same.remaining_by_suit, twice.remaining_by_suit);
  assert.deepEqual(same.remaining_by_rank_suit, twice.remaining_by_rank_suit);
  assert.deepEqual(same.remaining_by_rank, twice.remaining_by_rank);
});

test("GWT counts unchanged by suit alone", () => {
  const store = createInMemoryEventStore();
  startShoe(store, { decks: DECKS });
  observeCard(store, { rank: "5", seat: "1" });
  observeCard(store, { rank: "A", seat: "D" });
  const before = projectCountsInfoBar(store.read(TABLE_STREAM));

  setSuit(store, { suit: "hearts", seat: "1" });
  setSuit(store, { suit: "clubs", seat: "D" });
  const suited = projectCountsInfoBar(store.read(TABLE_STREAM));
  assert.deepEqual(suited, before);

  setSuit(store, { suit: "diamonds", seat: "1" });
  const corrected = projectCountsInfoBar(store.read(TABLE_STREAM));
  assert.deepEqual(corrected, before);
  assert.equal(corrected.hilo_rc, before.hilo_rc);
  assert.equal(corrected.acesLeft, before.acesLeft);
  assert.equal(corrected.penetration, before.penetration);
  assert.equal(corrected.ra.value, before.ra.value);
});
