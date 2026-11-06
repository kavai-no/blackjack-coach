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
import {
  TABLE_STREAM,
  createInMemoryEventStore,
} from "../src/write/in-memory-store.ts";

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

test("GWT NEXT HAND clears split piles and keeps the shoe; a second press still posts", () => {
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

  shell.pressRank("K");
  shell.pressSuit("spades");
  shell.pressRank("K");
  shell.pressSuit("diamonds");
  const split = shell.pressSplit();
  assert.equal(split.rejected, false);
  observe(handle, "6", "D");
  suit(handle, "hearts", "D");
  const dealt = store.read(TABLE_STREAM);
  const countsBefore = projectCountsInfoBar(dealt);
  const remainingBefore = projectRemainingComposition(dealt);
  const feltBefore = projectFeltTable(dealt);
  assert.equal(feltBefore.split_piles.length, 2);
  assert.equal(
    feltBefore.seat_piles.find((pile) => pile.seat === "D")?.cards.length,
    1,
  );
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
    `${counts.ra.label} ${counts.ra.numeric}`,
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
  assert.equal((document.querySelector("#app")?.innerHTML ?? "").includes("data-seat"), false);

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
