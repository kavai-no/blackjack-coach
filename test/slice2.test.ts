import assert from "node:assert/strict";
import test from "node:test";
import { RANKS, SUITS } from "../src/counting/maps.ts";
import { projectCountsInfoBar } from "../src/read/counts-info-bar.ts";
import { projectFeltTable } from "../src/read/felt-table.ts";
import { projectRemainingComposition } from "../src/read/remaining-composition.ts";
import {
  TABLE_STREAM,
  createInMemoryEventStore,
  type DomainEvent,
} from "../src/write/in-memory-store.ts";
import { startShoe } from "../src/write/start-shoe.ts";

const DECKS = 8;
const SEATS = ["D", "7", "6", "5", "4", "3", "2", "1"] as const;
const RANK_COLOURS = [
  "#ef4444",
  "#f97316",
  "#facc15",
  "#a3e635",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#6366f1",
  "#1e40af",
  "#dc2626",
  "#991b1b",
];
/** Donut draw order — not `state.js` storage order. */
const SUIT_DRAW = ["spades", "clubs", "hearts", "diamonds"] as const;

function payloads(
  events: readonly { type: string; decks?: number }[],
): DomainEvent[] {
  return events.map((event) => {
    if (event.type === "shoe_started") {
      const shoe = event as { type: "shoe_started"; decks: number };
      return { type: "shoe_started", decks: shoe.decks };
    }
    return { type: "hand_completed" };
  });
}

test("GWT start_shoe_first_of_session: empty store → shoe_started only", () => {
  const store = createInMemoryEventStore();

  const result = startShoe(store, { decks: DECKS });

  assert.equal(result.ack, true);
  assert.deepEqual(Object.keys(result).sort(), ["ack", "events", "position"]);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["shoe_started"],
  );
  assert.equal(result.events[0]?.type, "shoe_started");
  if (result.events[0]?.type === "shoe_started") {
    assert.equal(result.events[0].decks, DECKS);
  }
  assert.equal(result.position, 1);
  assert.equal(result.events[0]?.position, 1);
  assert.equal(result.position, result.events.at(-1)?.position);
  assert.equal(
    result.events.some((event) => event.type === "hand_completed"),
    false,
  );

  const stored = store.read(TABLE_STREAM);
  assert.deepEqual(
    stored.map((event) => event.type),
    ["shoe_started"],
  );
  assert.equal("seat_piles" in result, false);
  assert.equal("penetration" in result, false);
  assert.equal("remaining_by_rank" in result, false);
  assert.equal("ra" in result, false);
});

test("GWT start_shoe_mid_shoe_reshuffle: prior shoe → hand_completed then shoe_started", () => {
  const store = createInMemoryEventStore();
  store.append(TABLE_STREAM, [{ type: "shoe_started", decks: DECKS }]);

  const result = startShoe(store, { decks: DECKS });

  assert.equal(result.ack, true);
  assert.deepEqual(Object.keys(result).sort(), ["ack", "events", "position"]);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["hand_completed", "shoe_started"],
  );
  assert.equal(result.events[0]?.type, "hand_completed");
  assert.equal(result.events[1]?.type, "shoe_started");
  if (result.events[1]?.type === "shoe_started") {
    assert.equal(result.events[1].decks, DECKS);
  }
  assert.deepEqual(
    result.events.map((event) => event.position),
    [2, 3],
  );
  assert.equal(result.position, 3);

  const stored = store.read(TABLE_STREAM);
  assert.deepEqual(
    stored.map((event) => event.type),
    ["shoe_started", "hand_completed", "shoe_started"],
  );
  assert.equal("hand_totals" in result, false);
  assert.equal("remaining_by_suit" in result, false);
});

test("GWT empty shoe: Felt table piles empty, seat order D,7..1, focus seat 1", () => {
  const felt = projectFeltTable([{ type: "shoe_started", decks: DECKS }]);

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
  assert.equal("disabled_seats" in felt, false);
  assert.equal("disabled_seats" in felt.screen, false);
});

test("GWT empty shoe: Counts / info bar resets P/D/RA and live counts; no RoR/Wong/side bets", () => {
  const bar = projectCountsInfoBar([{ type: "shoe_started", decks: DECKS }]);

  assert.equal(
    bar.layout_order,
    "row1: P, D, RA; row2 grid: Hi-Lo RC/TC, APC TC, Zen TC, Omega II TC, Ace TC",
  );
  assert.equal(bar.penetration, "P: 0.00%");
  assert.equal(bar.decks_left, "D: 8.00");
  assert.equal(bar.decksLeft, 8);
  assert.equal(bar.acesLeft, 32);
  assert.equal(bar.ra.numeric, bar.acesLeft / (32 * bar.decksLeft) - 1);
  assert.equal(bar.ra.numeric, -0.875);
  assert.notEqual(bar.ra.numeric, bar.acesLeft / (4 * bar.decksLeft) - 1);
  assert.equal(bar.ra.label, "RA:");
  assert.equal(bar.ra.value, "-0.88");
  assert.equal(bar.ra.colour, "#ef4444");
  assert.equal(bar.ra.className, "negative");
  assert.equal(bar.hilo_rc, 0);
  assert.equal(bar.hilo_tc, "+0.00");
  assert.equal(bar.hilo_display, "Hi-Lo: 0 / +0.00");
  assert.equal(bar.apc_tc, "APC: +0.00");
  assert.equal(bar.zen_tc, "Zen: +0.00");
  assert.equal(bar.omega_ii_tc, "Omega II: +0.00");
  assert.equal(bar.ace_tc, "Ace: 0.00");
  assert.notEqual(bar.ace_tc, bar.ra.value);
  assert.deepEqual(bar.panel_chrome, {
    id: "#infoBar",
    bg: "linear-gradient(#1e293b,#161b22)",
    padding: "12px",
    radius: "10px",
    font: "0.85rem",
    info_top: "flex space-evenly",
    counts_grid: "3-col center",
  });
  const dumped = JSON.stringify(bar);
  assert.equal(dumped.includes("RoR"), false);
  assert.equal(dumped.includes("Wong"), false);
  assert.equal(dumped.includes("sidebet"), false);
  assert.equal(dumped.includes("21+3"), false);
});

