import assert from "node:assert/strict";
import test from "node:test";
import { piledCard } from "../src/felt/piled-card.ts";
import { projectCountsInfoBar } from "../src/read/counts-info-bar.ts";
import { projectFeltTable } from "../src/read/felt-table.ts";
import { projectRemainingComposition } from "../src/read/remaining-composition.ts";
import type { Rank } from "../src/counting/maps.ts";
import {
  TABLE_STREAM,
  createInMemoryEventStore,
  type InMemoryEventStore,
} from "../src/write/in-memory-store.ts";
import { observeCard } from "../src/write/observe-card.ts";
import { setSuit } from "../src/write/set-suit.ts";
import { splitHand } from "../src/write/split-hand.ts";
import { startShoe } from "../src/write/start-shoe.ts";
import type { Seat } from "../src/write/events.ts";

const DECKS = 8;
const SEATS = ["D", "7", "6", "5", "4", "3", "2", "1"] as const;

function dealt(
  cards: readonly { rank: Rank; seat: Seat }[],
): InMemoryEventStore {
  const store = createInMemoryEventStore();
  startShoe(store, { decks: DECKS });
  for (const card of cards) observeCard(store, card);
  return store;
}

test("split_hand requires a shoe", () => {
  const store = createInMemoryEventStore();
  assert.throws(() => splitHand(store, { seat: "1" }), /requires a shoe/);
  assert.deepEqual(store.read(TABLE_STREAM), []);
});

test("GWT split_hand_happy: shoe + two same-rank observes on hero → hand_split seat", () => {
  const store = dealt([
    { rank: "K", seat: "1" },
    { rank: "K", seat: "1" },
  ]);

  const result = splitHand(store, { seat: "1" });

  assert.equal(result.ack, true);
  assert.deepEqual(Object.keys(result).sort(), ["ack", "events", "position"]);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["hand_split"],
  );
  const event = result.events[0];
  assert.ok(event);
  assert.equal(event.type, "hand_split");
  if (event.type === "hand_split") {
    assert.equal(event.seat, "1");
  }
  assert.equal(Object.hasOwn(event, "rank"), false);
  assert.equal(Object.hasOwn(event, "suit"), false);
  assert.equal(Object.hasOwn(event, "hand"), false);
  assert.deepEqual(Object.keys(event).sort(), ["position", "seat", "type"]);
  assert.equal(result.position, 4);
  assert.equal(event.position, 4);
  assert.equal(result.position, result.events.at(-1)?.position);

  const stored = store.read(TABLE_STREAM);
  assert.deepEqual(
    stored.map((recorded) => recorded.type),
    ["shoe_started", "card_observed", "card_observed", "hand_split"],
  );
  assert.equal("seat_piles" in result, false);
  assert.equal("split_piles" in result, false);
  assert.equal("penetration" in result, false);
  assert.equal("remaining_by_rank" in result, false);
  assert.equal("remaining_by_suit" in result, false);
  assert.equal("ra" in result, false);
  assert.equal("hand_totals" in result, false);
  assert.equal("mini_card_face" in result, false);
});

test("GWT split_same_point_value: same point value splits; 10/J/Q/K mix, 9+K does not", () => {
  // split_same_point_value (03, 2026-11-17 ~01:44): 10, J, Q, K all count 10.
  const pairs: [Rank, Rank][] = [
    ["J", "J"],
    ["10", "10"],
    ["10", "K"],
    ["K", "Q"],
    ["10", "J"],
    ["J", "Q"],
    ["A", "A"],
    ["8", "8"],
  ];
  for (const [first, second] of pairs) {
    const store = dealt([
      { rank: first, seat: "1" },
      { rank: second, seat: "1" },
    ]);
    assert.equal(splitHand(store, { seat: "1" }).events[0]?.type, "hand_split", `${first}+${second}`);
  }

  // split_hand_different_values_rejected: K♥ then 9♠.
  for (const [first, second] of [
    ["K", "9"],
    ["A", "K"],
    ["2", "3"],
  ] as const) {
    const store = dealt([
      { rank: first, seat: "1" },
      { rank: second, seat: "1" },
    ]);
    const before = store.read(TABLE_STREAM).map((event) => event.type);
    assert.throws(() => splitHand(store, { seat: "1" }), /same point value/);
    assert.deepEqual(store.read(TABLE_STREAM).map((event) => event.type), before);
  }
});

