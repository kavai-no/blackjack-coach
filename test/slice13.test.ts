import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { piledCard } from "../src/felt/piled-card.ts";
import {
  COUNTS_PATH,
  FELT_PATH,
  REMAINING_PATH,
  START_SHOE_PATH,
  WITHDRAW_CARD_PATH,
  handleHttp,
  type HttpRequest,
  type HttpResponse,
} from "../src/http/handle.ts";
import { projectCountsInfoBar } from "../src/read/counts-info-bar.ts";
import { projectFeltTable } from "../src/read/felt-table.ts";
import { projectRemainingComposition } from "../src/read/remaining-composition.ts";
import { createNewShoeShell } from "../src/ui/new-shoe-shell.ts";
import {
  TABLE_STREAM,
  createInMemoryEventStore,
} from "../src/write/in-memory-store.ts";

const SEATS = ["D", "7", "6", "5", "4", "3", "2", "1"];

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
    path: "/commands/observe-card",
    body: { rank, seat },
  });
  assert.equal(response.status, 200);
}

test("POST /commands/withdraw-card is rank + seat of the last card and returns ack, events, position only", () => {
  assert.equal(WITHDRAW_CARD_PATH, "/commands/withdraw-card");
  const store = createInMemoryEventStore();
  const handle = (request: HttpRequest) => handleHttp(store, request);
  start(handle);
  observe(handle, "5", "1");
  observe(handle, "A", "1");
  const before = store.read(TABLE_STREAM);
  const countsBefore = projectCountsInfoBar(before);
  const remainingBefore = projectRemainingComposition(before);
  assert.equal(countsBefore.acesLeft, 31);
  assert.equal(countsBefore.hilo_rc, 0);
  assert.notEqual(countsBefore.omega_ii_tc, "Omega II: +0.00");
  assert.equal(
    remainingBefore.remaining_by_rank.find((slice) => slice.rank === "A")?.count,
    31,
  );
  assert.equal(
    remainingBefore.remaining_by_rank.find((slice) => slice.rank === "5")?.count,
    31,
  );

  const response = handle({
    method: "POST",
    path: WITHDRAW_CARD_PATH,
    body: { rank: "A", seat: "1", suit: "hearts", hand: "A" },
  });
  const body = ackBody(response);
  assert.equal(body.events.length, 1);
  assert.equal(body.position, 4);
  assert.equal(body.position, body.events[0]?.position);
  const event = body.events[0];
  assert.ok(event);
  assert.equal(event.type, "card_withdrawn");
  assert.equal(event.rank, "A");
  assert.equal(event.seat, "1");
  assert.equal("suit" in event, false);
  assert.equal("hand" in event, false);
  assert.deepEqual(Object.keys(event).sort(), ["position", "rank", "seat", "type"]);

  const events = store.read(TABLE_STREAM);
  assert.deepEqual(
    events.map((item) => item.type),
    ["shoe_started", "card_observed", "card_observed", "card_withdrawn"],
  );
  const felt = handle({ method: "GET", path: FELT_PATH });
  const counts = handle({ method: "GET", path: COUNTS_PATH });
  const remaining = handle({ method: "GET", path: REMAINING_PATH });
  const projected = projectFeltTable(events);
  assert.deepEqual(felt.body, projected);
  assert.deepEqual(counts.body, projectCountsInfoBar(events));
  assert.deepEqual(remaining.body, projectRemainingComposition(events));
  assert.notDeepEqual(counts.body, countsBefore);
  assert.notDeepEqual(remaining.body, remainingBefore);

  assert.equal(projected.seat_order, "D,7,6,5,4,3,2,1");
  assert.deepEqual(
    projected.seat_piles.map((pile) => pile.seat),
    SEATS,
  );
  assert.deepEqual(projected.seat_piles.find((pile) => pile.seat === "1")?.cards, [
    { rank: "5", suit: null },
  ]);
  assert.equal(projected.screen.focus_seat, "1");
  assert.equal(projected.screen.hero_seat, "1");
  assert.equal(projected.split_piles.length, 0);

  const restored = projectCountsInfoBar(events);
  const afterFive = projectCountsInfoBar(events.slice(0, 2));
  assert.deepEqual(restored, afterFive);
  assert.equal(restored.acesLeft, 32);
  assert.equal(restored.hilo_rc, 1);
  assert.equal(restored.omega_ii_tc, afterFive.omega_ii_tc);
  assert.equal(
    projectRemainingComposition(events).remaining_by_rank.find((slice) => slice.rank === "A")
      ?.count,
    32,
  );
  assert.equal(
    projectRemainingComposition(events).remaining_by_rank.find((slice) => slice.rank === "5")
      ?.count,
    31,
  );
  assert.deepEqual(
    projectRemainingComposition(events).remaining_by_suit.map((slice) => slice.count),
    [104, 104, 104, 104],
  );
});

