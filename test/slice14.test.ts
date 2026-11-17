import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseHTML } from "linkedom";
import {
  COMPLETE_HAND_PATH,
  COUNTS_PATH,
  FELT_PATH,
  OBSERVE_CARD_PATH,
  REMAINING_PATH,
  SET_SUIT_PATH,
  SPLIT_HAND_PATH,
  START_SHOE_PATH,
  handleHttp,
  type HttpRequest,
  type HttpResponse,
} from "../src/http/handle.ts";
import { projectCountsInfoBar } from "../src/read/counts-info-bar.ts";
import { projectFeltTable } from "../src/read/felt-table.ts";
import { projectRemainingComposition } from "../src/read/remaining-composition.ts";
import { mountNewShoePage } from "../src/pages/new-shoe-page.ts";
import { createNewShoeShell } from "../src/ui/new-shoe-shell.ts";
import { completeHand } from "../src/write/complete-hand.ts";
import {
  TABLE_STREAM,
  createInMemoryEventStore,
} from "../src/write/in-memory-store.ts";
import { observeCard } from "../src/write/observe-card.ts";
import { setSuit } from "../src/write/set-suit.ts";
import { splitHand } from "../src/write/split-hand.ts";
import { startShoe } from "../src/write/start-shoe.ts";

const SEATS = ["D", "7", "6", "5", "4", "3", "2", "1"];

function click(node: unknown): void {
  if (
    !node ||
    typeof node !== "object" ||
    !("click" in node) ||
    typeof node.click !== "function"
  ) {
    assert.fail("expected a clickable element");
  }
  node.click();
}

function wired() {
  const store = createInMemoryEventStore();
  const calls: HttpRequest[] = [];
  const handle = (request: HttpRequest): HttpResponse => {
    calls.push(request);
    return handleHttp(store, request);
  };
  const shell = createNewShoeShell(handle, () => true);
  return { store, calls, handle, shell };
}

function ackBody(response: HttpResponse) {
  assert.equal(response.status, 200);
  const body = response.body;
  assert.ok(body && typeof body === "object");
  assert.equal("ack" in body && body.ack, true);
  assert.deepEqual(Object.keys(body).sort(), ["ack", "events", "position"]);
  return body as {
    ack: true;
    events: {
      type: string;
      position: number;
      rank?: string;
      seat?: string;
      suit?: string;
      hand?: string;
      decks?: number;
    }[];
    position: number;
  };
}

function start(handle: (request: HttpRequest) => HttpResponse) {
  const response = handle({
    method: "POST",
    path: START_SHOE_PATH,
    body: { decks: 8 },
  });
  assert.equal(response.status, 200);
}

function observe(
  handle: (request: HttpRequest) => HttpResponse,
  rank: string,
  seat: string,
) {
  const response = handle({
    method: "POST",
    path: OBSERVE_CARD_PATH,
    body: { rank, seat },
  });
  assert.equal(response.status, 200);
}

function suit(
  handle: (request: HttpRequest) => HttpResponse,
  suitName: string,
  seat: string,
) {
  const response = handle({
    method: "POST",
    path: SET_SUIT_PATH,
    body: { suit: suitName, seat },
  });
  assert.equal(response.status, 200);
}