test("GWT split_first_two_cards_only: one, three and zero cards do not split", () => {
  const one = dealt([{ rank: "K", seat: "1" }]);
  const three = dealt([
    { rank: "K", seat: "1" },
    { rank: "K", seat: "1" },
    { rank: "K", seat: "1" },
  ]);
  const none = dealt([]);
  for (const store of [one, three, none]) {
    const before = store.read(TABLE_STREAM).map((event) => event.type);
    assert.throws(() => splitHand(store, { seat: "1" }), /first two cards/);
    assert.deepEqual(store.read(TABLE_STREAM).map((event) => event.type), before);
  }
});

test("GWT split_hand_other_player_seat: any player seat 1-7 splits; split_hand_dealer_rejected", () => {
  // split_on_every_player_seat (03, 2026-11-17 ~01:24): no hero precondition.
  for (const seat of ["1", "2", "3", "4", "5", "6", "7"] as const) {
    const store = dealt([
      { rank: "K", seat },
      { rank: "K", seat },
    ]);
    const ack = splitHand(store, { seat });
    assert.deepEqual(
      ack.events.map(({ position: _position, ...fact }) => fact),
      [{ type: "hand_split", seat }],
    );
  }
  const dealer = dealt([
    { rank: "A", seat: "D" },
    { rank: "A", seat: "D" },
  ]);
  const before = dealer.read(TABLE_STREAM).length;
  assert.throws(() => splitHand(dealer, { seat: "D" }), /dealer cannot split/);
  assert.equal(dealer.read(TABLE_STREAM).length, before);
  assert.equal(
    dealer.read(TABLE_STREAM).some((event) => event.type === "hand_split"),
    false,
  );
});

test("GWT already split: second split does not append; a new shoe can split again", () => {
  const store = dealt([
    { rank: "K", seat: "1" },
    { rank: "K", seat: "1" },
  ]);
  splitHand(store, { seat: "1" });
  const once = store.read(TABLE_STREAM).map((event) => event.type);

  assert.throws(() => splitHand(store, { seat: "1" }), /already split/);
  assert.deepEqual(
    store.read(TABLE_STREAM).map((event) => event.type),
    once,
  );

  startShoe(store, { decks: DECKS });
  observeCard(store, { rank: "Q", seat: "1" });
  observeCard(store, { rank: "Q", seat: "1" });
  const again = splitHand(store, { seat: "1" });
  assert.equal(again.events[0]?.type, "hand_split");
  assert.equal(again.position, 9);
  assert.deepEqual(
    store.read(TABLE_STREAM).map((event) => event.type),
    [
      "shoe_started",
      "card_observed",
      "card_observed",
      "hand_split",
      "hand_completed",
      "shoe_started",
      "card_observed",
      "card_observed",
      "hand_split",
    ],
  );
});

