import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RANKS, SUITS } from "../src/counting/maps.ts";
import { pickSuit } from "../src/felt/pick-suit.ts";
import {
  COUNTS_PATH,
  FELT_PATH,
  OBSERVE_CARD_PATH,
  REMAINING_PATH,
  START_SHOE_PATH,
  handleHttp,
  type HttpRequest,
  type HttpResponse,
} from "../src/http/handle.ts";
import { SHOE_DECKS } from "../src/read/counts-info-bar.ts";
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
    }[];
    position: number;
  };
}

/** Same display rounding as the info bar. Not a second count engine. */
function fixed2(n: number): string {
  return n.toFixed(2);
}

/** Correct empty-shoe-relative formulas. Not acesLeft/(4·decksLeft)−1. */
function afterCards(dealt: number, acesSeen: number) {
  const cards = SHOE_DECKS * 52;
  const totalRemaining = cards - dealt;
  const decksLeft = Math.max(totalRemaining / 52, 0.01);
  const acesLeft = SHOE_DECKS * 4 - acesSeen;
  return {
    totalRemaining,
    decksLeft,
    acesLeft,
    ra: acesLeft / (32 * decksLeft) - 1,
    buggyRa: acesLeft / (4 * decksLeft) - 1,
    penetration: ((1 - totalRemaining / cards) * 100).toFixed(2),
  };
}

function start(handle: (request: HttpRequest) => HttpResponse) {
  const response = handle({
    method: "POST",
    path: START_SHOE_PATH,
    body: { decks: SHOE_DECKS },
  });
  assert.equal(response.status, 200);
}

test("POST /commands/observe-card is rank + seat and returns ack, events, position only", () => {
  assert.equal(OBSERVE_CARD_PATH, "/commands/observe-card");
  const store = createInMemoryEventStore();
  start((request) => handleHttp(store, request));

  const response = handleHttp(store, {
    method: "POST",
    path: OBSERVE_CARD_PATH,
    body: { rank: "K", seat: "D", suit: "hearts" },
  });
  const body = ackBody(response);
  assert.equal(body.events.length, 1);
  assert.equal(body.position, 2);
  assert.equal(body.position, body.events[0]?.position);
  const event = body.events[0];
  assert.ok(event);
  assert.equal(event.type, "card_observed");
  assert.equal(event.rank, "K");
  assert.equal(event.seat, "D");
  assert.equal("suit" in event, false);
  assert.deepEqual(Object.keys(event).sort(), ["position", "rank", "seat", "type"]);

  const events = store.read(TABLE_STREAM);
  assert.deepEqual(
    events.map((item) => item.type),
    ["shoe_started", "card_observed"],
  );
  const felt = handleHttp(store, { method: "GET", path: FELT_PATH });
  const counts = handleHttp(store, { method: "GET", path: COUNTS_PATH });
  const remaining = handleHttp(store, { method: "GET", path: REMAINING_PATH });
  assert.deepEqual(felt.body, projectFeltTable(events));
  assert.deepEqual(counts.body, projectCountsInfoBar(events));
  assert.deepEqual(remaining.body, projectRemainingComposition(events));

  const projected = projectFeltTable(events);
  assert.deepEqual(
    projected.seat_piles.find((pile) => pile.seat === "D")?.cards,
    [{ rank: "K", suit: null }],
  );
  assert.equal(
    projected.seat_piles.filter((pile) => pile.seat !== "D").every((pile) => pile.cards.length === 0),
    true,
  );
  assert.equal(projected.screen.focus_seat, "1");
  assert.equal(projected.screen.hero_seat, "1");

  const composition = projectRemainingComposition(events);
  assert.equal(composition.remaining_by_rank.find((slice) => slice.rank === "K")?.count, 31);
  assert.equal(composition.remaining_by_rank.find((slice) => slice.rank === "10")?.count, 32);
  assert.equal(composition.remaining_by_rank.find((slice) => slice.rank === "Q")?.count, 32);
  assert.equal(composition.remaining_by_rank.find((slice) => slice.rank === "J")?.count, 32);
  assert.deepEqual(
    composition.remaining_by_suit.map((slice) => slice.count),
    [104, 104, 104, 104],
  );
  assert.equal(
    composition.remaining_by_rank_suit.every((cell) => cell.count === 8),
    true,
  );
});