test("POST withdraw-card without rank and seat is 400 and does not append", () => {
  const store = createInMemoryEventStore();
  start((request) => handleHttp(store, request));
  observe((request) => handleHttp(store, request), "K", "1");
  const before = store.read(TABLE_STREAM).length;
  for (const body of [
    undefined,
    {},
    { rank: "K" },
    { seat: "1" },
    { rank: "T", seat: "1" },
    { rank: "k", seat: "1" },
    { rank: "K", seat: "dealer" },
    { rank: "K", seat: "8" },
    { rank: "K", seat: 1 },
    { rank: 10, seat: "1" },
    { rank: "", seat: "" },
  ]) {
    const response = handleHttp(store, {
      method: "POST",
      path: WITHDRAW_CARD_PATH,
      body,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: "rank_and_seat_required" });
  }
  assert.equal(store.read(TABLE_STREAM).length, before);
  assert.equal(
    store.read(TABLE_STREAM).some((event) => event.type === "card_withdrawn"),
    false,
  );
  const get = handleHttp(store, { method: "GET", path: WITHDRAW_CARD_PATH });
  assert.equal(get.status, 404);
});

test("POST withdraw-card that is not the last registered card is 400 and does not append", () => {
  const store = createInMemoryEventStore();
  const handle = (request: HttpRequest) => handleHttp(store, request);
  start(handle);
  observe(handle, "5", "1");
  observe(handle, "K", "D");
  const before = store.read(TABLE_STREAM).map((event) => event.type);

  for (const body of [
    { rank: "5", seat: "1" },
    { rank: "K", seat: "1" },
    { rank: "5", seat: "D" },
    { rank: "Q", seat: "D" },
  ]) {
    const response = handle({
      method: "POST",
      path: WITHDRAW_CARD_PATH,
      body,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: "not_last_registered" });
  }
  assert.deepEqual(
    store.read(TABLE_STREAM).map((event) => event.type),
    before,
  );

  const withdrawn = ackBody(
    handle({
      method: "POST",
      path: WITHDRAW_CARD_PATH,
      body: { rank: "K", seat: "D" },
    }),
  );
  assert.equal(withdrawn.events[0]?.type, "card_withdrawn");
  assert.equal(withdrawn.events[0]?.rank, "K");
  assert.equal(withdrawn.events[0]?.seat, "D");

  const gone = handle({
    method: "POST",
    path: WITHDRAW_CARD_PATH,
    body: { rank: "K", seat: "D" },
  });
  assert.equal(gone.status, 400);
  assert.deepEqual(gone.body, { error: "not_last_registered" });

  const bare = createInMemoryEventStore();
  start((request) => handleHttp(bare, request));
  const empty = handleHttp(bare, {
    method: "POST",
    path: WITHDRAW_CARD_PATH,
    body: { rank: "K", seat: "1" },
  });
  assert.equal(empty.status, 400);
  assert.deepEqual(empty.body, { error: "not_last_registered" });
  assert.equal(
    bare.read(TABLE_STREAM).some((event) => event.type === "card_withdrawn"),
    false,
  );
});

