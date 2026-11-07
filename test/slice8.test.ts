import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  COUNTS_PATH,
  FELT_PATH,
  REMAINING_PATH,
  START_SHOE_PATH,
  handleHttp,
  type HttpRequest,
  type HttpResponse,
} from "../src/http/handle.ts";
import {
  SHOE_DECKS,
  projectCountsInfoBar,
} from "../src/read/counts-info-bar.ts";
import { projectFeltTable } from "../src/read/felt-table.ts";
import { projectRemainingComposition } from "../src/read/remaining-composition.ts";
import {
  NEW_SHOE_CONFIRM,
  createNewShoeShell,
} from "../src/ui/new-shoe-shell.ts";
import {
  TABLE_STREAM,
  createInMemoryEventStore,
} from "../src/write/in-memory-store.ts";
import { observeCard } from "../src/write/observe-card.ts";
import { setSuit } from "../src/write/set-suit.ts";
import { splitHand } from "../src/write/split-hand.ts";

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
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
    events: { type: string; position: number; decks?: number }[];
    position: number;
  };
}

test("HTTP paths are the start-shoe command and the three view queries", () => {
  assert.equal(START_SHOE_PATH, "/commands/start-shoe");
  assert.equal(FELT_PATH, "/views/felt");
  assert.equal(COUNTS_PATH, "/views/counts");
  assert.equal(REMAINING_PATH, "/views/remaining");
  assert.equal(NEW_SHOE_CONFIRM, "Start fresh 8-deck shoe?");
  assert.equal(SHOE_DECKS, 8);
});

test("POST start_shoe returns ack, events, and position — not a view", () => {
  const store = createInMemoryEventStore();
  const response = handleHttp(store, {
    method: "POST",
    path: START_SHOE_PATH,
    body: { decks: 8 },
  });
  const body = ackBody(response);
  assert.deepEqual(
    body.events.map((event) => event.type),
    ["shoe_started"],
  );
  assert.equal(body.events[0]?.decks, 8);
  assert.equal(body.position, 1);
  assert.equal(body.position, body.events.at(-1)?.position);
  for (const key of [
    "seat_piles",
    "hand_totals",
    "penetration",
    "ra",
    "hilo_rc",
    "remaining_by_rank",
    "remaining_by_suit",
    "mini_card_face",
  ]) {
    assert.equal(key in body, false, key);
  }
});

test("POST without decks is 400 and does not append", () => {
  const store = createInMemoryEventStore();
  const missing = handleHttp(store, { method: "POST", path: START_SHOE_PATH });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body, { error: "decks_required" });
  assert.equal(store.read(TABLE_STREAM).length, 0);

  const wrong = handleHttp(store, {
    method: "POST",
    path: START_SHOE_PATH,
    body: { decks: "8" },
  });
  assert.equal(wrong.status, 400);
  assert.equal(store.read(TABLE_STREAM).length, 0);
});

test("unknown routes and out-of-slice commands are 404", () => {
  const store = createInMemoryEventStore();
  for (const request of [
    { method: "GET" as const, path: "/commands/observe-card" },
    { method: "GET" as const, path: "/commands/complete-hand" },
    { method: "GET" as const, path: "/nope" },
    { method: "GET" as const, path: START_SHOE_PATH },
  ]) {
    const response = handleHttp(store, request);
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: "not_found" });
  }
  assert.equal(store.read(TABLE_STREAM).length, 0);
});

test("GET felt, counts, and remaining are the domain projections", () => {
  const store = createInMemoryEventStore();
  handleHttp(store, {
    method: "POST",
    path: START_SHOE_PATH,
    body: { decks: 8 },
  });
  const events = store.read(TABLE_STREAM);

  const felt = handleHttp(store, { method: "GET", path: FELT_PATH });
  const counts = handleHttp(store, { method: "GET", path: COUNTS_PATH });
  const remaining = handleHttp(store, { method: "GET", path: REMAINING_PATH });

  assert.equal(felt.status, 200);
  assert.equal(counts.status, 200);
  assert.equal(remaining.status, 200);
  assert.deepEqual(felt.body, projectFeltTable(events));
  assert.deepEqual(counts.body, projectCountsInfoBar(events));
  assert.deepEqual(remaining.body, projectRemainingComposition(events));
});

