import assert from "node:assert/strict";
import test from "node:test";
import { piledCard } from "../src/felt/piled-card.ts";
import { projectCountsInfoBar } from "../src/read/counts-info-bar.ts";
import { projectFeltTable } from "../src/read/felt-table.ts";
import { projectRemainingComposition } from "../src/read/remaining-composition.ts";
import {
  TABLE_STREAM,
  createInMemoryEventStore,
  type InMemoryEventStore,
} from "../src/write/in-memory-store.ts";
import { observeCard } from "../src/write/observe-card.ts";
import { setSuit } from "../src/write/set-suit.ts";
import { splitHand } from "../src/write/split-hand.ts";
import { startShoe } from "../src/write/start-shoe.ts";
import { withdrawCard } from "../src/write/withdraw-card.ts";

const DECKS = 8;
const SEATS = ["D", "7", "6", "5", "4", "3", "2", "1"] as const;

function shoeOnly(): InMemoryEventStore {
  const store = createInMemoryEventStore();
  startShoe(store, { decks: DECKS });
  return store;
}

test("withdraw_card requires a registered card", () => {
  const empty = createInMemoryEventStore();
  assert.throws(
    () => withdrawCard(empty, { rank: "K", seat: "1" }),
    /requires a registered card/,
  );
  assert.deepEqual(empty.read(TABLE_STREAM), []);

  const store = shoeOnly();
  const before = store.read(TABLE_STREAM).map((event) => event.type);
  assert.throws(
    () => withdrawCard(store, { rank: "5", seat: "1" }),
    /requires a registered card/,
  );
  assert.deepEqual(
    store.read(TABLE_STREAM).map((event) => event.type),
    before,
  );
});

test("GWT withdraw_card_happy: shoe + observe → card_withdrawn rank+seat, no suit", () => {
  const store = shoeOnly();
  observeCard(store, { rank: "5", seat: "1" });

  const result = withdrawCard(store, { rank: "5", seat: "1" });

  assert.equal(result.ack, true);
  assert.deepEqual(Object.keys(result).sort(), ["ack", "events", "position"]);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["card_withdrawn"],
  );
  const event = result.events[0];
  assert.ok(event);
  assert.equal(event.type, "card_withdrawn");
  if (event.type === "card_withdrawn") {
    assert.equal(event.rank, "5");
    assert.equal(event.seat, "1");
  }
  assert.equal(Object.hasOwn(event, "suit"), false);
  assert.equal(Object.hasOwn(event, "hand"), false);
  assert.deepEqual(Object.keys(event).sort(), [
    "position",
    "rank",
    "seat",
    "type",
  ]);
  assert.equal(result.position, 3);
  assert.equal(event.position, 3);
  assert.equal(result.position, result.events.at(-1)?.position);

  const stored = store.read(TABLE_STREAM);
  assert.deepEqual(
    stored.map((recorded) => recorded.type),
    ["shoe_started", "card_observed", "card_withdrawn"],
  );
  assert.equal("seat_piles" in result, false);
  assert.equal("split_piles" in result, false);
  assert.equal("penetration" in result, false);
  assert.equal("remaining_by_rank" in result, false);
  assert.equal("remaining_by_suit" in result, false);
  assert.equal("remaining_by_rank_suit" in result, false);
  assert.equal("ra" in result, false);
  assert.equal("hilo_rc" in result, false);
  assert.equal("hand_totals" in result, false);
  assert.equal("mini_card_face" in result, false);
});

test("GWT withdraw targets the last registered card, not an older one", () => {
  const store = shoeOnly();
  observeCard(store, { rank: "5", seat: "1" });
  observeCard(store, { rank: "K", seat: "D" });
  const before = store.read(TABLE_STREAM).map((event) => event.type);

  assert.throws(
    () => withdrawCard(store, { rank: "5", seat: "1" }),
    /last registered/,
  );
  assert.throws(
    () => withdrawCard(store, { rank: "K", seat: "1" }),
    /last registered/,
  );
  assert.throws(
    () => withdrawCard(store, { rank: "5", seat: "D" }),
    /last registered/,
  );
  assert.deepEqual(
    store.read(TABLE_STREAM).map((event) => event.type),
    before,
  );

  const result = withdrawCard(store, { rank: "K", seat: "D" });
  assert.equal(result.events[0]?.type, "card_withdrawn");
  assert.equal(result.position, 4);
  if (result.events[0]?.type === "card_withdrawn") {
    assert.equal(result.events[0].rank, "K");
    assert.equal(result.events[0].seat, "D");
  }

  const next = withdrawCard(store, { rank: "5", seat: "1" });
  assert.equal(next.position, 5);
  if (next.events[0]?.type === "card_withdrawn") {
    assert.equal(next.events[0].rank, "5");
    assert.equal(next.events[0].seat, "1");
  }
  assert.throws(
    () => withdrawCard(store, { rank: "5", seat: "1" }),
    /requires a registered card/,
  );
  assert.deepEqual(
    store.read(TABLE_STREAM).map((event) => event.type),
    [
      "shoe_started",
      "card_observed",
      "card_observed",
      "card_withdrawn",
      "card_withdrawn",
    ],
  );
});