test("GWT felt_table_piles_after_cards: hero pair becomes split A/B; order D,7..1", () => {
  const store = dealt([
    { rank: "K", seat: "1" },
    { rank: "6", seat: "D" },
  ]);
  setSuit(store, { suit: "spades", seat: "1" });
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "diamonds", seat: "1" });

  const before = projectFeltTable(store.read(TABLE_STREAM));
  assert.deepEqual(before.screen.split_ready_seats, ["1"]);
  assert.equal(before.screen.hero_seat, "1");

  splitHand(store, { seat: "1" });
  const felt = projectFeltTable(store.read(TABLE_STREAM));

  assert.equal(felt.seat_order, "D,7,6,5,4,3,2,1");
  assert.deepEqual(
    felt.seat_piles.map((pile) => pile.seat),
    [...SEATS],
  );
  assert.deepEqual(
    felt.seat_piles.find((pile) => pile.seat === "1")?.cards,
    [],
  );
  assert.deepEqual(
    felt.seat_piles.find((pile) => pile.seat === "D")?.cards,
    [{ rank: "6", suit: null }],
  );
  for (const pile of felt.seat_piles) {
    if (pile.seat !== "D" && pile.seat !== "1") {
      assert.deepEqual(pile.cards, []);
    }
  }
  assert.deepEqual(felt.split_piles, [
    { seat: "1", hand: "A", cards: [piledCard("K", "spades")] },
    { seat: "1", hand: "B", cards: [piledCard("K", "diamonds")] },
  ]);
  const ace = felt.split_piles[0]?.cards[0];
  const bee = felt.split_piles[1]?.cards[0];
  assert.ok(ace && ace.suit === "spades");
  assert.equal(ace.mini_card_face.face, "K♠");
  assert.ok(bee && bee.suit === "diamonds");
  assert.equal(bee.mini_card_face.face, "K♦");
  assert.deepEqual(felt.hand_totals, [
    { seat: "D", total: 6, colour: "#ffd43f", label: "Total: 6" },
    { seat: "1", hand: "A", total: 10, colour: "#ffd43f", label: "Total: 10" },
    { seat: "1", hand: "B", total: 10, colour: "#ffd43f", label: "Total: 10" },
  ]);
  assert.equal(
    felt.hand_totals.some((hand) => hand.seat === "1" && hand.hand === undefined),
    false,
  );
  assert.notEqual(
    felt.hand_totals.find((hand) => hand.hand === "A")?.total,
    20,
  );
  assert.equal(felt.screen.focus_seat, "1");
  assert.equal(felt.screen.hero_seat, "1");
  assert.deepEqual(felt.screen.split_ready_seats, []);
  assert.equal(felt.screen.new_shoe, "start_shoe");
  assert.equal(felt.screen.next_hand, "complete_hand");
});

test("GWT felt unsuit pair: A/B stay rank-only, no mini face", () => {
  const store = dealt([
    { rank: "K", seat: "1" },
    { rank: "K", seat: "1" },
  ]);
  splitHand(store, { seat: "1" });
  const felt = projectFeltTable(store.read(TABLE_STREAM));

  assert.deepEqual(felt.split_piles, [
    { seat: "1", hand: "A", cards: [{ rank: "K", suit: null }] },
    { seat: "1", hand: "B", cards: [{ rank: "K", suit: null }] },
  ]);
  for (const pile of felt.split_piles) {
    const card = pile.cards[0];
    assert.ok(card);
    assert.equal("mini_card_face" in card, false);
  }
  assert.deepEqual(felt.hand_totals, [
    { seat: "1", hand: "A", total: 10, colour: "#ffd43f", label: "Total: 10" },
    { seat: "1", hand: "B", total: 10, colour: "#ffd43f", label: "Total: 10" },
  ]);
});

test("GWT felt_table_screen_split_and_select: split ready on any unsplit same-value player pair", () => {
  const heroPair = dealt([
    { rank: "K", seat: "1" },
    { rank: "K", seat: "1" },
  ]);
  const open = projectFeltTable(heroPair.read(TABLE_STREAM));
  assert.deepEqual(open.screen.split_ready_seats, ["1"]);
  assert.equal(open.screen.focus_seat, "1");
  assert.equal(open.screen.hero_seat, "1");
  setSuit(heroPair, { suit: "hearts", seat: "1" });
  assert.deepEqual(projectFeltTable(heroPair.read(TABLE_STREAM)).screen.split_ready_seats, ["1"]);

  // felt_table_split_mixed_ten_values: 10 and K share point value 10.
  const tenKing = dealt([
    { rank: "10", seat: "1" },
    { rank: "K", seat: "1" },
  ]);
  assert.deepEqual(projectFeltTable(tenKing.read(TABLE_STREAM)).screen.split_ready_seats, ["1"]);
  // felt_table_split_unavailable_mixed_ranks: K and 9 differ.
  const kingNine = dealt([
    { rank: "K", seat: "1" },
    { rank: "9", seat: "1" },
  ]);
  assert.deepEqual(projectFeltTable(kingNine.read(TABLE_STREAM)).screen.split_ready_seats, []);

  // felt_table_split_other_player_seat: seat 3 is ready; the dealer never is.
  const otherSeat = dealt([
    { rank: "Q", seat: "3" },
    { rank: "Q", seat: "3" },
    { rank: "A", seat: "D" },
    { rank: "A", seat: "D" },
  ]);
  const other = projectFeltTable(otherSeat.read(TABLE_STREAM));
  assert.deepEqual(other.screen.split_ready_seats, ["3"]);
  assert.equal(other.screen.hero_seat, "1");
  assert.deepEqual(other.split_piles, []);

  const single = dealt([{ rank: "A", seat: "1" }]);
  assert.deepEqual(projectFeltTable(single.read(TABLE_STREAM)).screen.split_ready_seats, []);

  const three = dealt([
    { rank: "9", seat: "1" },
    { rank: "9", seat: "1" },
    { rank: "9", seat: "1" },
  ]);
  assert.deepEqual(projectFeltTable(three.read(TABLE_STREAM)).screen.split_ready_seats, []);

  splitHand(heroPair, { seat: "1" });
  assert.deepEqual(projectFeltTable(heroPair.read(TABLE_STREAM)).screen.split_ready_seats, []);
});

