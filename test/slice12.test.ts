import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FELT_PATH,
  COUNTS_PATH,
  REMAINING_PATH,
  SPLIT_HAND_PATH,
  START_SHOE_PATH,
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

test("POST /commands/split-hand is seat only and returns ack, events, position only", () => {
  assert.equal(SPLIT_HAND_PATH, "/commands/split-hand");
  const store = createInMemoryEventStore();
  const handle = (request: HttpRequest) => handleHttp(store, request);
  start(handle);
  observe(handle, "K", "1");
  observe(handle, "K", "1");
  const before = store.read(TABLE_STREAM);
  const countsBefore = projectCountsInfoBar(before);
  const remainingBefore = projectRemainingComposition(before);

  const response = handle({
    method: "POST",
    path: SPLIT_HAND_PATH,
    body: { seat: "1", rank: "10", hand: "A" },
  });
  const body = ackBody(response);
  assert.equal(body.events.length, 1);
  assert.equal(body.position, 4);
  assert.equal(body.position, body.events[0]?.position);
  const event = body.events[0];
  assert.ok(event);
  assert.equal(event.type, "hand_split");
  assert.equal(event.seat, "1");
  assert.equal("rank" in event, false);
  assert.equal("suit" in event, false);
  assert.equal("hand" in event, false);
  assert.deepEqual(Object.keys(event).sort(), ["position", "seat", "type"]);

  const events = store.read(TABLE_STREAM);
  assert.deepEqual(
    events.map((item) => item.type),
    ["shoe_started", "card_observed", "card_observed", "hand_split"],
  );
  const felt = handle({ method: "GET", path: FELT_PATH });
  const counts = handle({ method: "GET", path: COUNTS_PATH });
  const remaining = handle({ method: "GET", path: REMAINING_PATH });
  assert.deepEqual(felt.body, projectFeltTable(events));
  assert.deepEqual(counts.body, countsBefore);
  assert.deepEqual(counts.body, projectCountsInfoBar(events));
  assert.deepEqual(remaining.body, remainingBefore);
  assert.deepEqual(remaining.body, projectRemainingComposition(events));

  const projected = projectFeltTable(events);
  assert.equal(projected.seat_order, "D,7,6,5,4,3,2,1");
  assert.deepEqual(
    projected.seat_piles.map((pile) => pile.seat),
    SEATS,
  );
  assert.deepEqual(projected.seat_piles.find((pile) => pile.seat === "1")?.cards, []);
  assert.deepEqual(projected.split_piles, [
    { seat: "1", hand: "A", cards: [{ rank: "K", suit: null }] },
    { seat: "1", hand: "B", cards: [{ rank: "K", suit: null }] },
  ]);
  assert.equal(projected.screen.focus_seat, "1");
  assert.equal(projected.screen.hero_seat, "1");
  assert.equal(projected.screen.split_button_visible, false);
  assert.equal("remaining_by_rank" in projected, false);
  assert.equal("acesLeft" in projected, false);
  assert.equal(
    remainingBefore.remaining_by_rank.find((slice) => slice.rank === "K")?.count,
    30,
  );
});

test("POST split-hand without a real seat is 400 and does not append", () => {
  const store = createInMemoryEventStore();
  start((request) => handleHttp(store, request));
  observe((request) => handleHttp(store, request), "K", "1");
  observe((request) => handleHttp(store, request), "K", "1");
  const before = store.read(TABLE_STREAM).length;
  for (const body of [
    undefined,
    {},
    { rank: "K" },
    { seat: "dealer" },
    { seat: "8" },
    { seat: "d" },
    { seat: "1A" },
    { seat: 1 },
    { seat: "" },
  ]) {
    const response = handleHttp(store, {
      method: "POST",
      path: SPLIT_HAND_PATH,
      body,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: "seat_required" });
  }
  assert.equal(store.read(TABLE_STREAM).length, before);
  assert.equal(
    store.read(TABLE_STREAM).some((event) => event.type === "hand_split"),
    false,
  );
  const get = handleHttp(store, { method: "GET", path: SPLIT_HAND_PATH });
  assert.equal(get.status, 404);
});