test("GWT felt: last registered card leaves that seat; order D,7..1; totals follow", () => {
  const store = shoeOnly();
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "spades", seat: "1" });
  observeCard(store, { rank: "6", seat: "D" });
  observeCard(store, { rank: "7", seat: "1" });
  setSuit(store, { suit: "hearts", seat: "1" });

  const before = projectFeltTable(store.read(TABLE_STREAM));
  assert.equal(before.screen.split_button_visible, false);
  assert.equal(
    before.hand_totals.find((hand) => hand.seat === "1")?.total,
    17,
  );

  withdrawCard(store, { rank: "7", seat: "1" });
  const felt = projectFeltTable(store.read(TABLE_STREAM));

  assert.equal(felt.seat_order, "D,7,6,5,4,3,2,1");
  assert.deepEqual(
    felt.seat_piles.map((pile) => pile.seat),
    [...SEATS],
  );
  const hero = felt.seat_piles.find((pile) => pile.seat === "1");
  const dealer = felt.seat_piles.find((pile) => pile.seat === "D");
  assert.ok(hero);
  assert.ok(dealer);
  assert.deepEqual(hero.cards, [piledCard("K", "spades")]);
  assert.equal(hero.cards[0]?.mini_card_face.face, "K♠");
  assert.deepEqual(dealer.cards, [{ rank: "6", suit: null }]);
  assert.equal("mini_card_face" in (dealer.cards[0] ?? {}), false);
  for (const pile of felt.seat_piles) {
    if (pile.seat !== "D" && pile.seat !== "1") {
      assert.deepEqual(pile.cards, []);
    }
  }
  assert.deepEqual(felt.split_piles, []);
  assert.deepEqual(felt.hand_totals, [
    { seat: "D", total: 6, colour: "#ffd43f", label: "Total: 6" },
    { seat: "1", total: 10, colour: "#ffd43f", label: "Total: 10" },
  ]);
  assert.equal(felt.screen.focus_seat, "1");
  assert.equal(felt.screen.hero_seat, "1");
  assert.equal(felt.screen.split_button_visible, false);
  assert.equal(felt.screen.new_shoe, "start_shoe");
  assert.equal(felt.screen.next_hand, "complete_hand");

  withdrawCard(store, { rank: "6", seat: "D" });
  const dealerGone = projectFeltTable(store.read(TABLE_STREAM));
  assert.deepEqual(
    dealerGone.seat_piles.find((pile) => pile.seat === "D")?.cards,
    [],
  );
  assert.deepEqual(dealerGone.hand_totals, [
    { seat: "1", total: 10, colour: "#ffd43f", label: "Total: 10" },
  ]);
  assert.equal(dealerGone.seat_order, "D,7,6,5,4,3,2,1");
});

test("GWT felt: same rank twice removes the last card, not the earlier one", () => {
  const store = shoeOnly();
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "spades", seat: "1" });
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "diamonds", seat: "1" });

  withdrawCard(store, { rank: "K", seat: "1" });
  const felt = projectFeltTable(store.read(TABLE_STREAM));
  const hero = felt.seat_piles.find((pile) => pile.seat === "1");
  assert.deepEqual(hero?.cards, [piledCard("K", "spades")]);
  assert.equal(hero?.cards[0]?.mini_card_face.face, "K♠");
  assert.deepEqual(felt.hand_totals, [
    { seat: "1", total: 10, colour: "#ffd43f", label: "Total: 10" },
  ]);
});

