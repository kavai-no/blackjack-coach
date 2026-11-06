import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SUIT_SYMBOL } from "../src/felt/mini-card-face.ts";
import {
  FELT_PATH,
  COUNTS_PATH,
  REMAINING_PATH,
  SET_SUIT_PATH,
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
/** Original `#suitGrid` is `[...suits].reverse()`, not storage order. */
const PAD = [
  ["clubs", "♣"],
  ["diamonds", "♦"],
  ["hearts", "♥"],
  ["spades", "♠"],
] as const;

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

function suitButtons(html: string): string[][] {
  return [
    ...html.matchAll(
      /<button type="button" class="suit-btn card-btn ([^"]+)" data-suit="([^"]+)">([^<]*)<\/button>/g,
    ),
  ].map((match) => [match[1] ?? "", match[2] ?? "", match[3] ?? ""]);
}

test("POST /commands/set-suit is suit + seat and returns ack, events, position only", () => {
  assert.equal(SET_SUIT_PATH, "/commands/set-suit");
  const store = createInMemoryEventStore();
  const handle = (request: HttpRequest) => handleHttp(store, request);
  start(handle);
  handle({
    method: "POST",
    path: "/commands/observe-card",
    body: { rank: "K", seat: "1" },
  });
  const before = store.read(TABLE_STREAM);
  const countsBefore = projectCountsInfoBar(before);
  const ranksBefore = projectRemainingComposition(before).remaining_by_rank;

  const response = handle({
    method: "POST",
    path: SET_SUIT_PATH,
    body: { suit: "hearts", seat: "1", rank: "5" },
  });
  const body = ackBody(response);
  assert.equal(body.events.length, 1);
  assert.equal(body.position, 3);
  assert.equal(body.position, body.events[0]?.position);
  const event = body.events[0];
  assert.ok(event);
  assert.equal(event.type, "card_suit_set");
  assert.equal(event.suit, "hearts");
  assert.equal(event.seat, "1");
  assert.equal("rank" in event, false);
  assert.deepEqual(Object.keys(event).sort(), ["position", "seat", "suit", "type"]);

  const events = store.read(TABLE_STREAM);
  assert.deepEqual(
    events.map((item) => item.type),
    ["shoe_started", "card_observed", "card_suit_set"],
  );
  const felt = handle({ method: "GET", path: FELT_PATH });
  const counts = handle({ method: "GET", path: COUNTS_PATH });
  const remaining = handle({ method: "GET", path: REMAINING_PATH });
  assert.deepEqual(felt.body, projectFeltTable(events));
  assert.deepEqual(counts.body, projectCountsInfoBar(events));
  assert.deepEqual(remaining.body, projectRemainingComposition(events));
  assert.deepEqual(counts.body, countsBefore);

  const projected = projectFeltTable(events);
  const hero = projected.seat_piles.find((pile) => pile.seat === "1");
  assert.ok(hero);
  assert.equal(hero.cards.length, 1);
  const card = hero.cards[0];
  assert.ok(card && card.suit === "hearts");
  assert.equal(card.mini_card_face.face, "K♥");
  assert.equal(projected.screen.focus_seat, "1");
  assert.equal(projected.screen.hero_seat, "1");
  assert.equal(
    projected.seat_piles.filter((pile) => pile.seat !== "1").every((pile) => pile.cards.length === 0),
    true,
  );

  const composition = projectRemainingComposition(events);
  assert.deepEqual(composition.remaining_by_rank, ranksBefore);
  assert.equal(composition.remaining_by_rank.find((slice) => slice.rank === "K")?.count, 31);
  assert.deepEqual(
    composition.remaining_by_suit.map((slice) => slice.count),
    [104, 104, 103, 104],
  );
  assert.equal(
    composition.remaining_by_rank_suit.find((cell) => cell.rank === "K" && cell.suit === "hearts")
      ?.count,
    7,
  );
  assert.equal(
    composition.remaining_by_rank_suit
      .filter((cell) => !(cell.rank === "K" && cell.suit === "hearts"))
      .every((cell) => cell.count === 8),
    true,
  );
  assert.equal(composition.outer_rank_ring.order, "A,2,3,4,5,6,7,8,9,10,J,Q,K");

  const moved = handle({
    method: "POST",
    path: SET_SUIT_PATH,
    body: { suit: "diamonds", seat: "1" },
  });
  const movedBody = ackBody(moved);
  assert.equal(movedBody.position, 4);
  assert.equal(movedBody.events[0]?.suit, "diamonds");
  const afterMove = store.read(TABLE_STREAM);
  const movedFelt = projectFeltTable(afterMove);
  const king = movedFelt.seat_piles.find((pile) => pile.seat === "1")?.cards[0];
  assert.ok(king && king.suit === "diamonds");
  assert.equal(king.mini_card_face.face, "K♦");
  const movedRemaining = projectRemainingComposition(afterMove);
  assert.deepEqual(movedRemaining.remaining_by_rank, ranksBefore);
  assert.deepEqual(
    movedRemaining.remaining_by_suit.map((slice) => slice.count),
    [104, 104, 104, 103],
  );
  assert.equal(
    movedRemaining.remaining_by_rank_suit.find((cell) => cell.rank === "K" && cell.suit === "hearts")
      ?.count,
    8,
  );
  assert.equal(
    movedRemaining.remaining_by_rank_suit.find(
      (cell) => cell.rank === "K" && cell.suit === "diamonds",
    )?.count,
    7,
  );
  assert.deepEqual(projectCountsInfoBar(afterMove), countsBefore);
});

test("POST set-suit without a real suit and seat is 400 and does not append", () => {
  const store = createInMemoryEventStore();
  start((request) => handleHttp(store, request));
  const before = store.read(TABLE_STREAM).length;
  for (const body of [
    undefined,
    {},
    { suit: "hearts" },
    { seat: "1" },
    { suit: "♥", seat: "1" },
    { suit: "Hearts", seat: "1" },
    { suit: "SPADES", seat: "1" },
    { suit: "hearts", seat: "dealer" },
    { suit: "hearts", seat: "8" },
    { suit: 1, seat: "1" },
    { suit: "hearts", seat: 1 },
  ]) {
    const response = handleHttp(store, {
      method: "POST",
      path: SET_SUIT_PATH,
      body,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: "suit_and_seat_required" });
  }
  assert.equal(store.read(TABLE_STREAM).length, before);
  const get = handleHttp(store, { method: "GET", path: SET_SUIT_PATH });
  assert.equal(get.status, 404);
});

test("GWT suit pad: press hearts on the last focus card paints the mini face and moves one suit unit", () => {
  const { store, calls, shell } = wired();
  const idle = shell.html();
  assert.deepEqual(
    suitButtons(idle),
    PAD.map(([suit, symbol]) => [suit, suit, symbol]),
  );
  assert.equal(SUIT_SYMBOL.hearts, "♥");
  assert.equal(shell.pressSuit("hearts").rejected, true);
  assert.equal(calls.length, 0);

  shell.pressNewShoe();
  assert.equal(shell.pressSuit("hearts").rejected, true);
  shell.pressRank("5");
  shell.pressRank("K");
  const before = store.read(TABLE_STREAM);
  const countsBefore = projectCountsInfoBar(before);
  const ranksBefore = projectRemainingComposition(before).remaining_by_rank;
  const infoBefore = shell.html().match(/<section id="infoBar"[\s\S]*<\/section>/)?.[0];
  calls.length = 0;

  const pressed = shell.pressSuit("hearts");
  assert.equal(pressed.rejected, false);
  if (pressed.rejected) return;

  assert.deepEqual(
    calls.map((call) => [call.method, call.path]),
    [
      ["POST", "/commands/set-suit"],
      ["GET", "/views/felt"],
      ["GET", "/views/counts"],
      ["GET", "/views/remaining"],
    ],
  );
  assert.deepEqual(calls[0]?.body, { suit: "hearts", seat: "1" });
  const post = ackBody(pressed.post);
  assert.equal(post.events[0]?.type, "card_suit_set");
  assert.equal(post.events[0]?.suit, "hearts");
  assert.equal(post.events[0]?.seat, "1");
  assert.equal(post.events[0] !== undefined && "rank" in post.events[0], false);
  assert.equal(post.position, 4);

  const events = store.read(TABLE_STREAM);
  const felt = projectFeltTable(events);
  const remaining = projectRemainingComposition(events);
  assert.deepEqual(felt.seat_piles.find((pile) => pile.seat === "1")?.cards[0], {
    rank: "5",
    suit: null,
  });
  const king = felt.seat_piles.find((pile) => pile.seat === "1")?.cards[1];
  assert.ok(king && king.suit === "hearts");
  assert.equal(king.mini_card_face.face, "K♥");
  assert.equal(felt.screen.focus_seat, "1");
  assert.equal(felt.screen.hero_seat, "1");
  assert.deepEqual(projectCountsInfoBar(events), countsBefore);
  assert.deepEqual(remaining.remaining_by_rank, ranksBefore);
  assert.equal(remaining.remaining_by_rank.find((slice) => slice.rank === "5")?.count, 31);
  assert.equal(remaining.remaining_by_rank.find((slice) => slice.rank === "K")?.count, 31);
  assert.equal(remaining.remaining_by_rank.find((slice) => slice.rank === "10")?.count, 32);
  assert.deepEqual(
    remaining.remaining_by_suit.map((slice) => slice.count),
    [104, 104, 103, 104],
  );
  assert.equal(
    remaining.remaining_by_rank_suit.find((cell) => cell.rank === "K" && cell.suit === "hearts")
      ?.count,
    7,
  );
  assert.equal(
    remaining.remaining_by_rank_suit.find((cell) => cell.rank === "5" && cell.suit === "hearts")
      ?.count,
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
    /<section class="seat" data-seat="1"><div class="seat-round active your-seat">1<\/div><div class="hand-total" style="color:#ffd43f">Total: 15<\/div><div class="hand" id="hand-1"><div class="mini rank-only" data-rank="5" data-suit="">5<\/div><div class="mini" data-rank="K" data-suit="hearts">K♥<\/div><\/div><\/section>/,
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
  assert.equal(html.match(/<section id="infoBar"[\s\S]*<\/section>/)?.[0], infoBefore);
  const json = html.match(
    /<script type="application\/json" id="combinedChart-data">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(json);
  assert.deepEqual(JSON.parse(json), remaining);
  assert.equal(JSON.parse(json).outer_rank_ring.order, "A,2,3,4,5,6,7,8,9,10,J,Q,K");
  assert.equal(/RoR|Wong|21\+3|Perfect Pair|sidebet|NEXT HAND|SPLIT|SURRENDER|Expert/i.test(html), false);

  calls.length = 0;
  const corrected = shell.pressSuit("diamonds");
  assert.equal(corrected.rejected, false);
  if (corrected.rejected) return;
  assert.deepEqual(calls[0]?.body, { suit: "diamonds", seat: "1" });
  const correctedEvents = store.read(TABLE_STREAM);
  const correctedRemaining = projectRemainingComposition(correctedEvents);
  assert.deepEqual(correctedRemaining.remaining_by_rank, ranksBefore);
  assert.deepEqual(
    correctedRemaining.remaining_by_suit.map((slice) => slice.count),
    [104, 104, 104, 103],
  );
  assert.equal(
    correctedRemaining.remaining_by_rank_suit.find(
      (cell) => cell.rank === "K" && cell.suit === "hearts",
    )?.count,
    8,
  );
  assert.equal(
    correctedRemaining.remaining_by_rank_suit.find(
      (cell) => cell.rank === "K" && cell.suit === "diamonds",
    )?.count,
    7,
  );
  assert.deepEqual(projectCountsInfoBar(correctedEvents), countsBefore);
  assert.match(
    corrected.html,
    /id="hand-1"><div class="mini rank-only" data-rank="5" data-suit="">5<\/div><div class="mini" data-rank="K" data-suit="diamonds">K♦<\/div><\/div>/,
  );
  assert.equal(corrected.html.includes("K♥"), false);
  assert.deepEqual(
    JSON.parse(
      corrected.html.match(
        /<script type="application\/json" id="combinedChart-data">([\s\S]*?)<\/script>/,
      )?.[1] ?? "null",
    ),
    correctedRemaining,
  );
});

test("GWT ten keeps a distinct rank and paints T with the suit", () => {
  const { store, shell } = wired();
  shell.pressNewShoe();
  shell.pressRank("10");
  const before = projectCountsInfoBar(store.read(TABLE_STREAM));
  const pressed = shell.pressSuit("spades");
  assert.equal(pressed.rejected, false);
  if (pressed.rejected) return;

  const events = store.read(TABLE_STREAM);
  const remaining = projectRemainingComposition(events);
  assert.equal(remaining.remaining_by_rank.find((slice) => slice.rank === "10")?.count, 31);
  assert.equal(remaining.remaining_by_rank.find((slice) => slice.rank === "J")?.count, 32);
  assert.equal(remaining.remaining_by_rank.find((slice) => slice.rank === "Q")?.count, 32);
  assert.equal(remaining.remaining_by_rank.find((slice) => slice.rank === "K")?.count, 32);
  assert.deepEqual(
    remaining.remaining_by_suit.map((slice) => slice.count),
    [103, 104, 104, 104],
  );
  assert.deepEqual(projectCountsInfoBar(events), before);
  assert.match(
    pressed.html,
    /id="hand-1"><div class="mini" data-rank="10" data-suit="spades">T♠<\/div><\/div>/,
  );
  assert.equal(pressed.html.includes(">10♠<"), false);
  assert.equal(pressed.html.includes(">T<"), false);
});

test("suit press before a card, or a suit that is not on the pad, does not post", () => {
  const { store, calls, shell } = wired();
  assert.equal(shell.pressSuit("clubs").rejected, true);
  assert.deepEqual(calls, []);
  assert.equal(store.read(TABLE_STREAM).length, 0);

  shell.pressNewShoe();
  calls.length = 0;
  assert.equal(shell.pressSuit("hearts").rejected, true);
  assert.equal(shell.pressSuit("♠").rejected, true);
  assert.deepEqual(calls, []);
  assert.equal(store.read(TABLE_STREAM).length, 1);

  shell.pressRank("K");
  calls.length = 0;
  assert.equal(shell.pressSuit("Hearts").rejected, true);
  assert.equal(shell.pressSuit("SPADES").rejected, true);
  assert.equal(shell.pressSuit("").rejected, true);
  assert.deepEqual(calls, []);
  assert.match(
    shell.html(),
    /id="hand-1"><div class="mini rank-only" data-rank="K" data-suit="">K<\/div><\/div>/,
  );

  shell.pressSuit("hearts");
  calls.length = 0;
  shell.pressNewShoe();
  const afterShoe = calls.length;
  assert.equal(shell.pressSuit("hearts").rejected, true);
  assert.equal(calls.length, afterShoe);
  assert.equal(
    store.read(TABLE_STREAM).at(-1)?.type,
    "shoe_started",
  );
  assert.equal(shell.html().includes("mini"), false);
});

test("set-suit boundary reuses setSuit and does not re-derive remaining or open a network server", () => {
  const httpSrc = readFileSync(new URL("../src/http/handle.ts", import.meta.url), "utf8");
  const shellSrc = readFileSync(
    new URL("../src/ui/new-shoe-shell.ts", import.meta.url),
    "utf8",
  );
  assert.match(httpSrc, /setSuit\(/);
  assert.match(httpSrc, /projectFeltTable\(/);
  assert.match(httpSrc, /projectCountsInfoBar\(/);
  assert.match(httpSrc, /projectRemainingComposition\(/);
  assert.equal(httpSrc.includes("pickSuit"), false);
  assert.equal(httpSrc.includes("runningAce"), false);
  assert.equal(httpSrc.includes("COUNT_MAPS"), false);
  assert.equal(httpSrc.includes("remaining_by_suit"), false);
  assert.equal(httpSrc.includes("node:http"), false);
  assert.equal(httpSrc.includes("createServer"), false);

  assert.match(shellSrc, /SET_SUIT_PATH/);
  assert.match(shellSrc, /id="suitGrid"/);
  assert.equal(shellSrc.includes("setSuit"), false);
  assert.equal(shellSrc.includes("observeCard"), false);
  assert.equal(shellSrc.includes("projectFeltTable"), false);
  assert.equal(shellSrc.includes("projectCountsInfoBar"), false);
  assert.equal(shellSrc.includes("projectRemainingComposition"), false);
  assert.equal(shellSrc.includes("pickSuit"), false);
  assert.equal(shellSrc.includes("runningAce"), false);
  assert.equal(shellSrc.includes("COUNT_MAPS"), false);
  assert.equal(shellSrc.includes("remaining_by_suit"), false);
  assert.equal(shellSrc.includes("node:http"), false);
  assert.equal(shellSrc.includes("createServer"), false);
});
