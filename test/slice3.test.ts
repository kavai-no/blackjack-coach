import assert from "node:assert/strict";
import test from "node:test";
import { COUNT_MAPS, RANKS, type Rank } from "../src/counting/maps.ts";
import { projectCountsInfoBar } from "../src/read/counts-info-bar.ts";
import { projectFeltTable } from "../src/read/felt-table.ts";
import { projectRemainingComposition } from "../src/read/remaining-composition.ts";
import {
  TABLE_STREAM,
  createInMemoryEventStore,
  type DomainEvent,
} from "../src/write/in-memory-store.ts";
import { observeCard } from "../src/write/observe-card.ts";
import { startShoe } from "../src/write/start-shoe.ts";

const DECKS = 8;
const CARDS_PER_DECK = 52;
const SEATS = ["D", "7", "6", "5", "4", "3", "2", "1"] as const;
/** Donut draw order — not `state.js` storage order. */
const SUIT_DRAW = ["spades", "clubs", "hearts", "diamonds"] as const;

/** Info-bar rounding: `toFixed(2)`, no forced plus. */
function fixed2(n: number): string {
  return n.toFixed(2);
}

function shoe(): DomainEvent {
  return { type: "shoe_started", decks: DECKS };
}

function observed(rank: Rank, seat: (typeof SEATS)[number]): DomainEvent {
  return { type: "card_observed", rank, seat };
}

test("GWT observe_card_happy: shoe started → card_observed rank+seat, no suit", () => {
  const store = createInMemoryEventStore();
  startShoe(store, { decks: DECKS });

  const result = observeCard(store, { rank: "5", seat: "1" });

  assert.equal(result.ack, true);
  assert.deepEqual(Object.keys(result).sort(), ["ack", "events", "position"]);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["card_observed"],
  );
  const event = result.events[0];
  assert.ok(event);
  assert.equal(event.type, "card_observed");
  if (event.type === "card_observed") {
    assert.equal(event.rank, "5");
    assert.equal(event.seat, "1");
  }
  assert.equal(Object.hasOwn(event, "suit"), false);
  assert.deepEqual(Object.keys(event).sort(), [
    "position",
    "rank",
    "seat",
    "type",
  ]);
  assert.equal(result.position, 2);
  assert.equal(event.position, 2);
  assert.equal(result.position, result.events.at(-1)?.position);

  const stored = store.read(TABLE_STREAM);
  assert.deepEqual(
    stored.map((recorded) => recorded.type),
    ["shoe_started", "card_observed"],
  );
  assert.equal("seat_piles" in result, false);
  assert.equal("penetration" in result, false);
  assert.equal("remaining_by_rank" in result, false);
  assert.equal("ra" in result, false);
  assert.equal("hand_totals" in result, false);
});

test("GWT felt after observe: rank on that seat, suit unset, order D,7..1", () => {
  const store = createInMemoryEventStore();
  startShoe(store, { decks: DECKS });
  observeCard(store, { rank: "5", seat: "1" });
  observeCard(store, { rank: "K", seat: "D" });

  const felt = projectFeltTable(store.read(TABLE_STREAM));

  assert.equal(felt.seat_order, "D,7,6,5,4,3,2,1");
  assert.deepEqual(
    felt.seat_piles.map((pile) => pile.seat),
    [...SEATS],
  );
  const dealer = felt.seat_piles.find((pile) => pile.seat === "D");
  const hero = felt.seat_piles.find((pile) => pile.seat === "1");
  assert.ok(dealer);
  assert.ok(hero);
  assert.deepEqual(dealer.cards, [{ rank: "K", suit: null }]);
  assert.deepEqual(hero.cards, [{ rank: "5", suit: null }]);
  for (const card of [...dealer.cards, ...hero.cards]) {
    assert.equal(card.suit, null);
    assert.equal("mini_card_face" in card, false);
  }
  for (const pile of felt.seat_piles) {
    if (pile.seat !== "D" && pile.seat !== "1") {
      assert.deepEqual(pile.cards, []);
    }
  }
  assert.deepEqual(felt.split_piles, []);
  assert.equal(felt.screen.focus_seat, "1");
  assert.equal(felt.screen.hero_seat, "1");
  assert.equal(felt.screen.split_button_visible, false);
  assert.deepEqual(
    felt.hand_totals.find((hand) => hand.seat === "1"),
    { seat: "1", total: 5, colour: "#ffd43f", label: "Total: 5" },
  );
  assert.deepEqual(
    felt.hand_totals.find((hand) => hand.seat === "D"),
    { seat: "D", total: 10, colour: "#ffd43f", label: "Total: 10" },
  );
  assert.equal(
    felt.hand_totals.some((hand) => hand.seat === "7"),
    false,
  );
});