test("GWT felt: last registered card leaves the split pile it landed in", () => {
  const store = shoeOnly();
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "spades", seat: "1" });
  observeCard(store, { rank: "6", seat: "D" });
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "diamonds", seat: "1" });
  splitHand(store, { seat: "1" });

  const split = projectFeltTable(store.read(TABLE_STREAM));
  assert.deepEqual(split.split_piles, [
    { seat: "1", hand: "A", cards: [piledCard("K", "spades")] },
    { seat: "1", hand: "B", cards: [piledCard("K", "diamonds")] },
  ]);

  assert.throws(
    () => withdrawCard(store, { rank: "6", seat: "D" }),
    /last registered/,
  );

  withdrawCard(store, { rank: "K", seat: "1" });
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
  assert.deepEqual(felt.split_piles, [
    { seat: "1", hand: "A", cards: [piledCard("K", "spades")] },
    { seat: "1", hand: "B", cards: [] },
  ]);
  assert.equal(felt.split_piles[0]?.cards[0]?.mini_card_face.face, "K♠");
  assert.deepEqual(felt.hand_totals, [
    { seat: "D", total: 6, colour: "#ffd43f", label: "Total: 6" },
    { seat: "1", hand: "A", total: 10, colour: "#ffd43f", label: "Total: 10" },
  ]);
  assert.equal(
    felt.hand_totals.some((hand) => hand.hand === "B"),
    false,
  );
  assert.equal(felt.screen.split_button_visible, false);
});

test("GWT bust card withdrawn: total and colour follow the cards that remain", () => {
  const store = shoeOnly();
  observeCard(store, { rank: "K", seat: "1" });
  observeCard(store, { rank: "K", seat: "1" });
  observeCard(store, { rank: "5", seat: "1" });
  assert.deepEqual(projectFeltTable(store.read(TABLE_STREAM)).hand_totals, [
    { seat: "1", total: 25, colour: "#ef4444", label: "Total: 25" },
  ]);

  withdrawCard(store, { rank: "5", seat: "1" });
  assert.deepEqual(projectFeltTable(store.read(TABLE_STREAM)).hand_totals, [
    { seat: "1", total: 20, colour: "#22c55e", label: "Total: 20" },
  ]);
});

test("GWT counts_after_withdraw: ace observe reverses, including Omega II", () => {
  const store = shoeOnly();
  const empty = projectCountsInfoBar(store.read(TABLE_STREAM));

  observeCard(store, { rank: "A", seat: "D" });
  const dealt = projectCountsInfoBar(store.read(TABLE_STREAM));
  assert.notEqual(dealt.hilo_rc, empty.hilo_rc);
  assert.notEqual(dealt.acesLeft, empty.acesLeft);
  assert.notEqual(dealt.ra.numeric, empty.ra.numeric);
  assert.notEqual(dealt.omega_ii_tc, empty.omega_ii_tc);
  assert.notEqual(dealt.penetration, empty.penetration);
  assert.equal(dealt.acesLeft, empty.acesLeft - 1);

  withdrawCard(store, { rank: "A", seat: "D" });
  const restored = projectCountsInfoBar(store.read(TABLE_STREAM));
  assert.deepEqual(restored, empty);
  assert.equal(restored.omega_ii_tc, empty.omega_ii_tc);
  assert.equal(restored.ace_tc, empty.ace_tc);
  assert.equal(restored.hilo_rc, 0);
  assert.equal(restored.acesLeft, empty.acesLeft);
});

test("GWT counts_after_withdraw: only the last card's tags reverse", () => {
  const store = shoeOnly();
  observeCard(store, { rank: "5", seat: "1" });
  const afterFive = projectCountsInfoBar(store.read(TABLE_STREAM));
  observeCard(store, { rank: "K", seat: "D" });
  const both = projectCountsInfoBar(store.read(TABLE_STREAM));
  assert.notDeepEqual(both, afterFive);
  assert.notEqual(both.omega_ii_tc, afterFive.omega_ii_tc);
  assert.notEqual(both.hilo_rc, afterFive.hilo_rc);

  withdrawCard(store, { rank: "K", seat: "D" });
  const restored = projectCountsInfoBar(store.read(TABLE_STREAM));
  assert.deepEqual(restored, afterFive);
  assert.equal(restored.hilo_rc, afterFive.hilo_rc);
  assert.equal(restored.omega_ii_tc, afterFive.omega_ii_tc);
  assert.equal(restored.zen_tc, afterFive.zen_tc);
  assert.equal(restored.apc_tc, afterFive.apc_tc);
  assert.equal(restored.penetration, afterFive.penetration);
  assert.equal(restored.decks_left, afterFive.decks_left);
  assert.equal(restored.ra.value, afterFive.ra.value);
  assert.equal(restored.acesLeft, afterFive.acesLeft);
});