test("POST /commands/complete-hand has no body and returns ack, events, position only", () => {
  assert.equal(COMPLETE_HAND_PATH, "/commands/complete-hand");
  const store = createInMemoryEventStore();
  const handle = (request: HttpRequest) => handleHttp(store, request);
  start(handle);
  observe(handle, "K", "1");
  suit(handle, "spades", "1");
  observe(handle, "K", "1");
  suit(handle, "diamonds", "1");
  assert.equal(
    handle({ method: "POST", path: SPLIT_HAND_PATH, body: { seat: "1" } }).status,
    200,
  );
  observe(handle, "6", "D");
  suit(handle, "hearts", "D");

  const before = store.read(TABLE_STREAM);
  const countsBefore = projectCountsInfoBar(before);
  const remainingBefore = projectRemainingComposition(before);
  const dealt = projectFeltTable(before);
  assert.equal(dealt.split_piles.length, 2);
  assert.ok(dealt.hand_totals.length > 0);
  assert.equal(countsBefore.acesLeft, 32);
  assert.equal(countsBefore.hilo_rc, -1);
  assert.notEqual(
    countsBefore.ra.numeric,
    countsBefore.acesLeft / (4 * countsBefore.decksLeft) - 1,
  );
  assert.equal(
    remainingBefore.remaining_by_rank.find((slice) => slice.rank === "K")?.count,
    30,
  );
  assert.equal(
    remainingBefore.remaining_by_rank.find((slice) => slice.rank === "6")?.count,
    31,
  );
  assert.equal(
    remainingBefore.remaining_by_suit.find((slice) => slice.suit === "hearts")?.count,
    103,
  );
  assert.equal(
    remainingBefore.remaining_by_suit.find((slice) => slice.suit === "spades")?.count,
    103,
  );
  assert.equal(
    remainingBefore.remaining_by_suit.find((slice) => slice.suit === "diamonds")?.count,
    103,
  );

  const response = handle({ method: "POST", path: COMPLETE_HAND_PATH });
  const body = ackBody(response);
  assert.equal(body.events.length, 1);
  assert.equal(body.position, 9);
  assert.equal(body.position, body.events[0]?.position);
  const event = body.events[0];
  assert.ok(event);
  assert.equal(event.type, "hand_completed");
  assert.deepEqual(Object.keys(event).sort(), ["position", "type"]);
  assert.equal("rank" in event, false);
  assert.equal("seat" in event, false);
  assert.equal("suit" in event, false);
  assert.equal("hand" in event, false);
  assert.equal("decks" in event, false);

  const events = store.read(TABLE_STREAM);
  assert.deepEqual(
    events.map((item) => item.type),
    [
      "shoe_started",
      "card_observed",
      "card_suit_set",
      "card_observed",
      "card_suit_set",
      "hand_split",
      "card_observed",
      "card_suit_set",
      "hand_completed",
    ],
  );
  const felt = handle({ method: "GET", path: FELT_PATH });
  const counts = handle({ method: "GET", path: COUNTS_PATH });
  const remaining = handle({ method: "GET", path: REMAINING_PATH });
  const projected = projectFeltTable(events);
  assert.deepEqual(felt.body, projected);
  assert.deepEqual(counts.body, countsBefore);
  assert.deepEqual(counts.body, projectCountsInfoBar(events));
  assert.deepEqual(remaining.body, remainingBefore);
  assert.deepEqual(remaining.body, projectRemainingComposition(events));

  assert.equal(projected.seat_order, "D,7,6,5,4,3,2,1");
  assert.deepEqual(
    projected.seat_piles.map((pile) => pile.seat),
    SEATS,
  );
  for (const pile of projected.seat_piles) {
    assert.deepEqual(pile.cards, []);
  }
  assert.deepEqual(projected.split_piles, []);
  assert.deepEqual(projected.hand_totals, []);
  assert.equal(projected.screen.focus_seat, "1");
  assert.equal(projected.screen.hero_seat, "1");
  assert.equal(projected.screen.split_button_visible, false);
  assert.equal(projected.screen.next_hand, "complete_hand");

  const again = ackBody(handle({ method: "POST", path: COMPLETE_HAND_PATH }));
  assert.equal(again.events.length, 1);
  assert.equal(again.events[0]?.type, "hand_completed");
  assert.deepEqual(Object.keys(again.events[0] ?? {}).sort(), ["position", "type"]);
  assert.equal(again.position, 10);
  const twice = store.read(TABLE_STREAM);
  assert.deepEqual(
    twice.map((item) => item.type).slice(-2),
    ["hand_completed", "hand_completed"],
  );
  const still = projectFeltTable(twice);
  for (const pile of still.seat_piles) {
    assert.deepEqual(pile.cards, []);
  }
  assert.deepEqual(still.split_piles, []);
  assert.deepEqual(still.hand_totals, []);
  assert.equal(still.screen.focus_seat, "1");
  assert.equal(still.screen.hero_seat, "1");
  assert.deepEqual(projectCountsInfoBar(twice), countsBefore);
  assert.deepEqual(projectRemainingComposition(twice), remainingBefore);
});