test("POST split-hand reuses the pair rule: K+K and 10+10 split; 10+K does not", () => {
  const kings = createInMemoryEventStore();
  const handleKings = (request: HttpRequest) => handleHttp(kings, request);
  start(handleKings);
  observe(handleKings, "K", "1");
  observe(handleKings, "K", "1");
  const splitKings = handleKings({
    method: "POST",
    path: SPLIT_HAND_PATH,
    body: { seat: "1" },
  });
  assert.equal(ackBody(splitKings).events[0]?.type, "hand_split");

  const tens = createInMemoryEventStore();
  const handleTens = (request: HttpRequest) => handleHttp(tens, request);
  start(handleTens);
  observe(handleTens, "10", "1");
  observe(handleTens, "10", "1");
  assert.equal(
    ackBody(
      handleTens({
        method: "POST",
        path: SPLIT_HAND_PATH,
        body: { seat: "1" },
      }),
    ).events[0]?.type,
    "hand_split",
  );

  const tenKing = createInMemoryEventStore();
  const handleTenKing = (request: HttpRequest) => handleHttp(tenKing, request);
  start(handleTenKing);
  observe(handleTenKing, "10", "1");
  observe(handleTenKing, "K", "1");
  const before = tenKing.read(TABLE_STREAM).map((event) => event.type);
  assert.throws(
    () =>
      handleTenKing({
        method: "POST",
        path: SPLIT_HAND_PATH,
        body: { seat: "1" },
      }),
    /same rank/,
  );
  assert.deepEqual(
    tenKing.read(TABLE_STREAM).map((event) => event.type),
    before,
  );

  const other = createInMemoryEventStore();
  const handleOther = (request: HttpRequest) => handleHttp(other, request);
  start(handleOther);
  observe(handleOther, "Q", "2");
  observe(handleOther, "Q", "2");
  assert.throws(
    () =>
      handleOther({
        method: "POST",
        path: SPLIT_HAND_PATH,
        body: { seat: "2" },
      }),
    /hero-only/,
  );
  assert.equal(
    other.read(TABLE_STREAM).some((event) => event.type === "hand_split"),
    false,
  );

  assert.throws(
    () =>
      handleKings({
        method: "POST",
        path: SPLIT_HAND_PATH,
        body: { seat: "1" },
      }),
    /already split/,
  );
  assert.equal(
    kings.read(TABLE_STREAM).filter((event) => event.type === "hand_split").length,
    1,
  );

  const bare = createInMemoryEventStore();
  assert.throws(
    () =>
      handleHttp(bare, {
        method: "POST",
        path: SPLIT_HAND_PATH,
        body: { seat: "1" },
      }),
    /requires a shoe/,
  );
  assert.deepEqual(bare.read(TABLE_STREAM), []);
});