test("hand totals use blackjack values: soft ace, 21 cyan-blue, ≥17 green, bust red", () => {
  const twentyOne = projectFeltTable([
    shoe(),
    observed("A", "1"),
    observed("K", "1"),
  ]);
  assert.deepEqual(twentyOne.hand_totals, [
    { seat: "1", total: 21, colour: "rgb(0 255 245)", label: "Total: 21" },
  ]);

  const seventeen = projectFeltTable([
    shoe(),
    observed("K", "1"),
    observed("7", "1"),
  ]);
  assert.deepEqual(seventeen.hand_totals, [
    { seat: "1", total: 17, colour: "#22c55e", label: "Total: 17" },
  ]);

  const bust = projectFeltTable([
    shoe(),
    observed("K", "1"),
    observed("K", "1"),
    observed("5", "1"),
  ]);
  assert.deepEqual(bust.hand_totals, [
    { seat: "1", total: 25, colour: "#ef4444", label: "Total: 25" },
  ]);

  // A+6+6: 11+6+6 busts the soft ace, total is 13 (not 23, not a hard 18).
  const softReduced = projectFeltTable([
    shoe(),
    observed("A", "3"),
    observed("6", "3"),
    observed("6", "3"),
  ]);
  assert.deepEqual(softReduced.hand_totals, [
    { seat: "3", total: 13, colour: "#ffd43f", label: "Total: 13" },
  ]);
  assert.deepEqual(
    softReduced.seat_piles.find((pile) => pile.seat === "3")?.cards,
    [
      { rank: "A", suit: null },
      { rank: "6", suit: null },
      { rank: "6", suit: null },
    ],
  );
});

test("GWT counts_after_observe: five updates P/D/RA and the count grid from slice-1 maps", () => {
  const bar = projectCountsInfoBar([shoe(), observed("5", "1")]);
  const total = DECKS * CARDS_PER_DECK;
  const remaining = total - 1;
  const decksLeft = remaining / CARDS_PER_DECK;
  const acesLeft = DECKS * 4;

  assert.equal(bar.decksLeft, Math.max(decksLeft, 0.01));
  assert.equal(bar.acesLeft, acesLeft);
  assert.equal(bar.penetration, `P: ${((1 - remaining / total) * 100).toFixed(2)}%`);
  assert.equal(bar.penetration, "P: 0.24%");
  assert.notEqual(bar.penetration, "P: 0.00%");
  assert.equal(bar.decks_left, `D: ${bar.decksLeft.toFixed(2)}`);
  assert.equal(bar.decks_left, "D: 7.98");

  assert.equal(bar.ra.numeric, bar.acesLeft / (32 * bar.decksLeft) - 1);
  assert.notEqual(bar.ra.numeric, bar.acesLeft / (4 * bar.decksLeft) - 1);
  assert.equal(bar.ra.value, fixed2(bar.ra.numeric));
  assert.equal(bar.ra.value, "-0.87");
  assert.equal(bar.ra.colour, "#ef4444");
  assert.equal(bar.ra.className, "negative");
  assert.equal(bar.ra.label, "RA:");

  assert.equal(COUNT_MAPS.APC["5"], 3);
  assert.notEqual(COUNT_MAPS.APC["5"], 2);
  assert.equal(COUNT_MAPS.OmegaII["5"], 2);
  assert.equal(bar.hilo_rc, COUNT_MAPS.HiLo["5"]);
  assert.equal(bar.hilo_rc, 1);
  const tc = (rc: number) => (bar.decksLeft > 0.01 ? rc / bar.decksLeft : 0);
  assert.equal(bar.hilo_tc, fixed2(tc(COUNT_MAPS.HiLo["5"])));
  assert.equal(bar.hilo_tc, "0.13");
  assert.equal(bar.hilo_display, `Hi-Lo: ${bar.hilo_rc} / ${bar.hilo_tc}`);
  assert.equal(bar.apc_tc, `APC: ${fixed2(tc(COUNT_MAPS.APC["5"]))}`);
  assert.equal(bar.apc_tc, "APC: 0.38");
  assert.equal(bar.zen_tc, `Zen: ${fixed2(tc(COUNT_MAPS.Zen["5"]))}`);
  assert.equal(bar.zen_tc, "Zen: 0.25");
  assert.equal(bar.omega_ii_tc, `Omega II: ${fixed2(tc(COUNT_MAPS.OmegaII["5"]))}`);
  assert.equal(bar.omega_ii_tc, "Omega II: 0.25");
  assert.notEqual(bar.omega_ii_tc, "Omega II: 0.38");
  assert.equal(bar.ace_tc, `Ace: ${(bar.acesLeft / bar.decksLeft - 4).toFixed(2)}`);
  assert.equal(bar.ace_tc, "Ace: 0.01");
  assert.notEqual(bar.ace_tc, "Ace: +0.01");
  assert.notEqual(bar.ace_tc, bar.ra.value);

  const dumped = JSON.stringify(bar);
  assert.equal(dumped.includes("RoR"), false);
  assert.equal(dumped.includes("Wong"), false);
  assert.equal(dumped.includes("sidebet"), false);
});