test("POST complete-hand ignores a body, still appends on an empty live shoe, and GET is 404", () => {
  const store = createInMemoryEventStore();
  const handle = (request: HttpRequest) => handleHttp(store, request);
  start(handle);
  const junk = ackBody(
    handle({
      method: "POST",
      path: COMPLETE_HAND_PATH,
      body: { rank: "K", seat: "D", suit: "hearts", hand: "A", decks: 1 },
    }),
  );
  assert.equal(junk.events[0]?.type, "hand_completed");
  assert.deepEqual(Object.keys(junk.events[0] ?? {}).sort(), ["position", "type"]);
  assert.equal(junk.position, 2);
  assert.equal(
    store.read(TABLE_STREAM).filter((event) => event.type === "hand_completed").length,
    1,
  );

  const bare = createInMemoryEventStore();
  const beforeShoe = ackBody(
    handleHttp(bare, { method: "POST", path: COMPLETE_HAND_PATH }),
  );
  assert.equal(beforeShoe.events[0]?.type, "hand_completed");
  assert.equal(beforeShoe.position, 1);
  assert.deepEqual(
    bare.read(TABLE_STREAM).map((event) => event.type),
    ["hand_completed"],
  );

  const get = handleHttp(store, { method: "GET", path: COMPLETE_HAND_PATH });
  assert.equal(get.status, 404);
  assert.deepEqual(get.body, { error: "not_found" });
});