test("GWT hero pair shows #splitBtn-1; press paints A/B and hides the button", () => {
  const { store, calls, shell } = wired();
  assert.equal(shell.pressSplit().rejected, true);
  assert.equal(/split/i.test(shell.html()), false);

  shell.pressNewShoe();
  calls.length = 0;
  assert.equal(shell.pressSplit().rejected, true);
  assert.equal(calls.length, 0);
  assert.equal(/split/i.test(shell.html()), false);

  shell.pressRank("K");
  assert.equal(shell.pressSplit().rejected, true);
  assert.equal(shell.html().includes("splitBtn"), false);

  shell.pressRank("K");
  const before = store.read(TABLE_STREAM);
  const countsBefore = projectCountsInfoBar(before);
  const remainingBefore = projectRemainingComposition(before);
  const infoBefore = shell.html().match(/<section id="infoBar"[\s\S]*<\/section>/)?.[0];
  assert.match(
    shell.html(),
    /<div class="hand" id="hand-1"><div class="mini rank-only" data-rank="K" data-suit="">K<\/div><div class="mini rank-only" data-rank="K" data-suit="">K<\/div><\/div><button class="split-btn" id="splitBtn-1" type="button">SPLIT<\/button>/,
  );
  assert.equal(shell.html().includes("splitBtn-2"), false);
  assert.equal(shell.html().includes("splitBtn-D"), false);
  assert.equal(shell.html().includes('id="split-1"'), false);
  assert.equal((shell.html().match(/split-btn/g) ?? []).length, 1);
  calls.length = 0;

  const pressed = shell.pressSplit();
  assert.equal(pressed.rejected, false);
  if (pressed.rejected) return;
  assert.deepEqual(
    calls.map((call) => [call.method, call.path]),
    [
      ["POST", "/commands/split-hand"],
      ["GET", "/views/felt"],
      ["GET", "/views/counts"],
      ["GET", "/views/remaining"],
    ],
  );
  assert.deepEqual(calls[0]?.body, { seat: "1" });
  const post = ackBody(pressed.post);
  assert.equal(post.events[0]?.type, "hand_split");
  assert.equal(post.events[0]?.seat, "1");
  assert.equal(post.position, 4);

  const events = store.read(TABLE_STREAM);
  const felt = projectFeltTable(events);
  assert.deepEqual(felt.split_piles, [
    { seat: "1", hand: "A", cards: [{ rank: "K", suit: null }] },
    { seat: "1", hand: "B", cards: [{ rank: "K", suit: null }] },
  ]);
  assert.deepEqual(felt.seat_piles.find((pile) => pile.seat === "1")?.cards, []);
  assert.equal(felt.screen.split_button_visible, false);
  assert.equal(felt.screen.focus_seat, "1");
  assert.equal(felt.screen.hero_seat, "1");
  assert.equal(felt.screen.active_split, "1A");
  assert.deepEqual(projectCountsInfoBar(events), countsBefore);
  assert.deepEqual(projectRemainingComposition(events), remainingBefore);
  assert.equal(
    projectRemainingComposition(events).remaining_by_rank.find((slice) => slice.rank === "K")
      ?.count,
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
    /<section class="seat" data-seat="1"><div class="seat-round active your-seat">1<\/div><div class="hand" id="hand-1" style="display:none"><\/div><div class="split-container" id="split-1" style="display:flex"><div class="split-hand active"><div class="split-label">A<\/div><div class="hand-total" style="color:#ffd43f">Total: 10<\/div><div class="hand" id="hand-1A"><div class="mini rank-only" data-rank="K" data-suit="">K<\/div><\/div><\/div><div class="split-hand"><div class="split-label">B<\/div><div class="hand-total" style="color:#ffd43f">Total: 10<\/div><div class="hand" id="hand-1B"><div class="mini rank-only" data-rank="K" data-suit="">K<\/div><\/div><\/div><\/div><\/section>/,
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
  assert.equal(html.includes("splitBtn"), false);
  assert.equal(html.includes(">SPLIT<"), false);
  assert.equal(html.match(/seat-round active/g)?.length, 1);
  assert.equal(html.match(/your-seat/g)?.length, 1);
  assert.equal(html.match(/<section id="infoBar"[\s\S]*<\/section>/)?.[0], infoBefore);
  const json = html.match(
    /<script type="application\/json" id="combinedChart-data">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(json);
  assert.deepEqual(JSON.parse(json), remainingBefore);
  assert.equal(
    /RoR|Wong|21\+3|Perfect Pair|sidebet|SURRENDER|Expert|withdraw/i.test(html),
    false,
  );

  calls.length = 0;
  assert.equal(shell.pressSplit().rejected, true);
  assert.deepEqual(calls, []);
  assert.equal(
    store.read(TABLE_STREAM).filter((event) => event.type === "hand_split").length,
    1,
  );
});

test("GWT split button stays hidden for 10+K, one card, and three of a kind", () => {
  const tenKing = wired();
  tenKing.shell.pressNewShoe();
  tenKing.shell.pressRank("10");
  tenKing.shell.pressRank("K");
  assert.equal(tenKing.shell.html().includes("splitBtn"), false);
  assert.equal(/split/i.test(tenKing.shell.html()), false);
  tenKing.calls.length = 0;
  assert.equal(tenKing.shell.pressSplit().rejected, true);
  assert.deepEqual(tenKing.calls, []);
  assert.match(
    tenKing.shell.html(),
    /id="hand-1"><div class="mini rank-only" data-rank="10" data-suit="">10<\/div><div class="mini rank-only" data-rank="K" data-suit="">K<\/div><\/div><\/section>/,
  );
  assert.equal(
    tenKing.store.read(TABLE_STREAM).some((event) => event.type === "hand_split"),
    false,
  );

  const three = wired();
  three.shell.pressNewShoe();
  three.shell.pressRank("9");
  three.shell.pressRank("9");
  assert.equal(three.shell.html().includes("splitBtn-1"), true);
  three.shell.pressRank("9");
  assert.equal(three.shell.html().includes("splitBtn"), false);
  assert.equal(three.shell.pressSplit().rejected, true);
  assert.equal(
    three.store.read(TABLE_STREAM).some((event) => event.type === "hand_split"),
    false,
  );

  const queen = wired();
  queen.shell.pressNewShoe();
  queen.shell.pressRank("Q");
  queen.shell.pressRank("K");
  assert.equal(queen.shell.pressSplit().rejected, true);
  assert.equal(queen.shell.html().includes("split-btn"), false);
});

test("GWT suited hero pair: split moves the faces onto A and B and leaves the shoe", () => {
  const { store, shell } = wired();
  shell.pressNewShoe();
  shell.pressRank("K");
  shell.pressSuit("spades");
  shell.pressRank("K");
  shell.pressSuit("diamonds");
  const before = store.read(TABLE_STREAM);
  const countsBefore = projectCountsInfoBar(before);
  const remainingBefore = projectRemainingComposition(before);
  assert.equal(shell.html().includes('id="splitBtn-1"'), true);

  const pressed = shell.pressSplit();
  assert.equal(pressed.rejected, false);
  if (pressed.rejected) return;

  const events = store.read(TABLE_STREAM);
  const felt = projectFeltTable(events);
  assert.equal(felt.split_piles[0]?.cards[0]?.suit, "spades");
  assert.equal(
    felt.split_piles[0]?.cards[0] && "mini_card_face" in felt.split_piles[0].cards[0]
      ? felt.split_piles[0].cards[0].mini_card_face.face
      : "",
    "K♠",
  );
  assert.equal(felt.split_piles[1]?.cards[0]?.suit, "diamonds");
  assert.equal(
    felt.split_piles[1]?.cards[0] && "mini_card_face" in felt.split_piles[1].cards[0]
      ? felt.split_piles[1].cards[0].mini_card_face.face
      : "",
    "K♦",
  );
  assert.deepEqual(projectCountsInfoBar(events), countsBefore);
  assert.deepEqual(projectRemainingComposition(events), remainingBefore);
  assert.equal(
    projectRemainingComposition(events).remaining_by_rank.find((slice) => slice.rank === "K")
      ?.count,
    30,
  );
  assert.deepEqual(
    projectRemainingComposition(events).remaining_by_suit.map((slice) => slice.count),
    [103, 104, 104, 103],
  );
  assert.match(
    pressed.html,
    /id="hand-1A"><div class="mini" data-rank="K" data-suit="spades">K♠<\/div><\/div>/,
  );
  assert.match(
    pressed.html,
    /id="hand-1B"><div class="mini" data-rank="K" data-suit="diamonds">K♦<\/div><\/div>/,
  );
  assert.match(pressed.html, /id="hand-1" style="display:none"><\/div>/);
  assert.equal(pressed.html.includes("splitBtn"), false);
  assert.equal(pressed.html.includes("rank-only"), false);
});

test("split-hand boundary reuses splitHand and does not re-derive piles or open a network server", () => {
  const httpSrc = readFileSync(new URL("../src/http/handle.ts", import.meta.url), "utf8");
  const shellSrc = readFileSync(
    new URL("../src/ui/new-shoe-shell.ts", import.meta.url),
    "utf8",
  );
  assert.match(httpSrc, /splitHand\(/);
  assert.match(httpSrc, /projectFeltTable\(/);
  assert.match(httpSrc, /projectCountsInfoBar\(/);
  assert.match(httpSrc, /projectRemainingComposition\(/);
  assert.equal(httpSrc.includes("split_piles"), false);
  assert.match(httpSrc, /withdrawCard\(/);
  assert.match(httpSrc, /completeHand\(/);
  assert.equal(httpSrc.includes("runningAce"), false);
  assert.equal(httpSrc.includes("COUNT_MAPS"), false);
  assert.equal(httpSrc.includes("pickSuit"), false);
  assert.equal(httpSrc.includes("node:http"), false);
  assert.equal(httpSrc.includes("createServer"), false);

  assert.match(shellSrc, /SPLIT_HAND_PATH/);
  assert.match(shellSrc, /id="splitBtn-/);
  assert.match(shellSrc, /split_button_visible/);
  assert.equal(shellSrc.includes("splitHand"), false);
  assert.equal(shellSrc.includes("hand_split"), false);
  assert.equal(shellSrc.includes("projectFeltTable"), false);
  assert.equal(shellSrc.includes("projectCountsInfoBar"), false);
  assert.equal(shellSrc.includes("projectRemainingComposition"), false);
  assert.equal(shellSrc.includes("first.rank"), false);
  assert.equal(shellSrc.includes("pickSuit"), false);
  assert.equal(shellSrc.includes("runningAce"), false);
  assert.equal(shellSrc.includes("COUNT_MAPS"), false);
  assert.equal(shellSrc.includes("node:http"), false);
  assert.equal(shellSrc.includes("createServer"), false);
});