test("GWT empty shoe: Remaining composition is a full 8-deck rank×suit donut", () => {
  const remaining = projectRemainingComposition([
    { type: "shoe_started", decks: DECKS },
  ]);

  assert.deepEqual(
    remaining.remaining_by_rank.map((slice) => slice.rank),
    [...RANKS],
  );
  assert.deepEqual(
    remaining.remaining_by_rank.map((slice) => slice.count),
    RANKS.map(() => 32),
  );
  assert.deepEqual(
    remaining.remaining_by_suit.map((slice) => slice.suit),
    [...SUIT_DRAW],
  );
  assert.deepEqual(
    remaining.remaining_by_suit.map((slice) => slice.count),
    SUIT_DRAW.map(() => 104),
  );
  assert.notDeepEqual(
    remaining.remaining_by_suit.map((slice) => slice.suit),
    [...SUITS],
  );
  assert.equal(remaining.remaining_by_rank_suit.length, 52);
  for (const cell of remaining.remaining_by_rank_suit) {
    assert.equal(cell.count, DECKS);
  }
  assert.deepEqual(remaining.remaining_by_rank_suit[0], {
    rank: "A",
    suit: "spades",
    count: 8,
  });
  assert.deepEqual(remaining.outer_rank_ring, {
    order: "A,2,3,4,5,6,7,8,9,10,J,Q,K",
    label: "slice label = remaining count",
    colours: RANK_COLOURS,
    geometry: "donut ring: outerRadius≈0.8·half, innerRadiusBase≈0.5·outer",
  });
  assert.deepEqual(remaining.inner_suit_pie, {
    draw_order: "spades, clubs, hearts, diamonds",
    symbols: ["♠", "♣", "♥", "♦"],
    colours: ["#000", "#006400", "#dc2626", "#00008b"],
    geometry: "pie from center to innerRadiusBase; label = suit symbol",
  });
  assert.equal(remaining.tooltip.format, "{label}: {value}");
  assert.equal(remaining.tooltip.on, "hover rank or suit slice");
  assert.equal(remaining.tooltip.style, "dark rgba tooltip .d3-tooltip");
  assert.equal(
    remaining.tooltip.format.replace("{label}", "A").replace("{value}", "32"),
    "A: 32",
  );
  assert.equal(
    remaining.tooltip.format
      .replace("{label}", "♠")
      .replace("{value}", "104"),
    "♠: 104",
  );
  assert.deepEqual(remaining.chart_host, {
    id: "#combinedChart",
    note: "D3 render is implement detail; ResizeObserver re-renders on size change",
  });
});

test("GWT shoe reset: mid-shoe start_shoe projects the same three empty-shoe views", () => {
  const store = createInMemoryEventStore();
  store.append(TABLE_STREAM, [{ type: "shoe_started", decks: DECKS }]);
  const result = startShoe(store, { decks: DECKS });
  const events = payloads(store.read(TABLE_STREAM));
  const fresh: DomainEvent[] = [{ type: "shoe_started", decks: DECKS }];

  assert.deepEqual(
    result.events.map((event) => event.type),
    ["hand_completed", "shoe_started"],
  );
  assert.deepEqual(projectFeltTable(events), projectFeltTable(fresh));
  assert.deepEqual(projectCountsInfoBar(events), projectCountsInfoBar(fresh));
  assert.deepEqual(
    projectRemainingComposition(events),
    projectRemainingComposition(fresh),
  );
});

test("GWT hand_completed keeps counts and remaining; felt stays empty", () => {
  const shoe: DomainEvent[] = [{ type: "shoe_started", decks: DECKS }];
  const afterHand: DomainEvent[] = [
    { type: "shoe_started", decks: DECKS },
    { type: "hand_completed" },
  ];

  assert.deepEqual(projectCountsInfoBar(afterHand), projectCountsInfoBar(shoe));
  assert.deepEqual(
    projectRemainingComposition(afterHand),
    projectRemainingComposition(shoe),
  );
  const felt = projectFeltTable(afterHand);
  assert.deepEqual(felt.hand_totals, []);
  assert.deepEqual(
    felt.seat_piles.map((pile) => pile.cards),
    SEATS.map(() => []),
  );
  assert.equal(felt.seat_order, "D,7,6,5,4,3,2,1");
  assert.equal(felt.screen.focus_seat, "1");
});