test("GWT counts_after_observe ace: ace excess vs 4 per deck; RA uses aces left; Omega II ace is 0", () => {
  const bar = projectCountsInfoBar([shoe(), observed("A", "D")]);
  const decksLeft = (DECKS * CARDS_PER_DECK - 1) / CARDS_PER_DECK;

  assert.equal(bar.acesLeft, 31);
  assert.equal(bar.decksLeft, Math.max(decksLeft, 0.01));
  assert.equal(bar.ra.numeric, 31 / (32 * bar.decksLeft) - 1);
  assert.notEqual(bar.ra.numeric, bar.acesLeft / (4 * bar.decksLeft) - 1);
  assert.equal(bar.ra.value, "-0.88");

  assert.equal(COUNT_MAPS.OmegaII.A, 0);
  assert.notEqual(COUNT_MAPS.OmegaII.A, -2);
  assert.equal(COUNT_MAPS.APC.A, 0);
  assert.equal(COUNT_MAPS.HiLo.A, -1);
  assert.equal(bar.hilo_rc, -1);
  const tc = (rc: number) => rc / bar.decksLeft;
  assert.equal(bar.hilo_tc, fixed2(tc(-1)));
  assert.equal(bar.hilo_display, "Hi-Lo: -1 / -0.13");
  assert.equal(bar.apc_tc, "APC: 0.00");
  assert.equal(bar.zen_tc, `Zen: ${fixed2(tc(COUNT_MAPS.Zen.A))}`);
  assert.equal(bar.zen_tc, `Zen: ${fixed2(tc(-1))}`);
  assert.equal(bar.omega_ii_tc, "Omega II: 0.00");
  assert.notEqual(bar.omega_ii_tc, "Omega II: -0.25");
  assert.equal(bar.ace_tc, `Ace: ${fixed2(bar.acesLeft / bar.decksLeft - 4)}`);
  assert.equal(bar.ace_tc, "Ace: -0.12");
  assert.notEqual(bar.ace_tc, `Ace: ${fixed2(tc(-1))}`);
  assert.notEqual(bar.ace_tc, bar.omega_ii_tc);
  assert.notEqual(bar.ace_tc, bar.ra.value);
});

test("GWT remaining_after_observe: that rank decrements; suit pie unchanged", () => {
  const full = projectRemainingComposition([shoe()]);
  const remaining = projectRemainingComposition([
    shoe(),
    observed("5", "1"),
    observed("K", "D"),
  ]);

  assert.equal(
    remaining.remaining_by_rank.find((slice) => slice.rank === "5")?.count,
    31,
  );
  assert.equal(
    remaining.remaining_by_rank.find((slice) => slice.rank === "K")?.count,
    31,
  );
  for (const rank of RANKS) {
    if (rank === "5" || rank === "K") continue;
    assert.equal(
      remaining.remaining_by_rank.find((slice) => slice.rank === rank)?.count,
      32,
    );
  }
  // K is not a ten. Ten-value faces stay distinct in the shoe.
  assert.equal(
    remaining.remaining_by_rank.find((slice) => slice.rank === "10")?.count,
    32,
  );
  assert.deepEqual(remaining.remaining_by_rank.map((slice) => slice.rank), [
    ...RANKS,
  ]);
  assert.deepEqual(remaining.remaining_by_suit, full.remaining_by_suit);
  assert.deepEqual(
    remaining.remaining_by_suit.map((slice) => slice.count),
    SUIT_DRAW.map(() => 104),
  );
  assert.deepEqual(
    remaining.remaining_by_rank_suit,
    full.remaining_by_rank_suit,
  );
  assert.deepEqual(remaining.outer_rank_ring, full.outer_rank_ring);
  assert.deepEqual(remaining.inner_suit_pie, full.inner_suit_pie);
  assert.equal(
    remaining.tooltip.format.replace("{label}", "5").replace("{value}", "31"),
    "5: 31",
  );
  assert.equal(
    remaining.tooltip.format.replace("{label}", "♠").replace("{value}", "104"),
    "♠: 104",
  );
});

test("hand_completed clears felt piles only; counts and remaining keep the observed card", () => {
  const seen: DomainEvent[] = [shoe(), observed("5", "1"), { type: "hand_completed" }];
  const live: DomainEvent[] = [shoe(), observed("5", "1")];

  const felt = projectFeltTable(seen);
  assert.deepEqual(
    felt.seat_piles.map((pile) => pile.cards),
    SEATS.map(() => []),
  );
  assert.deepEqual(felt.hand_totals, []);
  assert.equal(felt.seat_order, "D,7,6,5,4,3,2,1");
  assert.deepEqual(projectCountsInfoBar(seen), projectCountsInfoBar(live));
  assert.deepEqual(
    projectRemainingComposition(seen),
    projectRemainingComposition(live),
  );
});