test("GWT complete_hand_happy: K♠ → K♥, K♠ split on seat 1; NEXT HAND clears split piles and keeps the shoe; a second press still posts", () => {
  const { store, calls, handle, shell } = wired();
  assert.match(shell.html(), /id="nextHandBtn"/);
  assert.match(shell.html(), />NEXT HAND</);
  assert.equal(shell.pressNextHand().rejected, true);
  assert.equal(calls.length, 0);

  shell.pressNewShoe();
  calls.length = 0;
  const empty = shell.pressNextHand();
  assert.equal(empty.rejected, false);
  if (empty.rejected) return;
  assert.deepEqual(calls[0], { method: "POST", path: COMPLETE_HAND_PATH });
  assert.equal(ackBody(empty.post).events[0]?.type, "hand_completed");
  calls.length = 0;

  // Exact Given of complete_hand_happy (03): K♠ corrected to K♥, then K♠, split seat 1.
  shell.pressRank("K");
  shell.pressSuit("spades");
  shell.pressSuit("hearts");
  shell.pressRank("K");
  shell.pressSuit("spades");
  const split = shell.pressSplit();
  assert.equal(split.rejected, false);
  const dealt = store.read(TABLE_STREAM);
  assert.deepEqual(
    dealt.slice(-6).map(({ position: _position, ...fact }) => fact),
    [
      { type: "card_observed", rank: "K", seat: "1" },
      { type: "card_suit_set", suit: "spades", seat: "1" },
      { type: "card_suit_set", suit: "hearts", seat: "1" },
      { type: "card_observed", rank: "K", seat: "1" },
      { type: "card_suit_set", suit: "spades", seat: "1" },
      { type: "hand_split", seat: "1" },
    ],
  );
  const countsBefore = projectCountsInfoBar(dealt);
  const remainingBefore = projectRemainingComposition(dealt);
  const feltBefore = projectFeltTable(dealt);
  assert.deepEqual(
    feltBefore.split_piles.map((pile) => [pile.seat, pile.hand, pile.cards.map((card) => `${card.rank}${card.suit}`)]),
    [
      ["1", "A", ["Khearts"]],
      ["1", "B", ["Kspades"]],
    ],
  );
  assert.equal(countsBefore.penetration, "P: 0.48%");
  assert.equal(countsBefore.hilo_display, "Hi-Lo: -2 / -0.25");
  assert.match(shell.html(), /id="split-1"/);
  calls.length = 0;

  const pressed = shell.pressNextHand();
  assert.equal(pressed.rejected, false);
  if (pressed.rejected) return;
  assert.deepEqual(
    calls.map((call) => [call.method, call.path]),
    [
      ["POST", "/commands/complete-hand"],
      ["GET", "/views/felt"],
      ["GET", "/views/counts"],
      ["GET", "/views/remaining"],
    ],
  );
  assert.equal("body" in (calls[0] ?? {}), false);
  const post = ackBody(pressed.post);
  assert.equal(post.events.length, 1);
  assert.equal(post.events[0]?.type, "hand_completed");
  assert.deepEqual(Object.keys(post.events[0] ?? {}).sort(), ["position", "type"]);

  const events = store.read(TABLE_STREAM);
  const felt = projectFeltTable(events);
  const counts = projectCountsInfoBar(events);
  const remaining = projectRemainingComposition(events);
  assert.deepEqual(counts, countsBefore);
  assert.deepEqual(remaining, remainingBefore);
  assert.equal(counts.hilo_rc, countsBefore.hilo_rc);
  assert.equal(counts.acesLeft, 32);
  assert.notEqual(counts.ra.numeric, counts.acesLeft / (4 * counts.decksLeft) - 1);
  assert.equal(felt.seat_order, "D,7,6,5,4,3,2,1");
  assert.deepEqual(
    felt.seat_piles.map((pile) => pile.seat),
    SEATS,
  );
  for (const pile of felt.seat_piles) {
    assert.deepEqual(pile.cards, []);
  }
  assert.deepEqual(felt.split_piles, []);
  assert.deepEqual(felt.hand_totals, []);
  assert.equal(felt.screen.focus_seat, "1");
  assert.equal(felt.screen.hero_seat, "1");
  assert.equal(
    remaining.remaining_by_suit.find((slice) => slice.suit === "hearts")?.count,
    103,
  );
  assert.equal(
    remaining.remaining_by_rank.find((slice) => slice.rank === "K")?.count,
    30,
  );

  const html = pressed.html;
  assert.equal(shell.html(), html);
  assert.deepEqual(
    [...html.matchAll(/data-seat="([^"]+)"/g)].map((match) => match[1]),
    SEATS,
  );
  assert.match(
    html,
    /<section class="seat" data-seat="1"><div class="seat-round active your-seat">1<\/div><div class="hand" id="hand-1"><\/div><\/section>/,
  );
  for (const seat of SEATS) {
    if (seat === "1") continue;
    assert.match(
      html,
      new RegExp(
        `<section class="seat" data-seat="${seat}"><div class="seat-round">${seat}</div><div class="hand" id="hand-${seat}"><\\/div><\\/section>`,
      ),
    );
  }
  assert.equal(html.match(/seat-round active/g)?.length, 1);
  assert.equal(html.match(/your-seat/g)?.length, 1);
  assert.equal(html.includes("split-container"), false);
  assert.equal(html.includes("splitBtn"), false);
  assert.equal(html.includes("hand-1A"), false);
  assert.equal(html.includes("display:none"), false);
  assert.equal(html.includes("K♠"), false);
  assert.equal(html.includes("6♥"), false);
  assert.equal(html.includes("Total:"), false);
  assert.match(html, /id="nextHandBtn"/);
  for (const text of [
    counts.penetration,
    counts.decks_left,
    `${counts.ra.label} ${counts.ra.value}`,
    counts.hilo_display,
    counts.apc_tc,
    counts.zen_tc,
    counts.omega_ii_tc,
    counts.ace_tc,
  ]) {
    assert.equal(html.includes(text), true, text);
  }
  const json = html.match(
    /<script type="application\/json" id="combinedChart-data">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(json);
  assert.deepEqual(JSON.parse(json), remainingBefore);
  assert.equal(
    /RoR|Wong|21\+3|Perfect Pair|sidebet|SURRENDER|Expert/i.test(html),
    false,
  );

  calls.length = 0;
  const second = shell.pressNextHand();
  assert.equal(second.rejected, false);
  if (second.rejected) return;
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.path, COMPLETE_HAND_PATH);
  assert.equal("body" in (calls[0] ?? {}), false);
  assert.equal(ackBody(second.post).events[0]?.type, "hand_completed");
  assert.equal(
    store.read(TABLE_STREAM).filter((event) => event.type === "hand_completed").length,
    3,
  );
  assert.deepEqual(projectCountsInfoBar(store.read(TABLE_STREAM)), countsBefore);
  assert.deepEqual(projectRemainingComposition(store.read(TABLE_STREAM)), remainingBefore);

  calls.length = 0;
  assert.equal(shell.pressWithdraw().rejected, true);
  assert.equal(shell.pressSuit("hearts").rejected, true);
  assert.equal(shell.pressSplit().rejected, true);
  assert.equal(calls.length, 0);

  calls.length = 0;
  const nextCard = shell.pressRank("5");
  assert.equal(nextCard.rejected, false);
  if (nextCard.rejected) return;
  assert.deepEqual(calls[0]?.body, { rank: "5", seat: "1" });
  const continued = projectFeltTable(store.read(TABLE_STREAM));
  assert.deepEqual(continued.seat_piles.find((pile) => pile.seat === "1")?.cards, [
    { rank: "5", suit: null },
  ]);
  assert.deepEqual(continued.split_piles, []);
  assert.equal(continued.screen.focus_seat, "1");
  assert.equal(continued.screen.hero_seat, "1");
  const continuedCounts = projectCountsInfoBar(store.read(TABLE_STREAM));
  assert.equal(continuedCounts.acesLeft, countsBefore.acesLeft);
  assert.equal(continuedCounts.hilo_rc, countsBefore.hilo_rc + 1);
  assert.notDeepEqual(continuedCounts, countsBefore);
  assert.equal(
    projectRemainingComposition(store.read(TABLE_STREAM)).remaining_by_rank.find(
      (slice) => slice.rank === "K",
    )?.count,
    30,
  );
});

