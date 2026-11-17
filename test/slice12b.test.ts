import assert from "node:assert/strict";
import test from "node:test";
import {
  SPLIT_HAND_PATH,
  WITHDRAW_CARD_PATH,
  handleHttp,
  type HttpRequest,
  type HttpResponse,
} from "../src/http/handle.ts";
import { projectFeltTable } from "../src/read/felt-table.ts";
import { createNewShoeShell } from "../src/ui/new-shoe-shell.ts";
import { completeHand } from "../src/write/complete-hand.ts";
import type { Seat } from "../src/write/events.ts";
import {
  TABLE_STREAM,
  createInMemoryEventStore,
} from "../src/write/in-memory-store.ts";
import { observeCard } from "../src/write/observe-card.ts";
import { setSuit } from "../src/write/set-suit.ts";
import { splitHand } from "../src/write/split-hand.ts";
import { startShoe } from "../src/write/start-shoe.ts";

/**
 * Slice 12 v2 — split rules v2 (live_page_not_proven_12b, 03) and the post-split
 * Backspace rule (focus_sources_for_withdraw source 4, live_page_not_proven_13).
 * Each GWT names its HCL scenario.
 */

function wired() {
  const store = createInMemoryEventStore();
  const calls: HttpRequest[] = [];
  const handle = (request: HttpRequest): HttpResponse => {
    calls.push(request);
    return handleHttp(store, request);
  };
  const shell = createNewShoeShell(handle, () => true);
  return { store, calls, shell };
}

function facts(store: ReturnType<typeof createInMemoryEventStore>) {
  return store.read(TABLE_STREAM).map(({ position: _position, ...fact }) => fact);
}

test("GWT split_hand_after_next_hand: a card last hand does not count; K♥ K♠ split", () => {
  const store = createInMemoryEventStore();
  startShoe(store, { decks: 8 });
  observeCard(store, { rank: "5", seat: "1" });
  setSuit(store, { suit: "hearts", seat: "1" });
  completeHand(store);
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "hearts", seat: "1" });
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "spades", seat: "1" });

  const ack = splitHand(store, { seat: "1" });
  assert.deepEqual(
    ack.events.map(({ position: _position, ...fact }) => fact),
    [{ type: "hand_split", seat: "1" }],
  );
  // felt_table_split_after_next_hand (04): only this hand's pair moves to A/B.
  const felt = projectFeltTable(store.read(TABLE_STREAM));
  assert.deepEqual(
    felt.split_piles.map((pile) => [pile.seat, pile.hand, pile.cards.map((card) => `${card.rank}${card.suit}`)]),
    [
      ["1", "A", ["Khearts"]],
      ["1", "B", ["Kspades"]],
    ],
  );
});

test("GWT split_hand_already_split_rejected and split_hand_resplit_pile_rejected", () => {
  const store = createInMemoryEventStore();
  startShoe(store, { decks: 8 });
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "hearts", seat: "1" });
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "spades", seat: "1" });
  splitHand(store, { seat: "1" });
  observeCard(store, { rank: "K", seat: "1A" });
  setSuit(store, { suit: "diamonds", seat: "1A" });
  const before = facts(store);

  assert.throws(() => splitHand(store, { seat: "1" }), /already split/);
  // Untyped caller: a pile key is never a split target.
  assert.throws(() => splitHand(store, { seat: "1A" as Seat }), /cannot be split again/);
  assert.deepEqual(facts(store), before);
  assert.deepEqual(projectFeltTable(store.read(TABLE_STREAM)).screen.split_ready_seats, []);
});

test("GWT felt_split on seat 4: SPLIT shows only on seat 4, posts seat 4, focus 4A", () => {
  const { store, calls, shell } = wired();
  shell.pressNewShoe();
  shell.pressSeat("4");
  shell.pressRank("10");
  shell.pressSuit("hearts");
  shell.pressSeat("4");
  shell.pressRank("K");
  shell.pressSuit("spades");
  shell.pressSeat("D");
  shell.pressRank("8");
  shell.pressSeat("D");
  shell.pressRank("8");
  const html = shell.html();
  assert.equal(html.includes('id="splitBtn-4"'), true);
  assert.equal(html.includes('id="splitBtn-D"'), false);
  assert.equal(html.includes('id="splitBtn-1"'), false);
  assert.equal(html.match(/class="split-btn"/g)?.length, 1);
  assert.equal(shell.pressSplit("D").rejected, true);
  assert.equal(shell.pressSplit("1").rejected, true);

  calls.length = 0;
  const pressed = shell.pressSplit("4");
  assert.equal(pressed.rejected, false);
  assert.deepEqual(calls[0], { method: "POST", path: SPLIT_HAND_PATH, body: { seat: "4" } });
  assert.equal(shell.focusKey(), "4A");
  assert.deepEqual(facts(store).at(-1), { type: "hand_split", seat: "4" });
  assert.match(shell.html(), /id="hand-4A"><div class="hand-total"[^>]*>Total: 10<\/div>/);
  assert.equal(shell.html().includes("splitBtn-4"), false);
});

test("GWT post_split_backspace_withdraws_a: SPLIT then Backspace with no click withdraws A's card", () => {
  const { store, calls, shell } = wired();
  shell.pressNewShoe();
  shell.pressSeat("1");
  shell.pressRank("K");
  shell.pressSuit("hearts");
  shell.advanceFocus();
  shell.pressSeat("1");
  shell.pressRank("K");
  shell.pressSuit("spades");
  shell.advanceFocus();
  assert.equal(shell.pressSplit("1").rejected, false);
  assert.equal(shell.focusKey(), "1A");

  calls.length = 0;
  const withdrawn = shell.pressWithdraw();
  assert.equal(withdrawn.rejected, false);
  // On 286031f this posted {rank: K, seat: 1B} (observation provenance).
  assert.deepEqual(calls[0], {
    method: "POST",
    path: WITHDRAW_CARD_PATH,
    body: { rank: "K", seat: "1A" },
  });
  assert.deepEqual(facts(store).at(-1), { type: "card_withdrawn", rank: "K", seat: "1A" });
  assert.equal(shell.focusKey(), "1A");
  const felt = projectFeltTable(store.read(TABLE_STREAM));
  assert.deepEqual(
    felt.split_piles.map((pile) => [pile.hand, pile.cards.map((card) => `${card.rank}${card.suit}`)]),
    [
      ["A", []],
      ["B", ["Kspades"]],
    ],
  );

  // Manual focus on an emptied pile: a second Backspace does nothing.
  calls.length = 0;
  assert.equal(shell.pressWithdraw().rejected, true);
  assert.deepEqual(calls, []);
});