test("GWT remaining_after_withdraw: suited card restores rank and that suit", () => {
  const store = shoeOnly();
  const full = projectRemainingComposition(store.read(TABLE_STREAM));

  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "hearts", seat: "1" });
  const dealt = projectRemainingComposition(store.read(TABLE_STREAM));
  assert.equal(
    dealt.remaining_by_rank.find((slice) => slice.rank === "K")?.count,
    31,
  );
  assert.equal(
    dealt.remaining_by_suit.find((slice) => slice.suit === "hearts")?.count,
    103,
  );

  setSuit(store, { suit: "spades", seat: "1" });
  withdrawCard(store, { rank: "K", seat: "1" });
  const restored = projectRemainingComposition(store.read(TABLE_STREAM));
  assert.deepEqual(restored, full);
  assert.equal(
    restored.remaining_by_rank.find((slice) => slice.rank === "K")?.count,
    32,
  );
  assert.deepEqual(
    restored.remaining_by_suit.map((slice) => slice.count),
    [104, 104, 104, 104],
  );
});

test("GWT remaining_after_withdraw: no suit set restores rank only", () => {
  const store = shoeOnly();
  const full = projectRemainingComposition(store.read(TABLE_STREAM));

  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "hearts", seat: "1" });
  observeCard(store, { rank: "5", seat: "D" });
  const before = projectRemainingComposition(store.read(TABLE_STREAM));
  assert.equal(
    before.remaining_by_rank.find((slice) => slice.rank === "5")?.count,
    31,
  );
  assert.equal(
    before.remaining_by_suit.find((slice) => slice.suit === "hearts")?.count,
    103,
  );

  withdrawCard(store, { rank: "5", seat: "D" });
  const after = projectRemainingComposition(store.read(TABLE_STREAM));

  assert.equal(
    after.remaining_by_rank.find((slice) => slice.rank === "5")?.count,
    32,
  );
  assert.equal(
    after.remaining_by_rank.find((slice) => slice.rank === "K")?.count,
    31,
  );
  assert.deepEqual(
    after.remaining_by_suit.map((slice) => slice.count),
    [104, 104, 103, 104],
  );
  assert.notDeepEqual(after.remaining_by_suit, full.remaining_by_suit);
  assert.equal(
    after.remaining_by_rank_suit.find(
      (cell) => cell.rank === "K" && cell.suit === "hearts",
    )?.count,
    7,
  );
  for (const suit of ["spades", "clubs", "diamonds"] as const) {
    assert.equal(
      after.remaining_by_rank_suit.find(
        (cell) => cell.rank === "5" && cell.suit === suit,
      )?.count,
      8,
    );
  }
  assert.equal(
    after.remaining_by_rank_suit.find(
      (cell) => cell.rank === "5" && cell.suit === "hearts",
    )?.count,
    8,
  );
  assert.deepEqual(after.outer_rank_ring, full.outer_rank_ring);
  assert.deepEqual(after.inner_suit_pie, full.inner_suit_pie);
});

test("GWT hand boundary: a completed hand has nothing left to withdraw", () => {
  const store = shoeOnly();
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "clubs", seat: "1" });
  startShoe(store, { decks: DECKS });

  const before = store.read(TABLE_STREAM).map((event) => event.type);
  assert.throws(
    () => withdrawCard(store, { rank: "K", seat: "1" }),
    /requires a registered card/,
  );
  assert.deepEqual(
    store.read(TABLE_STREAM).map((event) => event.type),
    before,
  );
  assert.equal(
    store.read(TABLE_STREAM).some((event) => event.type === "card_withdrawn"),
    false,
  );

  const fresh = projectCountsInfoBar(store.read(TABLE_STREAM));
  const full = projectRemainingComposition(store.read(TABLE_STREAM));
  observeCard(store, { rank: "9", seat: "3" });
  withdrawCard(store, { rank: "9", seat: "3" });
  assert.deepEqual(projectCountsInfoBar(store.read(TABLE_STREAM)), fresh);
  assert.deepEqual(projectRemainingComposition(store.read(TABLE_STREAM)), full);
  assert.deepEqual(
    projectFeltTable(store.read(TABLE_STREAM)).seat_piles.map((pile) => pile.cards),
    SEATS.map(() => []),
  );
});

test("GWT withdrawing one king of a hero pair is no longer a pair", () => {
  const store = shoeOnly();
  observeCard(store, { rank: "K", seat: "1" });
  observeCard(store, { rank: "K", seat: "1" });
  withdrawCard(store, { rank: "K", seat: "1" });

  const before = store.read(TABLE_STREAM).map((event) => event.type);
  assert.throws(() => splitHand(store, { seat: "1" }), /same rank/);
  assert.deepEqual(
    store.read(TABLE_STREAM).map((event) => event.type),
    before,
  );
  assert.equal(
    projectFeltTable(store.read(TABLE_STREAM)).screen.split_button_visible,
    false,
  );
});