test("GWT counts unchanged by split alone", () => {
  const store = dealt([
    { rank: "K", seat: "1" },
    { rank: "K", seat: "1" },
    { rank: "A", seat: "D" },
  ]);
  const before = projectCountsInfoBar(store.read(TABLE_STREAM));

  splitHand(store, { seat: "1" });
  const after = projectCountsInfoBar(store.read(TABLE_STREAM));

  assert.deepEqual(after, before);
  assert.equal(after.hilo_rc, before.hilo_rc);
  assert.equal(after.acesLeft, before.acesLeft);
  assert.equal(after.penetration, before.penetration);
  assert.equal(after.ra.value, before.ra.value);
});

test("GWT remaining unchanged by split alone", () => {
  const store = dealt([{ rank: "K", seat: "1" }]);
  setSuit(store, { suit: "spades", seat: "1" });
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "diamonds", seat: "1" });
  const before = projectRemainingComposition(store.read(TABLE_STREAM));

  splitHand(store, { seat: "1" });
  const after = projectRemainingComposition(store.read(TABLE_STREAM));

  assert.deepEqual(after, before);
  assert.equal(
    after.remaining_by_rank.find((slice) => slice.rank === "K")?.count,
    30,
  );
  assert.deepEqual(
    after.remaining_by_suit.map((slice) => slice.count),
    [103, 104, 104, 103],
  );
});

test("GWT felt decodes seat 1A onto pile A, then the two-card pile advances left", () => {
  const store = dealt([
    { rank: "K", seat: "1" },
    { rank: "K", seat: "1" },
  ]);
  splitHand(store, { seat: "1" });
  observeCard(store, { rank: "5", seat: "1A" });
  setSuit(store, { suit: "spades", seat: "1A" });

  const felt = projectFeltTable(store.read(TABLE_STREAM));
  const ace = felt.split_piles.find((pile) => pile.hand === "A");
  const bee = felt.split_piles.find((pile) => pile.hand === "B");
  assert.equal(ace?.seat, "1");
  assert.deepEqual(
    ace?.cards.map((card) => card.rank),
    ["K", "5"],
  );
  const five = ace?.cards[1];
  assert.equal(five && "suit" in five ? five.suit : null, "spades");
  assert.equal(five && "mini_card_face" in five ? five.mini_card_face.face : "", "5♠");
  assert.deepEqual(
    bee?.cards.map((card) => card.rank),
    ["K"],
  );
  assert.deepEqual(felt.seat_piles.find((pile) => pile.seat === "1")?.cards, []);
  assert.equal(felt.screen.active_split, null);
  assert.equal(felt.screen.focus_seat, "2");
  assert.equal(felt.screen.hero_seat, "1");
  assert.equal(
    felt.hand_totals.find((total) => total.hand === "A")?.label,
    "Total: 15",
  );
  assert.equal(
    felt.hand_totals.find((total) => total.hand === "A")?.colour,
    "#ffd43f",
  );
  assert.equal(
    felt.hand_totals.find((total) => total.hand === "B")?.label,
    "Total: 10",
  );
  const history = store.read(TABLE_STREAM);
  const observed = history.at(-2);
  const suited = history.at(-1);
  assert.equal(observed?.type, "card_observed");
  assert.equal(observed?.type === "card_observed" ? observed.seat : "", "1A");
  assert.equal(suited?.type, "card_suit_set");
  assert.equal(suited?.type === "card_suit_set" ? suited.seat : "", "1A");
});