test("GWT first NEW SHOE paints empty felt, RA −0.875, full 8-deck donut", () => {
  const { calls, shell } = wired();
  const idle = shell.html();
  assert.match(idle, /id="shuffleBtn"/);
  assert.match(idle, />NEW SHOE</);
  assert.equal(idle.includes("-0.875"), false);
  assert.equal(idle.includes("data-seat"), false);
  assert.match(idle, />RA: -0\.88</);
  assert.match(idle, /data-tip="A: 32"/);
  assert.equal(idle.includes("combinedChart-data"), true);
  assert.equal(/RoR|Wong|21\+3|sidebet|SPLIT/i.test(idle), false);

  const pressed = shell.pressNewShoe();
  assert.equal(pressed.cancelled, false);
  if (pressed.cancelled) return;

  assert.deepEqual(
    calls.map((call) => [call.method, call.path]),
    [
      ["POST", "/commands/start-shoe"],
      ["GET", "/views/felt"],
      ["GET", "/views/counts"],
      ["GET", "/views/remaining"],
    ],
  );
  assert.deepEqual(calls[0]?.body, { decks: 8 });

  const post = ackBody(pressed.post);
  assert.deepEqual(
    post.events.map((event) => event.type),
    ["shoe_started"],
  );
  assert.equal(
    post.events.some((event) => event.type === "hand_completed"),
    false,
  );

  const html = pressed.html;
  assert.equal(shell.html(), html);

  const counts = projectCountsInfoBar([{ type: "shoe_started", decks: 8 }]);
  assert.equal(counts.acesLeft, 32);
  assert.equal(counts.decksLeft, 8);
  assert.equal(counts.ra.numeric, counts.acesLeft / (32 * counts.decksLeft) - 1);
  assert.equal(counts.ra.numeric, -0.875);
  assert.notEqual(counts.ra.numeric, counts.acesLeft / (4 * counts.decksLeft) - 1);
  assert.equal(counts.ra.value, "-0.88");
  assert.equal(counts.ra.className, "negative");
  assert.equal(counts.ra.colour, "#ef4444");
  assert.equal(counts.penetration, "P: 0.00%");
  assert.equal(counts.decks_left, "D: 8.00");
  assert.equal(counts.hilo_rc, 0);
  assert.equal(counts.hilo_tc, "+0.00");
  assert.equal(counts.hilo_display, "Hi-Lo: 0 / +0.00");
  assert.equal(counts.apc_tc, "APC: +0.00");
  assert.equal(counts.zen_tc, "Zen: +0.00");
  assert.equal(counts.omega_ii_tc, "Omega II: +0.00");
  assert.equal(counts.ace_tc, "Ace: +0.00");

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
  assert.equal(html.match(/active/g)?.length, 1);
  assert.equal(html.match(/your-seat/g)?.length, 1);
  assert.equal(html.includes("mini"), false);
  assert.equal(html.includes("Total:"), false);

  const ra = html.match(/<span id="ra"[^>]*>[^<]*<\/span>/)?.[0];
  assert.ok(ra);
  assert.match(ra, /class="negative"/);
  assert.match(ra, /#ef4444/);
  assert.match(ra, /data-value="-0\.88"/);
  assert.match(ra, />RA: -0\.88</);
  for (const text of [
    counts.penetration,
    counts.decks_left,
    counts.hilo_display,
    counts.apc_tc,
    counts.zen_tc,
    counts.omega_ii_tc,
    counts.ace_tc,
    counts.panel_chrome.bg,
    counts.panel_chrome.id,
    "flex space-evenly",
    "3-col center",
  ]) {
    assert.equal(html.includes(text), true, text);
  }
  assert.match(html, /id="infoBar"/);
  assert.match(html, /id="penetration"/);
  assert.match(html, /id="decksLeft"/);

  const json = html.match(
    /<script type="application\/json" id="combinedChart-data">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(json);
  const donut = JSON.parse(json);
  const remaining = projectRemainingComposition([
    { type: "shoe_started", decks: 8 },
  ]);
  assert.deepEqual(donut, remaining);
  assert.deepEqual(
    donut.remaining_by_rank.map((slice: { rank: string }) => slice.rank),
    RANKS,
  );
  assert.deepEqual(
    donut.remaining_by_rank.map((slice: { count: number }) => slice.count),
    Array(13).fill(32),
  );
  assert.deepEqual(
    donut.remaining_by_suit.map((slice: { suit: string }) => slice.suit),
    ["spades", "clubs", "hearts", "diamonds"],
  );
  assert.deepEqual(
    donut.remaining_by_suit.map((slice: { count: number }) => slice.count),
    [104, 104, 104, 104],
  );
  assert.equal(donut.remaining_by_rank_suit.length, 52);
  assert.equal(
    donut.remaining_by_rank_suit.every((cell: { count: number }) => cell.count === 8),
    true,
  );
  assert.equal(donut.chart_host.id, "#combinedChart");
  assert.match(html, /id="combinedChart"/);
  assert.equal(donut.outer_rank_ring.order, "A,2,3,4,5,6,7,8,9,10,J,Q,K");
  assert.deepEqual(donut.inner_suit_pie.symbols, ["♠", "♣", "♥", "♦"]);
  assert.equal(html.match(/class="rank-label"[^>]*>32<\/text>/g)?.length, 13);
  assert.equal(html.match(/<svg\b/g)?.length, 1);
  assert.equal(html.match(/class="rank-path"/g)?.length, 13);
  assert.equal(html.match(/class="suit-slice"/g)?.length, 4);
  for (const symbol of ["♠", "♣", "♥", "♦"]) {
    assert.match(html, new RegExp(`data-tip="${symbol}: 104"`));
  }
  assert.match(html, /data-tip="A: 32"/);
  assert.match(html, /data-tip="10: 32"/);

  assert.equal(/RoR|Wong|21\+3|Perfect Pair|sidebet|SPLIT|SURRENDER/i.test(html), false);
});

test("cancelled NEW SHOE does not call the boundary", () => {
  const store = createInMemoryEventStore();
  const calls: HttpRequest[] = [];
  let seen = "";
  const shell = createNewShoeShell(
    (request) => {
      calls.push(request);
      return handleHttp(store, request);
    },
    (message) => {
      seen = message;
      return false;
    },
  );
  const result = shell.pressNewShoe();
  assert.deepEqual(result, { cancelled: true });
  assert.equal(seen, "Start fresh 8-deck shoe?");
  assert.deepEqual(calls, []);
  assert.equal(store.read(TABLE_STREAM).length, 0);
  assert.equal(shell.html().includes("-0.875"), false);
});

test("GWT mid-shoe NEW SHOE emits hand_completed then shoe_started and repaints empty", () => {
  const { store, calls, shell } = wired();
  shell.pressNewShoe();
  observeCard(store, { rank: "A", seat: "1" });
  setSuit(store, { suit: "hearts", seat: "1" });

  const dirtyCounts = projectCountsInfoBar(store.read(TABLE_STREAM));
  const dirtyRemaining = projectRemainingComposition(store.read(TABLE_STREAM));
  assert.notEqual(dirtyCounts.ra.numeric, -0.875);
  assert.equal(
    dirtyRemaining.remaining_by_rank.find((slice) => slice.rank === "A")?.count,
    31,
  );
  assert.equal(
    projectFeltTable(store.read(TABLE_STREAM)).seat_piles.find((pile) => pile.seat === "1")
      ?.cards.length,
    1,
  );

  calls.length = 0;
  const pressed = shell.pressNewShoe();
  assert.equal(pressed.cancelled, false);
  if (pressed.cancelled) return;

  const post = ackBody(pressed.post);
  assert.deepEqual(
    post.events.map((event) => event.type),
    ["hand_completed", "shoe_started"],
  );
  assert.equal(post.events[0]?.type, "hand_completed");
  assert.deepEqual(Object.keys(post.events[0] ?? {}).sort(), ["position", "type"]);
  assert.equal(post.events[1]?.decks, 8);
  assert.equal(post.position, post.events[1]?.position);
  assert.equal(post.events.length, 2);

  assert.deepEqual(
    store.read(TABLE_STREAM).map((event) => event.type),
    [
      "shoe_started",
      "card_observed",
      "card_suit_set",
      "hand_completed",
      "shoe_started",
    ],
  );

  const events = store.read(TABLE_STREAM);
  assert.deepEqual(projectFeltTable(events).seat_piles.every((pile) => pile.cards.length === 0), true);
  assert.deepEqual(projectFeltTable(events).hand_totals, []);
  assert.deepEqual(projectFeltTable(events).split_piles, []);
  assert.equal(projectFeltTable(events).screen.focus_seat, "1");
  assert.equal(projectFeltTable(events).screen.hero_seat, "1");

  const counts = projectCountsInfoBar(events);
  assert.equal(counts.ra.numeric, -0.875);
  assert.equal(counts.ra.numeric, counts.acesLeft / (32 * counts.decksLeft) - 1);
  assert.equal(counts.hilo_rc, 0);

  const remaining = projectRemainingComposition(events);
  assert.equal(
    remaining.remaining_by_rank.every((slice) => slice.count === 32),
    true,
  );
  assert.equal(
    remaining.remaining_by_suit.every((slice) => slice.count === 104),
    true,
  );

  assert.match(pressed.html, />RA: -0\.88</);
  assert.equal(pressed.html.includes("mini"), false);
  assert.equal(pressed.html.includes("Total:"), false);
  const json = pressed.html.match(
    /<script type="application\/json" id="combinedChart-data">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(json);
  assert.deepEqual(JSON.parse(json), remaining);
  assert.deepEqual(
    calls.map((call) => [call.method, call.path]),
    [
      ["POST", "/commands/start-shoe"],
      ["GET", "/views/felt"],
      ["GET", "/views/counts"],
      ["GET", "/views/remaining"],
    ],
  );
});

test("GWT start_shoe_mid_shoe_reshuffle: populated split A/B resets felt, counts, and remaining", () => {
  const store = createInMemoryEventStore();
  const first = handleHttp(store, {
    method: "POST",
    path: START_SHOE_PATH,
    body: { decks: 8 },
  });
  ackBody(first);
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "hearts", seat: "1" });
  observeCard(store, { rank: "K", seat: "1" });
  setSuit(store, { suit: "spades", seat: "1" });
  const split = splitHand(store, { seat: "1" });
  assert.deepEqual(
    split.events.map((event) => event.type),
    ["hand_split"],
  );

  const dealt = projectFeltTable(store.read(TABLE_STREAM));
  assert.deepEqual(
    dealt.split_piles.map((pile) => ({
      hand: pile.hand,
      face:
        pile.cards[0] && pile.cards[0].suit
          ? pile.cards[0].mini_card_face.face
          : pile.cards[0]?.rank,
      total: dealt.hand_totals.find((total) => total.hand === pile.hand)?.total,
    })),
    [
      { hand: "A", face: "K♥", total: 10 },
      { hand: "B", face: "K♠", total: 10 },
    ],
  );
  assert.notEqual(projectCountsInfoBar(store.read(TABLE_STREAM)).ra.numeric, -0.875);
  assert.equal(
    projectRemainingComposition(store.read(TABLE_STREAM)).remaining_by_rank.find(
      (slice) => slice.rank === "K",
    )?.count,
    30,
  );

  const reshuffle = handleHttp(store, {
    method: "POST",
    path: START_SHOE_PATH,
    body: { decks: 8 },
  });
  const post = ackBody(reshuffle);
  assert.deepEqual(
    post.events.map((event) => event.type),
    ["hand_completed", "shoe_started"],
  );
  assert.equal(post.events[1]?.decks, 8);
  assert.equal(
    store.read(TABLE_STREAM).some((event) => event.type === "hand_completed"),
    true,
  );

  const events = store.read(TABLE_STREAM);
  const felt = handleHttp(store, { method: "GET", path: FELT_PATH });
  const counts = handleHttp(store, { method: "GET", path: COUNTS_PATH });
  const remaining = handleHttp(store, { method: "GET", path: REMAINING_PATH });
  assert.deepEqual(felt.body, projectFeltTable(events));
  assert.deepEqual(counts.body, projectCountsInfoBar(events));
  assert.deepEqual(remaining.body, projectRemainingComposition(events));

  const feltBody = felt.body as ReturnType<typeof projectFeltTable>;
  assert.deepEqual(feltBody.split_piles, []);
  assert.deepEqual(feltBody.hand_totals, []);
  assert.equal(
    feltBody.seat_piles.every((pile) => pile.cards.length === 0),
    true,
  );
  assert.equal(feltBody.seat_order, "D,7,6,5,4,3,2,1");

  const countsBody = counts.body as ReturnType<typeof projectCountsInfoBar>;
  assert.equal(countsBody.penetration, "P: 0.00%");
  assert.equal(countsBody.decks_left, "D: 8.00");
  assert.equal(countsBody.ra.numeric, -0.875);
  assert.equal(
    countsBody.ra.numeric,
    countsBody.acesLeft / (32 * countsBody.decksLeft) - 1,
  );
  assert.equal(countsBody.ra.value, "-0.88");
  assert.equal(countsBody.ra.colour, "#ef4444");
  assert.equal(countsBody.hilo_rc, 0);
  assert.equal(countsBody.hilo_display, "Hi-Lo: 0 / +0.00");
  assert.equal(countsBody.apc_tc, "APC: +0.00");
  assert.equal(countsBody.zen_tc, "Zen: +0.00");
  assert.equal(countsBody.omega_ii_tc, "Omega II: +0.00");
  assert.equal(countsBody.ace_tc, "Ace: +0.00");

  const remainingBody = remaining.body as ReturnType<typeof projectRemainingComposition>;
  assert.equal(
    remainingBody.remaining_by_rank.every((slice) => slice.count === 32),
    true,
  );
  assert.equal(
    remainingBody.remaining_by_suit.every((slice) => slice.count === 104),
    true,
  );
  assert.equal(
    remainingBody.remaining_by_rank_suit.every((cell) => cell.count === 8),
    true,
  );
});

test("boundary and shell do not re-derive counts or open a network server", () => {
  const httpSrc = readFileSync(new URL("../src/http/handle.ts", import.meta.url), "utf8");
  const shellSrc = readFileSync(
    new URL("../src/ui/new-shoe-shell.ts", import.meta.url),
    "utf8",
  );
  assert.match(httpSrc, /startShoe\(/);
  assert.match(httpSrc, /projectFeltTable\(/);
  assert.match(httpSrc, /projectCountsInfoBar\(/);
  assert.match(httpSrc, /projectRemainingComposition\(/);
  assert.equal(httpSrc.includes("runningAce"), false);
  assert.equal(httpSrc.includes("COUNT_MAPS"), false);
  assert.equal(httpSrc.includes("32 *"), false);
  assert.equal(httpSrc.includes("node:http"), false);
  assert.equal(httpSrc.includes("createServer"), false);

  assert.equal(shellSrc.includes("startShoe"), false);
  assert.equal(shellSrc.includes("projectFeltTable"), false);
  assert.equal(shellSrc.includes("projectCountsInfoBar"), false);
  assert.equal(shellSrc.includes("projectRemainingComposition"), false);
  assert.equal(shellSrc.includes("runningAce"), false);
  assert.equal(shellSrc.includes("COUNT_MAPS"), false);
  assert.equal(shellSrc.includes("32 *"), false);
  assert.equal(shellSrc.includes("node:http"), false);
  assert.equal(shellSrc.includes("createServer"), false);
});