test("POST observe-card without a real rank and seat is 400 and does not append", () => {
  const store = createInMemoryEventStore();
  start((request) => handleHttp(store, request));
  const before = store.read(TABLE_STREAM).length;
  for (const body of [
    undefined,
    {},
    { rank: "A" },
    { seat: "1" },
    { rank: "T", seat: "1" },
    { rank: "A", seat: "dealer" },
    { rank: "A", seat: "8" },
    { rank: 10, seat: "1" },
    { rank: "A", seat: 1 },
  ]) {
    const response = handleHttp(store, {
      method: "POST",
      path: OBSERVE_CARD_PATH,
      body,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: "rank_and_seat_required" });
  }
  assert.equal(store.read(TABLE_STREAM).length, before);
  const get = handleHttp(store, { method: "GET", path: OBSERVE_CARD_PATH });
  assert.equal(get.status, 404);
});

test("GWT rank pad: press A on focus seat 1 paints rank only and moves counts, pen, RA, and the outer ring", () => {
  const { store, calls, shell } = wired();
  const idle = shell.html();
  assert.match(idle, /id="cardsGrid"/);
  assert.deepEqual(
    [...idle.matchAll(/<button type="button" data-rank="([^"]+)">([^<]*)<\/button>/g)].map(
      (match) => [match[1], match[2]],
    ),
    RANKS.map((rank) => [rank, rank]),
  );
  assert.equal(shell.pressRank("A").rejected, true);
  assert.equal(calls.length, 0);

  const started = shell.pressNewShoe();
  assert.equal(started.cancelled, false);
  calls.length = 0;

  const pressed = shell.pressRank("A");
  assert.equal(pressed.rejected, false);
  if (pressed.rejected) return;

  assert.deepEqual(
    calls.map((call) => [call.method, call.path]),
    [
      ["POST", "/commands/observe-card"],
      ["GET", "/views/felt"],
      ["GET", "/views/counts"],
      ["GET", "/views/remaining"],
    ],
  );
  assert.deepEqual(calls[0]?.body, { rank: "A", seat: "1" });

  const post = ackBody(pressed.post);
  assert.equal(post.events.length, 1);
  assert.equal(post.events[0]?.type, "card_observed");
  assert.equal(post.events[0]?.rank, "A");
  assert.equal(post.events[0]?.seat, "1");
  assert.equal(post.events[0] !== undefined && "suit" in post.events[0], false);
  assert.equal(post.position, 2);

  const events = store.read(TABLE_STREAM);
  const felt = projectFeltTable(events);
  const counts = projectCountsInfoBar(events);
  const remaining = projectRemainingComposition(events);
  const math = afterCards(1, 1);

  assert.deepEqual(felt.seat_piles.find((pile) => pile.seat === "1")?.cards, [
    { rank: "A", suit: null },
  ]);
  assert.equal(felt.screen.focus_seat, "1");
  assert.equal(felt.screen.hero_seat, "1");
  assert.equal(felt.hand_totals.find((total) => total.seat === "1")?.total, 11);

  assert.equal(counts.acesLeft, math.acesLeft);
  assert.equal(counts.acesLeft, 31);
  assert.equal(counts.decksLeft, math.decksLeft);
  assert.equal(counts.ra.numeric, math.ra);
  assert.notEqual(counts.ra.numeric, math.buggyRa);
  assert.equal(counts.ra.value, fixed2(math.ra));
  assert.equal(counts.ra.className, "negative");
  assert.equal(counts.ra.colour, "#ef4444");
  assert.equal(counts.penetration, `P: ${math.penetration}%`);
  assert.equal(counts.decks_left, `D: ${math.decksLeft.toFixed(2)}`);
  assert.equal(counts.hilo_rc, -1);
  assert.equal(counts.hilo_display, `Hi-Lo: -1 / ${fixed2(-1 / math.decksLeft)}`);
  assert.equal(counts.apc_tc, `APC: ${fixed2(0)}`);
  assert.equal(counts.zen_tc, `Zen: ${fixed2(-1 / math.decksLeft)}`);
  assert.equal(counts.omega_ii_tc, "Omega II: 0.00");
  assert.notEqual(counts.omega_ii_tc, `Omega II: ${fixed2(-2 / math.decksLeft)}`);
  assert.equal(counts.ace_tc, `Ace: ${fixed2(counts.acesLeft / math.decksLeft - 4)}`);
  assert.equal(counts.ace_tc, "Ace: -0.12");
  assert.notEqual(counts.ace_tc, `Ace: ${fixed2(-1 / math.decksLeft)}`);
  assert.notEqual(counts.ra.numeric, -0.875);
  assert.notEqual(counts.hilo_rc, 0);

  assert.equal(remaining.remaining_by_rank.find((slice) => slice.rank === "A")?.count, 31);
  for (const rank of RANKS) {
    if (rank === "A") continue;
    assert.equal(
      remaining.remaining_by_rank.find((slice) => slice.rank === rank)?.count,
      32,
      rank,
    );
  }
  assert.deepEqual(
    remaining.remaining_by_suit.map((slice) => slice.count),
    [104, 104, 104, 104],
  );
  assert.equal(
    remaining.remaining_by_rank_suit.every((cell) => cell.count === 8),
    true,
  );

  const html = pressed.html;
  assert.equal(shell.html(), html);
  assert.deepEqual(
    [...html.matchAll(/data-seat="([^"]+)"/g)].map((match) => match[1]),
    SEATS,
  );
  assert.match(
    html,
    /<section class="seat" data-seat="1"><div class="seat-round active your-seat">1<\/div><div class="hand-total" style="color:#ffd43f">Total: 11<\/div><div class="hand" id="hand-1"><div class="mini rank-only" data-rank="A" data-suit=""><span class="corner top-left">A<\/span><span class="corner bottom-right">A<\/span><\/div><\/div><\/section>/,
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
  const table = html.match(/<div id="table">([\s\S]*?)<\/div>\n<section id="infoBar"/)?.[1];
  assert.ok(table);
  assert.equal(/[♠♥♦♣]/.test(table), false);
  assert.equal(table.includes("data-suit=\"hearts\""), false);
  assert.equal(table.includes("data-suit=\"spades\""), false);

  for (const text of [
    counts.penetration,
    counts.decks_left,
    `${counts.ra.label} ${counts.ra.value}`,
    counts.ra.value,
    counts.hilo_display,
    counts.apc_tc,
    counts.zen_tc,
    counts.omega_ii_tc,
    counts.ace_tc,
  ]) {
    assert.equal(html.includes(text), true, text);
  }
  const ra = html.match(/<span id="ra"[^>]*>[^<]*<\/span>/)?.[0];
  assert.ok(ra);
  assert.match(ra, /class="negative"/);
  assert.match(ra, /#ef4444/);
  assert.match(ra, new RegExp(`data-value="${counts.ra.value}"`));

  const json = html.match(
    /<script type="application\/json" id="combinedChart-data">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(json);
  assert.deepEqual(JSON.parse(json), remaining);
  assert.equal(JSON.parse(json).outer_rank_ring.order, "A,2,3,4,5,6,7,8,9,10,J,Q,K");
  assert.equal(/RoR|Wong|21\+3|Perfect Pair|sidebet|SPLIT|SURRENDER/i.test(html), false);
});

test("GWT king is not a ten, and a second rank press stays on focus seat 1", () => {
  const { store, calls, shell } = wired();
  shell.pressNewShoe();
  calls.length = 0;

  const king = shell.pressRank("K");
  assert.equal(king.rejected, false);
  if (king.rejected) return;
  assert.deepEqual(calls[0]?.body, { rank: "K", seat: "1" });

  const math = afterCards(1, 0);
  const counts = projectCountsInfoBar(store.read(TABLE_STREAM));
  const remaining = projectRemainingComposition(store.read(TABLE_STREAM));
  assert.equal(counts.acesLeft, 32);
  assert.equal(counts.hilo_rc, -1);
  assert.equal(counts.ra.numeric, math.ra);
  assert.notEqual(counts.ra.numeric, math.buggyRa);
  assert.equal(counts.zen_tc, `Zen: ${fixed2(-2 / math.decksLeft)}`);
  assert.equal(counts.apc_tc, `APC: ${fixed2(-3 / math.decksLeft)}`);
  assert.equal(counts.apc_tc, "APC: -0.38");
  assert.notEqual(counts.apc_tc, `APC: ${fixed2(-4 / math.decksLeft)}`);
  assert.equal(counts.omega_ii_tc, `Omega II: ${fixed2(-2 / math.decksLeft)}`);
  assert.equal(counts.ace_tc, `Ace: ${(counts.acesLeft / math.decksLeft - 4).toFixed(2)}`);
  assert.equal(counts.ace_tc, "Ace: 0.01");
  assert.notEqual(counts.ace_tc, "Ace: +0.01");
  assert.equal(remaining.remaining_by_rank.find((slice) => slice.rank === "K")?.count, 31);
  assert.equal(remaining.remaining_by_rank.find((slice) => slice.rank === "10")?.count, 32);
  assert.equal(remaining.remaining_by_rank.find((slice) => slice.rank === "Q")?.count, 32);
  assert.equal(remaining.remaining_by_rank.find((slice) => slice.rank === "J")?.count, 32);
  assert.deepEqual(
    remaining.remaining_by_suit.map((slice) => slice.count),
    [104, 104, 104, 104],
  );
  assert.match(
    king.html,
    /id="hand-1"><div class="mini rank-only" data-rank="K" data-suit=""><span class="corner top-left">K<\/span><span class="corner bottom-right">K<\/span><\/div><\/div>/,
  );
  assert.equal(king.html.includes(">T<"), false);
  assert.equal(king.html.includes('data-rank="10"'), true);

  calls.length = 0;
  const five = shell.pressRank("5");
  assert.equal(five.rejected, false);
  if (five.rejected) return;
  assert.deepEqual(calls[0]?.body, { rank: "5", seat: "1" });
  assert.deepEqual(
    calls.map((call) => [call.method, call.path]),
    [
      ["POST", "/commands/observe-card"],
      ["GET", "/views/felt"],
      ["GET", "/views/counts"],
      ["GET", "/views/remaining"],
    ],
  );

  const felt = projectFeltTable(store.read(TABLE_STREAM));
  assert.deepEqual(felt.seat_piles.find((pile) => pile.seat === "1")?.cards, [
    { rank: "K", suit: null },
    { rank: "5", suit: null },
  ]);
  assert.equal(
    felt.seat_piles.find((pile) => pile.seat === "2")?.cards.length,
    0,
  );
  assert.equal(felt.screen.focus_seat, "1");
  assert.equal(felt.screen.hero_seat, "1");
  assert.equal(felt.hand_totals.find((total) => total.seat === "1")?.total, 15);
  assert.match(
    five.html,
    /id="hand-1"><div class="mini rank-only" data-rank="K" data-suit=""><span class="corner top-left">K<\/span><span class="corner bottom-right">K<\/span><\/div><div class="mini rank-only" data-rank="5" data-suit=""><span class="corner top-left">5<\/span><span class="corner bottom-right">5<\/span><\/div><\/div>/,
  );
  assert.match(five.html, /class="seat-round active your-seat">1</);
  assert.equal(five.html.match(/seat-round active/g)?.length, 1);
  const later = projectRemainingComposition(store.read(TABLE_STREAM));
  assert.equal(later.remaining_by_rank.find((slice) => slice.rank === "K")?.count, 31);
  assert.equal(later.remaining_by_rank.find((slice) => slice.rank === "5")?.count, 31);
  assert.equal(later.remaining_by_rank.find((slice) => slice.rank === "10")?.count, 32);
  assert.deepEqual(
    later.remaining_by_suit.map((slice) => slice.count),
    [104, 104, 104, 104],
  );
});

test("rank press before a shoe, or a rank that is not on the pad, does not post", () => {
  const store = createInMemoryEventStore();
  const calls: HttpRequest[] = [];
  const shell = createNewShoeShell(
    (request) => {
      calls.push(request);
      return handleHttp(store, request);
    },
    () => false,
  );
  assert.deepEqual(shell.pressNewShoe(), { cancelled: true });
  assert.equal(shell.pressRank("5").rejected, true);
  assert.equal(shell.pressRank("T").rejected, true);
  assert.deepEqual(calls, []);
  assert.equal(store.read(TABLE_STREAM).length, 0);

  const live = wired();
  live.shell.pressNewShoe();
  live.calls.length = 0;
  assert.equal(live.shell.pressRank("T").rejected, true);
  assert.equal(live.shell.pressRank("dealer").rejected, true);
  assert.deepEqual(live.calls, []);
  assert.equal(live.store.read(TABLE_STREAM).length, 1);
  assert.equal(live.shell.html().includes("rank-only"), false);
});

test("observe-card boundary and shell do not re-derive counts or open a network server", () => {
  const httpSrc = readFileSync(new URL("../src/http/handle.ts", import.meta.url), "utf8");
  const shellSrc = readFileSync(
    new URL("../src/ui/new-shoe-shell.ts", import.meta.url),
    "utf8",
  );
  assert.match(httpSrc, /observeCard\(/);
  assert.match(httpSrc, /splitHand\(/);
  assert.match(httpSrc, /projectFeltTable\(/);
  assert.match(httpSrc, /projectCountsInfoBar\(/);
  assert.match(httpSrc, /projectRemainingComposition\(/);
  assert.match(httpSrc, /withdrawCard\(/);
  assert.match(httpSrc, /completeHand\(/);
  assert.equal(httpSrc.includes("runningAce"), false);
  assert.equal(httpSrc.includes("COUNT_MAPS"), false);
  assert.equal(httpSrc.includes("pickSuit"), false);
  assert.equal(httpSrc.includes("node:http"), false);
  assert.equal(httpSrc.includes("createServer"), false);

  assert.match(shellSrc, /OBSERVE_CARD_PATH/);
  assert.equal(shellSrc.includes("observeCard"), false);
  assert.equal(shellSrc.includes("projectFeltTable"), false);
  assert.equal(shellSrc.includes("projectCountsInfoBar"), false);
  assert.equal(shellSrc.includes("projectRemainingComposition"), false);
  assert.equal(shellSrc.includes("setSuit"), false);
  assert.equal(shellSrc.includes("pickSuit"), false);
  assert.equal(shellSrc.includes("runningAce"), false);
  assert.equal(shellSrc.includes("COUNT_MAPS"), false);
  assert.equal(shellSrc.includes("node:http"), false);
  assert.equal(shellSrc.includes("createServer"), false);

  const pageSrc = readFileSync(
    new URL("../src/pages/new-shoe-page.ts", import.meta.url),
    "utf8",
  );
  assert.match(pageSrc, /pickSuit\(/);
  assert.match(pageSrc, /pickSuitRandom/);
  assert.equal(pageSrc.includes("projectRemainingComposition"), false);
  assert.equal(pageSrc.includes("Math.random"), true);
});

test("pickSuit walks original suit order against the live rank×suit counts", () => {
  const full = projectRemainingComposition([
    { type: "shoe_started", decks: 8 },
  ]).remaining_by_rank_suit;
  assert.deepEqual(SUITS, ["spades", "hearts", "diamonds", "clubs"]);
  assert.equal(pickSuit("K", full, () => 0), "spades");
  assert.equal(pickSuit("K", full, () => 0.99), "clubs");

  const empty = full.map((cell) =>
    cell.rank === "K" ? { ...cell, count: 0 } : cell,
  );
  assert.equal(pickSuit("K", empty, () => 0.5), "spades");

  const noSpades = full.map((cell) =>
    cell.rank === "K" && cell.suit === "spades" ? { ...cell, count: 0 } : cell,
  );
  assert.equal(pickSuit("K", noSpades, () => 0.01), "hearts");
});