test("mounted page keeps #nextHandBtn in the topbar and clicks it only through the shell", () => {
  const { document } = parseHTML('<html><body><div id="app"></div></body></html>');
  const seen: string[] = [];
  mountNewShoePage(document, (message) => {
    seen.push(message);
    return true;
  });
  const idle = document.querySelector("#app")?.innerHTML ?? "";
  assert.match(
    idle,
    /<div class="topbar"><button class="btn shuffle" id="shuffleBtn" type="button">NEW SHOE<\/button><button class="btn next-hand" id="nextHandBtn" type="button">NEXT HAND<\/button><\/div>/,
  );
  const next = document.querySelector("#nextHandBtn");
  click(next);
  assert.deepEqual(seen, []);
  assert.equal(document.querySelector("#app")?.innerHTML ?? "", idle);

  const shoe = document.querySelector("#shuffleBtn");
  click(shoe);
  assert.deepEqual(seen, ["Start fresh 8-deck shoe?"]);
  const dealt = document.querySelector("#app")?.innerHTML ?? "";
  assert.match(dealt, /id="nextHandBtn"/);
  assert.match(dealt, /data-seat="1"/);
  click(document.querySelector("#nextHandBtn"));
  const cleared = document.querySelector("#app")?.innerHTML ?? "";
  assert.match(
    cleared,
    /<section class="seat" data-seat="1"><div class="seat-round active your-seat">1<\/div><div class="hand" id="hand-1"><\/div><\/section>/,
  );
  // Layout is the stylesheet's (.hand flex column, original styles.css:38), not a post-paint patch.
  assert.equal(/class="hand"[^>]*style=|style="[^"]*"\s+class="hand"/.test(cleared), false);
  assert.equal(/RoR|Wong|21\+3|Perfect Pair|sidebet|SURRENDER|Expert/i.test(cleared), false);

  const page = readFileSync(new URL("../src/pages/new-shoe-page.ts", import.meta.url), "utf8");
  assert.match(page, /pressNextHand/);
  assert.match(page, /#nextHandBtn/);
  assert.equal(page.includes("completeHand"), false);
  assert.equal(page.includes("/commands/"), false);
  assert.equal(page.includes("node:http"), false);
});

test("complete-hand boundary reuses completeHand and does not clear piles or counts itself", () => {
  const httpSrc = readFileSync(new URL("../src/http/handle.ts", import.meta.url), "utf8");
  const shellSrc = readFileSync(
    new URL("../src/ui/new-shoe-shell.ts", import.meta.url),
    "utf8",
  );
  assert.match(httpSrc, /completeHand\(/);
  assert.match(httpSrc, /projectFeltTable\(/);
  assert.match(httpSrc, /projectCountsInfoBar\(/);
  assert.match(httpSrc, /projectRemainingComposition\(/);
  assert.equal(httpSrc.includes("seat_piles"), false);
  assert.equal(httpSrc.includes("split_piles"), false);
  assert.equal(httpSrc.includes("hand_totals"), false);
  assert.equal(httpSrc.includes("runningAce"), false);
  assert.equal(httpSrc.includes("COUNT_MAPS"), false);
  assert.equal(httpSrc.includes("pickSuit"), false);
  assert.equal(httpSrc.includes("node:http"), false);
  assert.equal(httpSrc.includes("createServer"), false);

  assert.match(shellSrc, /COMPLETE_HAND_PATH/);
  assert.match(shellSrc, /pressNextHand/);
  assert.match(shellSrc, /id="nextHandBtn"/);
  assert.equal(shellSrc.includes("completeHand"), false);
  assert.equal(shellSrc.includes("hand_completed"), false);
  assert.equal(shellSrc.includes("projectFeltTable"), false);
  assert.equal(shellSrc.includes("projectCountsInfoBar"), false);
  assert.equal(shellSrc.includes("projectRemainingComposition"), false);
  assert.equal(shellSrc.includes("runningAce"), false);
  assert.equal(shellSrc.includes("COUNT_MAPS"), false);
  assert.equal(shellSrc.includes("pickSuit"), false);
  assert.equal(shellSrc.includes("settleHand"), false);
  assert.equal(shellSrc.includes("node:http"), false);
  assert.equal(shellSrc.includes("createServer"), false);
});

function remainingRank(
  remaining: ReturnType<typeof projectRemainingComposition>,
  rank: string,
): number | undefined {
  return remaining.remaining_by_rank.find((slice) => slice.rank === rank)?.count;
}

function remainingSuit(
  remaining: ReturnType<typeof projectRemainingComposition>,
  suitName: string,
): number | undefined {
  return remaining.remaining_by_suit.find((slice) => slice.suit === suitName)?.count;
}

test("GWT remaining per-seat cards clear on hand_completed: split seat 1 after NEXT HAND", () => {
  const store = createInMemoryEventStore();
  startShoe(store, { decks: 8 });
  observeCard(store, { rank: "5", seat: "1" });
  setSuit(store, { suit: "hearts", seat: "1" });
  completeHand(store);

  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "hearts", seat: "1" });
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "spades", seat: "1" });
  splitHand(store, { seat: "1" });

  const history = store.read(TABLE_STREAM);
  assert.equal(history.at(-1)?.type, "hand_split");
  const remaining = projectRemainingComposition(history);
  assert.equal(remainingRank(remaining, "5"), 31);
  assert.equal(remainingRank(remaining, "K"), 30);
  assert.equal(remainingSuit(remaining, "hearts"), 102);
  assert.equal(remainingSuit(remaining, "spades"), 103);
  assert.equal(remainingSuit(remaining, "clubs"), 104);
  assert.equal(remainingSuit(remaining, "diamonds"), 104);

  const felt = projectFeltTable(history);
  assert.equal(felt.seat_piles.find((pile) => pile.seat === "1")?.cards.length, 0);
});

test("GWT remaining per-seat cards clear on NEW SHOE mid-shoe: split seat 1 in the fresh shoe", () => {
  const store = createInMemoryEventStore();
  startShoe(store, { decks: 8 });
  observeCard(store, { rank: "5", seat: "1" });
  setSuit(store, { suit: "hearts", seat: "1" });
  startShoe(store, { decks: 8 });
  assert.deepEqual(
    store.read(TABLE_STREAM).slice(-2).map((event) => event.type),
    ["hand_completed", "shoe_started"],
  );

  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "hearts", seat: "1" });
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "spades", seat: "1" });
  splitHand(store, { seat: "1" });

  const remaining = projectRemainingComposition(store.read(TABLE_STREAM));
  assert.equal(remainingRank(remaining, "5"), 32);
  assert.equal(remainingRank(remaining, "K"), 30);
  assert.equal(remainingSuit(remaining, "hearts"), 103);
  assert.equal(remainingSuit(remaining, "spades"), 103);
});