test("GWT Backspace withdraws the last registered card and restores counts and remaining", () => {
  const { store, calls, shell } = wired();
  assert.match(shell.html(), /id="backspaceBtn"/);
  assert.match(shell.html(), /data-key="Backspace"/);
  assert.equal(/withdraw/i.test(shell.html()), false);
  assert.equal(shell.pressWithdraw().rejected, true);
  assert.equal(calls.length, 0);

  shell.pressNewShoe();
  const emptyCounts = projectCountsInfoBar(store.read(TABLE_STREAM));
  const emptyRemaining = projectRemainingComposition(store.read(TABLE_STREAM));
  assert.equal(emptyCounts.ra.numeric, -0.875);
  assert.equal(emptyCounts.acesLeft, 32);
  assert.notEqual(emptyCounts.ra.numeric, emptyCounts.acesLeft / (4 * emptyCounts.decksLeft) - 1);
  calls.length = 0;
  assert.equal(shell.pressWithdraw().rejected, true);
  assert.equal(calls.length, 0);

  shell.pressRank("A");
  shell.pressSuit("hearts");
  const dealt = store.read(TABLE_STREAM);
  const dealtCounts = projectCountsInfoBar(dealt);
  const dealtRemaining = projectRemainingComposition(dealt);
  assert.equal(dealtCounts.acesLeft, 31);
  assert.equal(dealtCounts.hilo_rc, -1);
  assert.equal(dealtCounts.omega_ii_tc, emptyCounts.omega_ii_tc);
  assert.notEqual(dealtCounts.ace_tc, emptyCounts.ace_tc);
  assert.equal(dealtCounts.ace_tc, "Ace: -0.12");
  assert.equal(
    dealtRemaining.remaining_by_rank.find((slice) => slice.rank === "A")?.count,
    31,
  );
  assert.equal(
    dealtRemaining.remaining_by_suit.find((slice) => slice.suit === "hearts")?.count,
    103,
  );
  assert.match(
    shell.html(),
    /id="hand-1"><div class="mini" data-rank="A" data-suit="hearts">A♥<\/div><\/div>/,
  );
  calls.length = 0;

  const pressed = shell.pressWithdraw();
  assert.equal(pressed.rejected, false);
  if (pressed.rejected) return;
  assert.deepEqual(
    calls.map((call) => [call.method, call.path]),
    [
      ["POST", "/commands/withdraw-card"],
      ["GET", "/views/felt"],
      ["GET", "/views/counts"],
      ["GET", "/views/remaining"],
    ],
  );
  assert.deepEqual(calls[0]?.body, { rank: "A", seat: "1" });
  const post = ackBody(pressed.post);
  assert.equal(post.events[0]?.type, "card_withdrawn");
  assert.equal(post.events[0]?.rank, "A");
  assert.equal(post.events[0]?.seat, "1");
  assert.equal(post.events[0] !== undefined && "suit" in post.events[0], false);
  assert.equal(post.position, 4);

  const events = store.read(TABLE_STREAM);
  const felt = projectFeltTable(events);
  const counts = projectCountsInfoBar(events);
  const remaining = projectRemainingComposition(events);
  assert.deepEqual(counts, emptyCounts);
  assert.deepEqual(remaining, emptyRemaining);
  assert.equal(counts.ra.numeric, -0.875);
  assert.equal(counts.acesLeft, 32);
  assert.equal(counts.hilo_rc, 0);
  assert.equal(counts.omega_ii_tc, "Omega II: +0.00");
  assert.equal(counts.ace_tc, "Ace: 0.00");
  assert.notEqual(counts.ra.numeric, 0);
  assert.equal(felt.seat_order, "D,7,6,5,4,3,2,1");
  assert.equal(felt.screen.focus_seat, "1");
  assert.equal(felt.screen.hero_seat, "1");
  assert.deepEqual(felt.seat_piles.find((pile) => pile.seat === "1")?.cards, []);
  assert.equal(
    remaining.remaining_by_rank.find((slice) => slice.rank === "A")?.count,
    32,
  );
  assert.equal(
    remaining.remaining_by_suit.find((slice) => slice.suit === "hearts")?.count,
    104,
  );
  assert.equal(
    remaining.remaining_by_rank_suit.find(
      (cell) => cell.rank === "A" && cell.suit === "hearts",
    )?.count,
    8,
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
  assert.equal(html.includes("A♥"), false);
  assert.equal(html.includes("rank-only"), false);
  for (const text of [
    counts.penetration,
    counts.decks_left,
    `${counts.ra.label} ${counts.ra.value}`,
    counts.hilo_display,
    counts.apc_tc,
    counts.zen_tc,
    counts.omega_ii_tc,
    counts.ace_tc,
    "RA: -0.88",
    "Omega II: +0.00",
  ]) {
    assert.equal(html.includes(text), true, text);
  }
  const json = html.match(
    /<script type="application\/json" id="combinedChart-data">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(json);
  assert.deepEqual(JSON.parse(json), emptyRemaining);
  assert.equal(
    /RoR|Wong|21\+3|Perfect Pair|sidebet|SURRENDER|Expert/i.test(html),
    false,
  );

  calls.length = 0;
  assert.equal(shell.pressWithdraw().rejected, true);
  assert.deepEqual(calls, []);
  assert.equal(shell.pressSuit("hearts").rejected, true);
  assert.deepEqual(calls, []);
  assert.equal(
    store.read(TABLE_STREAM).filter((event) => event.type === "card_withdrawn").length,
    1,
  );
});

test("GWT withdraw removes only the last card; an older card and its suit stay", () => {
  const { store, calls, shell } = wired();
  shell.pressNewShoe();
  shell.pressRank("K");
  shell.pressSuit("spades");
  const afterKing = projectCountsInfoBar(store.read(TABLE_STREAM));
  const afterKingRemaining = projectRemainingComposition(store.read(TABLE_STREAM));
  shell.pressRank("5");
  calls.length = 0;

  const pressed = shell.pressWithdraw();
  assert.equal(pressed.rejected, false);
  if (pressed.rejected) return;
  assert.deepEqual(calls[0]?.body, { rank: "5", seat: "1" });
  assert.notDeepEqual(calls[0]?.body, { rank: "K", seat: "1" });

  const events = store.read(TABLE_STREAM);
  const felt = projectFeltTable(events);
  assert.deepEqual(felt.seat_piles.find((pile) => pile.seat === "1")?.cards, [
    piledCard("K", "spades"),
  ]);
  const face = felt.seat_piles.find((pile) => pile.seat === "1")?.cards[0];
  assert.equal(face && "mini_card_face" in face ? face.mini_card_face.face : "", "K♠");
  assert.deepEqual(projectCountsInfoBar(events), afterKing);
  assert.deepEqual(projectRemainingComposition(events), afterKingRemaining);
  assert.equal(
    projectRemainingComposition(events).remaining_by_rank.find((slice) => slice.rank === "5")
      ?.count,
    32,
  );
  assert.equal(
    projectRemainingComposition(events).remaining_by_rank.find((slice) => slice.rank === "K")
      ?.count,
    31,
  );
  assert.equal(
    projectRemainingComposition(events).remaining_by_suit.find((slice) => slice.suit === "spades")
      ?.count,
    103,
  );
  assert.match(
    pressed.html,
    /id="hand-1"><div class="mini" data-rank="K" data-suit="spades">K♠<\/div><\/div>/,
  );
  assert.equal(/id="hand-1">[^]*data-rank="5"/.test(pressed.html), false);
  assert.equal(felt.screen.focus_seat, "1");
  assert.equal(felt.screen.hero_seat, "1");

  calls.length = 0;
  const suited = shell.pressSuit("hearts");
  assert.equal(suited.rejected, false);
  if (suited.rejected) return;
  assert.deepEqual(calls[0]?.body, { suit: "hearts", seat: "1" });
  const moved = projectRemainingComposition(store.read(TABLE_STREAM));
  assert.equal(
    moved.remaining_by_suit.find((slice) => slice.suit === "spades")?.count,
    104,
  );
  assert.equal(
    moved.remaining_by_suit.find((slice) => slice.suit === "hearts")?.count,
    103,
  );
  assert.match(suited.html, /data-rank="K" data-suit="hearts">K♥/);
});

test("withdraw-card boundary reuses withdrawCard and does not re-derive counts or open a network server", () => {
  const httpSrc = readFileSync(new URL("../src/http/handle.ts", import.meta.url), "utf8");
  const shellSrc = readFileSync(
    new URL("../src/ui/new-shoe-shell.ts", import.meta.url),
    "utf8",
  );
  assert.match(httpSrc, /withdrawCard\(/);
  assert.match(httpSrc, /projectFeltTable\(/);
  assert.match(httpSrc, /projectCountsInfoBar\(/);
  assert.match(httpSrc, /projectRemainingComposition\(/);
  assert.match(httpSrc, /completeHand\(/);
  assert.equal(httpSrc.includes("runningAce"), false);
  assert.equal(httpSrc.includes("COUNT_MAPS"), false);
  assert.equal(httpSrc.includes("pickSuit"), false);
  assert.equal(httpSrc.includes("lastRegistered"), false);
  assert.equal(httpSrc.includes("card_observed"), false);
  assert.equal(httpSrc.includes("node:http"), false);
  assert.equal(httpSrc.includes("createServer"), false);

  assert.match(shellSrc, /WITHDRAW_CARD_PATH/);
  assert.match(shellSrc, /pressWithdraw/);
  assert.match(shellSrc, /id="backspaceBtn"/);
  assert.equal(shellSrc.includes("withdrawCard"), false);
  assert.equal(shellSrc.includes("card_withdrawn"), false);
  assert.equal(shellSrc.includes("card_observed"), false);
  assert.equal(shellSrc.includes("projectFeltTable"), false);
  assert.equal(shellSrc.includes("projectCountsInfoBar"), false);
  assert.equal(shellSrc.includes("projectRemainingComposition"), false);
  assert.equal(shellSrc.includes("runningAce"), false);
  assert.equal(shellSrc.includes("COUNT_MAPS"), false);
  assert.equal(shellSrc.includes("pickSuit"), false);
  assert.equal(shellSrc.includes("completeHand"), false);
  assert.equal(shellSrc.includes("node:http"), false);
  assert.equal(shellSrc.includes("createServer"), false);
  assert.equal(/withdraw/i.test(
    shellSrc.slice(shellSrc.indexOf("function frame")),
  ), false);
});
