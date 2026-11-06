import assert from "node:assert/strict";
import test from "node:test";
import { piledCard } from "../src/felt/piled-card.ts";
import { projectCountsInfoBar } from "../src/read/counts-info-bar.ts";
import { projectFeltTable } from "../src/read/felt-table.ts";
import { projectRemainingComposition } from "../src/read/remaining-composition.ts";
import { completeHand } from "../src/write/complete-hand.ts";
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

test("GWT complete_hand_happy: shoe + observe → hand_completed, no payload", () => {
  const store = shoeOnly();
  observeCard(store, { rank: "5", seat: "1" });

  const result = completeHand(store);

  assert.equal(result.ack, true);
  assert.deepEqual(Object.keys(result).sort(), ["ack", "events", "position"]);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["hand_completed"],
  );
  const event = result.events[0];
  assert.ok(event);
  assert.equal(event.type, "hand_completed");
  assert.deepEqual(Object.keys(event).sort(), ["position", "type"]);
  assert.equal(result.position, 3);
  assert.equal(event.position, 3);
  assert.equal(result.position, result.events.at(-1)?.position);

  const stored = store.read(TABLE_STREAM);
  assert.deepEqual(
    stored.map((recorded) => recorded.type),
    ["shoe_started", "card_observed", "hand_completed"],
  );
  assert.equal(
    stored.some((recorded) => recorded.type === "shoe_started" && recorded.position > 1),
    false,
  );
  assert.equal("seat_piles" in result, false);
  assert.equal("split_piles" in result, false);
  assert.equal("hand_totals" in result, false);
  assert.equal("seat_order" in result, false);
  assert.equal("penetration" in result, false);
  assert.equal("remaining_by_rank" in result, false);
  assert.equal("remaining_by_suit" in result, false);
  assert.equal("remaining_by_rank_suit" in result, false);
  assert.equal("ra" in result, false);
  assert.equal("hilo_rc" in result, false);
  assert.equal("mini_card_face" in result, false);
});

test("GWT felt_table_empty_after_hand_completed: piles and totals gone, order stays", () => {
  const store = shoeOnly();
  observeCard(store, { rank: "6", seat: "D" });
  setSuit(store, { suit: "hearts", seat: "D" });
  observeCard(store, { rank: "K", seat: "7" });
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "spades", seat: "1" });
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "diamonds", seat: "1" });
  splitHand(store, { seat: "1" });

  const dealt = projectFeltTable(store.read(TABLE_STREAM));
  assert.equal(dealt.split_piles.length, 2);
  assert.ok(dealt.hand_totals.length > 0);
  const dealerCard = dealt.seat_piles.find((pile) => pile.seat === "D")
    ?.cards[0];
  assert.ok(dealerCard && dealerCard.suit === "hearts");
  assert.equal(dealerCard.mini_card_face.face, "6♥");

  completeHand(store);
  const felt = projectFeltTable(store.read(TABLE_STREAM));

  assert.equal(felt.seat_order, "D,7,6,5,4,3,2,1");
  assert.deepEqual(
    felt.seat_piles.map((pile) => pile.seat),
    [...SEATS],
  );
  for (const pile of felt.seat_piles) {
    assert.deepEqual(pile.cards, []);
  }
  assert.deepEqual(felt.split_piles, []);
  assert.deepEqual(felt.hand_totals, []);
  assert.equal(felt.screen.focus_seat, "1");
  assert.equal(felt.screen.hero_seat, "1");
  assert.equal(felt.screen.split_button_visible, false);
  assert.equal(felt.screen.new_shoe, "start_shoe");
  assert.equal(felt.screen.next_hand, "complete_hand");

  observeCard(store, { rank: "9", seat: "3" });
  const next = projectFeltTable(store.read(TABLE_STREAM));
  assert.equal(next.seat_order, "D,7,6,5,4,3,2,1");
  assert.deepEqual(next.split_piles, []);
  assert.deepEqual(
    next.seat_piles.find((pile) => pile.seat === "3")?.cards,
    [{ rank: "9", suit: null }],
  );
  for (const pile of next.seat_piles) {
    if (pile.seat !== "3") assert.deepEqual(pile.cards, []);
  }
  assert.deepEqual(next.hand_totals, [
    { seat: "3", total: 9, colour: "#ffd43f", label: "Total: 9" },
  ]);
  assert.equal(
    next.seat_piles.some((pile) =>
      pile.cards.some((card) => "mini_card_face" in card && card.rank === "6"),
    ),
    false,
  );
  assert.equal(piledCard("6", "hearts").mini_card_face.face, "6♥");
});

test("GWT counts and remaining ignore hand_completed — shoe persists", () => {
  const store = shoeOnly();
  observeCard(store, { rank: "A", seat: "D" });
  observeCard(store, { rank: "5", seat: "1" });
  setSuit(store, { suit: "hearts", seat: "1" });
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "spades", seat: "1" });

  const counts = projectCountsInfoBar(store.read(TABLE_STREAM));
  const remaining = projectRemainingComposition(store.read(TABLE_STREAM));
  const empty = projectCountsInfoBar(
    store.read(TABLE_STREAM).filter((event) => event.type === "shoe_started"),
  );
  assert.notDeepEqual(counts, empty);
  assert.equal(
    remaining.remaining_by_rank.find((slice) => slice.rank === "A")?.count,
    31,
  );
  assert.equal(
    remaining.remaining_by_rank.find((slice) => slice.rank === "5")?.count,
    31,
  );
  assert.equal(
    remaining.remaining_by_suit.find((slice) => slice.suit === "hearts")?.count,
    103,
  );
  assert.equal(
    remaining.remaining_by_suit.find((slice) => slice.suit === "spades")?.count,
    103,
  );

  completeHand(store);

  assert.deepEqual(
    projectCountsInfoBar(store.read(TABLE_STREAM)),
    counts,
  );
  assert.deepEqual(
    projectRemainingComposition(store.read(TABLE_STREAM)),
    remaining,
  );

  observeCard(store, { rank: "2", seat: "2" });
  const continued = projectCountsInfoBar(store.read(TABLE_STREAM));
  assert.notDeepEqual(continued, counts);
  assert.notDeepEqual(continued, empty);
  assert.equal(continued.acesLeft, counts.acesLeft);
  assert.equal(continued.hilo_rc, counts.hilo_rc + 1);

  const afterTwo = projectRemainingComposition(store.read(TABLE_STREAM));
  assert.equal(
    afterTwo.remaining_by_rank.find((slice) => slice.rank === "2")?.count,
    31,
  );
  assert.equal(
    afterTwo.remaining_by_rank.find((slice) => slice.rank === "A")?.count,
    31,
  );
  assert.equal(
    afterTwo.remaining_by_suit.find((slice) => slice.suit === "hearts")?.count,
    103,
  );
  assert.equal(
    afterTwo.remaining_by_suit.find((slice) => slice.suit === "spades")?.count,
    103,
  );
});

test("GWT a completed hand has nothing left to withdraw or split", () => {
  const store = shoeOnly();
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "clubs", seat: "1" });
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "diamonds", seat: "1" });
  completeHand(store);

  const before = store.read(TABLE_STREAM).map((event) => event.type);
  assert.throws(
    () => withdrawCard(store, { rank: "K", seat: "1" }),
    /requires a registered card/,
  );
  assert.throws(() => splitHand(store, { seat: "1" }), /same rank/);
  assert.deepEqual(
    store.read(TABLE_STREAM).map((event) => event.type),
    before,
  );
});