test("GWT remaining counts persist across hand_completed while per-seat cards clear", () => {
  const store = createInMemoryEventStore();
  startShoe(store, { decks: 8 });
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "hearts", seat: "1" });
  observeCard(store, { rank: "7", seat: "1" });
  setSuit(store, { suit: "clubs", seat: "1" });
  observeCard(store, { rank: "A", seat: "D" });
  const before = projectRemainingComposition(store.read(TABLE_STREAM));
  assert.equal(remainingRank(before, "K"), 31);
  assert.equal(remainingRank(before, "7"), 31);
  assert.equal(remainingRank(before, "A"), 31);
  assert.equal(remainingSuit(before, "hearts"), 103);
  assert.equal(remainingSuit(before, "clubs"), 103);

  completeHand(store);
  const after = projectRemainingComposition(store.read(TABLE_STREAM));
  assert.deepEqual(after, before);

  // The old K, 7 on seat 1 are gone from the pile: a fresh K K on seat 1 splits.
  observeCard(store, { rank: "K", seat: "1" });
  observeCard(store, { rank: "K", seat: "1" });
  splitHand(store, { seat: "1" });
  const continued = projectRemainingComposition(store.read(TABLE_STREAM));
  assert.equal(remainingRank(continued, "K"), 29);
  assert.equal(remainingRank(continued, "7"), 31);
  assert.equal(remainingRank(continued, "A"), 31);
  assert.equal(remainingSuit(continued, "hearts"), 103);
  assert.equal(remainingSuit(continued, "clubs"), 103);

  const response = handleHttp(store, { method: "GET", path: REMAINING_PATH });
  assert.equal(response.status, 200);
});

test("GWT G1 felt_next_hand: after NEXT HAND a suit press and Backspace append nothing (shell)", () => {
  const { store, calls, shell } = wired();
  shell.pressNewShoe();
  shell.pressRank("K");
  shell.pressSuit("spades");
  shell.pressSuit("hearts");
  shell.pressRank("K");
  shell.pressSuit("spades");
  assert.equal(shell.pressSplit().rejected, false);
  assert.equal(shell.pressNextHand().rejected, false);
  const cleared = store.read(TABLE_STREAM);
  assert.equal(cleared.at(-1)?.type, "hand_completed");
  const html = shell.html();
  calls.length = 0;

  assert.equal(shell.pressSuit("hearts").rejected, true);
  assert.equal(shell.pressSuit("diamonds").rejected, true);
  assert.equal(shell.pressWithdraw().rejected, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(store.read(TABLE_STREAM), cleared);
  assert.equal(shell.html(), html);
  assert.equal(shell.focusKey(), "1");
});

test("GWT G1 felt_next_hand: mounted page ignores suit key, suit-pad click and Backspace after NEXT HAND", () => {
  const { document } = parseHTML('<html><body><div id="app"></div></body></html>');
  const listeners: ((event: { key?: string; preventDefault?: () => void }) => void)[] = [];
  const host = {
    querySelector: (selector: string) => document.querySelector(selector),
    addEventListener: (
      type: string,
      listener: (event: { key?: string; preventDefault?: () => void }) => void,
    ) => {
      if (type === "keydown") listeners.push(listener);
    },
  };
  const store = mountNewShoePage(host as unknown as Parameters<typeof mountNewShoePage>[0], () => true);
  const key = (value: string) => {
    for (const listener of listeners) listener({ key: value, preventDefault: () => {} });
  };
  assert.equal(listeners.length, 1);
  click(document.querySelector("#shuffleBtn"));
  // Seat 1 header before each rank, top-row '[' then numpad '-' (both K).
  click(document.querySelector('[data-seat="1"] .seat-round'));
  key("[");
  key("x");
  click(document.querySelector('[data-seat="1"] .seat-round'));
  key("-");
  key("s");
  const beforeSplit = store.read(TABLE_STREAM);
  assert.deepEqual(
    beforeSplit.filter((event) => event.type === "card_observed").map((event) => event.seat),
    ["1", "1"],
  );
  click(document.querySelector("#splitBtn-1"));
  assert.equal(store.read(TABLE_STREAM).at(-1)?.type, "hand_split");
  click(document.querySelector("#nextHandBtn"));
  const cleared = store.read(TABLE_STREAM);
  assert.equal(cleared.at(-1)?.type, "hand_completed");
  const html = document.querySelector("#app")?.innerHTML ?? "";

  key("x");
  click(document.querySelector('#suitGrid button[data-suit="diamonds"]'));
  key("Backspace");
  assert.deepEqual(store.read(TABLE_STREAM), cleared);
  assert.equal(document.querySelector("#app")?.innerHTML ?? "", html);
  assert.equal(html.includes("class=\"mini"), false);
});
