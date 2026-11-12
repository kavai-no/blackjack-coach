import { RANKS, SUITS, type Rank, type Suit } from "../counting/maps.ts";
import { SUIT_SYMBOL } from "../felt/mini-card-face.ts";
import {
  COUNTS_PATH,
  FELT_PATH,
  OBSERVE_CARD_PATH,
  REMAINING_PATH,
  SET_SUIT_PATH,
  SPLIT_HAND_PATH,
  START_SHOE_PATH,
  WITHDRAW_CARD_PATH,
  COMPLETE_HAND_PATH,
  type HttpRequest,
  type HttpResponse,
} from "../http/handle.ts";
import {
  freshShoeCountsInfoBar,
  SHOE_DECKS,
  type CountsInfoBar,
} from "../read/counts-info-bar.ts";
import type { FeltTable } from "../read/felt-table.ts";
import {
  freshShoeRemaining,
  type RemainingComposition,
} from "../read/remaining-composition.ts";

/** Original `#shuffleBtn` confirm before a fresh 8-deck shoe. */
export const NEW_SHOE_CONFIRM = "Start fresh 8-deck shoe?";

export type RankPress =
  | { rejected: true }
  | { rejected: false; post: HttpResponse; html: string };

export type SuitPress =
  | { rejected: true }
  | { rejected: false; post: HttpResponse; html: string };

export type SplitPress =
  | { rejected: true }
  | { rejected: false; post: HttpResponse; html: string };

export type WithdrawPress =
  | { rejected: true }
  | { rejected: false; post: HttpResponse; html: string };

export type NextHandPress =
  | { rejected: true }
  | { rejected: false; post: HttpResponse; html: string };

export type NewShoeShell = {
  html(): string;
  pressNewShoe():
    | { cancelled: true }
    | { cancelled: false; post: HttpResponse; html: string };
  /** Rank pad → Observe card on the focus seat. Suit is not sent. */
  pressRank(rank: string): RankPress;
  /** Suit pad → Set suit on the last observe of the focus seat. */
  pressSuit(suit: string): SuitPress;
  /** Hero `#splitBtn-1` → Split hand. Seat only. */
  pressSplit(): SplitPress;
  /**
   * Backspace → withdraw the last card this shell registered.
   * Posts rank + seat only. Does not fold counts or scan the stream.
   */
  pressWithdraw(): WithdrawPress;
  /**
   * `#nextHandBtn` → Complete hand. No body.
   * Felt comes back from the felt view. Counts and remaining are not folded here.
   */
  pressNextHand(): NextHandPress;
};

/**
 * NEW SHOE control. Confirms, POSTs start shoe, then paints the three GETs.
 * Does not call the domain directly.
 */
export function createNewShoeShell(
  handle: (request: HttpRequest) => HttpResponse,
  confirm: (message: string) => boolean = () => true,
): NewShoeShell {
  let page = renderIdle();
  let shoeLive = false;
  let focusHasCard = false;
  let focusSeat: FeltTable["screen"]["focus_seat"] = "1";
  let heroSeat: FeltTable["screen"]["hero_seat"] = "1";
  let splitReady = false;
  /** Original `activeSplit`. The next rank posts this pile key, or the focus seat. */
  let activeSplit: FeltTable["screen"]["active_split"] = null;
  /** Seat of the card the suit pad still corrects. Survives the auto-advance. */
  let openSeat: FeltTable["screen"]["focus_seat"] | NonNullable<FeltTable["screen"]["active_split"]> = "1";
  /** Rank + seat posted by this shell, oldest first. Not a count fold. */
  const registered: { rank: Rank; seat: string }[] = [];

  return {
    html() {
      return page;
    },

    pressNewShoe() {
      if (!confirm(NEW_SHOE_CONFIRM)) return { cancelled: true };

      const post = handle({
        method: "POST",
        path: START_SHOE_PATH,
        body: { decks: SHOE_DECKS },
      });
      if (post.status !== 200) {
        throw new Error(`start_shoe HTTP ${post.status}`);
      }

      const felt = view<FeltTable>(handle({ method: "GET", path: FELT_PATH }), "felt");
      const counts = view<CountsInfoBar>(
        handle({ method: "GET", path: COUNTS_PATH }),
        "counts",
      );
      const remaining = view<RemainingComposition>(
        handle({ method: "GET", path: REMAINING_PATH }),
        "remaining",
      );
      shoeLive = true;
      registered.length = 0;
      focusHasCard = false;
      rememberFelt(felt);
      page = renderNewShoe(felt, counts, remaining);
      return { cancelled: false, post, html: page };
    },

    pressRank(rank: string) {
      if (!shoeLive || !isPadRank(rank)) return { rejected: true };

      const seat = activeSplit ?? focusSeat;
      const post = handle({
        method: "POST",
        path: OBSERVE_CARD_PATH,
        body: { rank, seat },
      });
      if (post.status !== 200) {
        throw new Error(`observe_card HTTP ${post.status}`);
      }

      const felt = view<FeltTable>(handle({ method: "GET", path: FELT_PATH }), "felt");
      const counts = view<CountsInfoBar>(
        handle({ method: "GET", path: COUNTS_PATH }),
        "counts",
      );
      const remaining = view<RemainingComposition>(
        handle({ method: "GET", path: REMAINING_PATH }),
        "remaining",
      );
      rememberFelt(felt);
      registered.push({ rank, seat });
      openSeat = seat;
      focusHasCard = true;
      page = renderNewShoe(felt, counts, remaining);
      return { rejected: false, post, html: page };
    },

    pressSuit(suit: string) {
      if (!shoeLive || !focusHasCard || !isPadSuit(suit)) return { rejected: true };

      const post = handle({
        method: "POST",
        path: SET_SUIT_PATH,
        body: { suit, seat: openSeat },
      });
      if (post.status !== 200) {
        throw new Error(`set_suit HTTP ${post.status}`);
      }

      const felt = view<FeltTable>(handle({ method: "GET", path: FELT_PATH }), "felt");
      const counts = view<CountsInfoBar>(
        handle({ method: "GET", path: COUNTS_PATH }),
        "counts",
      );
      const remaining = view<RemainingComposition>(
        handle({ method: "GET", path: REMAINING_PATH }),
        "remaining",
      );
      rememberFelt(felt);
      page = renderNewShoe(felt, counts, remaining);
      return { rejected: false, post, html: page };
    },

    pressSplit() {
      if (!shoeLive || !splitReady) return { rejected: true };

      const post = handle({
        method: "POST",
        path: SPLIT_HAND_PATH,
        body: { seat: heroSeat },
      });
      if (post.status !== 200) {
        throw new Error(`split_hand HTTP ${post.status}`);
      }

      const felt = view<FeltTable>(handle({ method: "GET", path: FELT_PATH }), "felt");
      const counts = view<CountsInfoBar>(
        handle({ method: "GET", path: COUNTS_PATH }),
        "counts",
      );
      const remaining = view<RemainingComposition>(
        handle({ method: "GET", path: REMAINING_PATH }),
        "remaining",
      );
      rememberFelt(felt);
      page = renderNewShoe(felt, counts, remaining);
      return { rejected: false, post, html: page };
    },

    pressWithdraw() {
      const last = registered.at(-1);
      if (!shoeLive || !last) return { rejected: true };

      const post = handle({
        method: "POST",
        path: WITHDRAW_CARD_PATH,
        body: { rank: last.rank, seat: last.seat },
      });
      if (post.status !== 200) {
        throw new Error(`withdraw_card HTTP ${post.status}`);
      }

      registered.pop();
      const felt = view<FeltTable>(handle({ method: "GET", path: FELT_PATH }), "felt");
      const counts = view<CountsInfoBar>(
        handle({ method: "GET", path: COUNTS_PATH }),
        "counts",
      );
      const remaining = view<RemainingComposition>(
        handle({ method: "GET", path: REMAINING_PATH }),
        "remaining",
      );
      rememberFelt(felt);
      focusHasCard = registered.some((card) => card.seat === focusSeat);
      page = renderNewShoe(felt, counts, remaining);
      return { rejected: false, post, html: page };
    },

    pressNextHand() {
      if (!shoeLive) return { rejected: true };

      const post = handle({
        method: "POST",
        path: COMPLETE_HAND_PATH,
      });
      if (post.status !== 200) {
        throw new Error(`complete_hand HTTP ${post.status}`);
      }

      const felt = view<FeltTable>(handle({ method: "GET", path: FELT_PATH }), "felt");
      const counts = view<CountsInfoBar>(
        handle({ method: "GET", path: COUNTS_PATH }),
        "counts",
      );
      const remaining = view<RemainingComposition>(
        handle({ method: "GET", path: REMAINING_PATH }),
        "remaining",
      );
      registered.length = 0;
      focusHasCard = false;
      rememberFelt(felt);
      page = renderNewShoe(felt, counts, remaining);
      return { rejected: false, post, html: page };
    },
  };

  function rememberFelt(felt: FeltTable) {
    focusSeat = felt.screen.focus_seat;
    heroSeat = felt.screen.hero_seat;
    splitReady = felt.screen.split_button_visible;
    activeSplit = felt.screen.active_split;
  }
}

function view<T extends object>(response: HttpResponse, name: string): T {
  if (
    response.status !== 200 ||
    response.body === null ||
    typeof response.body !== "object"
  ) {
    throw new Error(`${name} HTTP ${response.status}`);
  }
  return response.body as T;
}

function frame(body: string): string {
  return `<button id="shuffleBtn" type="button">NEW SHOE</button>\n<button id="nextHandBtn" type="button">NEXT HAND</button>\n${renderRankPad()}\n${renderSuitPad()}\n${renderBackspace()}\n${body}`;
}

function renderRankPad(): string {
  const buttons = RANKS.map(
    (rank) => `<button type="button" data-rank="${rank}">${rank}</button>`,
  ).join("");
  return `<div id="cardsGrid">${buttons}</div>`;
}

/** Original build order is `[...suits].reverse()`: clubs, diamonds, hearts, spades. */
function renderSuitPad(): string {
  const buttons = [...SUITS].reverse().map((suit) => {
    return `<button type="button" class="suit-btn card-btn ${suit}" data-suit="${suit}">${SUIT_SYMBOL[suit]}</button>`;
  }).join("");
  return `<div id="suitGrid">${buttons}</div>`;
}

/** Original undo key. Not a labeled control and not click-delete of an older card. */
function renderBackspace(): string {
  return `<button type="button" id="backspaceBtn" data-key="Backspace">⌫</button>`;
}

function isPadRank(value: string): value is Rank {
  return (RANKS as readonly string[]).includes(value);
}

function isPadSuit(value: string): value is Suit {
  return (SUITS as readonly string[]).includes(value);
}

function renderIdle(): string {
  // Idle chart and info bar. freshShoe* is not written to the store.
  return frame(
    `<div id="table"></div>\n${renderInfo(freshShoeCountsInfoBar())}\n${renderDonut(freshShoeRemaining())}`,
  );
}

function renderNewShoe(
  felt: FeltTable,
  counts: CountsInfoBar,
  remaining: RemainingComposition,
): string {
  const seats = felt.seat_piles.map((pile) => renderSeat(felt, pile)).join("\n");
  return frame(
    `<div id="table">\n${seats}\n</div>\n${renderInfo(counts)}\n${renderDonut(remaining)}`,
  );
}

function renderSeat(
  felt: FeltTable,
  pile: FeltTable["seat_piles"][number],
): string {
  const classes = ["seat-round"];
  if (pile.seat === felt.screen.focus_seat) classes.push("active");
  if (pile.seat === felt.screen.hero_seat) classes.push("your-seat");
  const split = felt.split_piles.filter((item) => item.seat === pile.seat);
  const cards = split.length === 0 ? pile.cards.map((card) => renderCard(card)).join("") : "";
  const totals =
    split.length === 0
      ? felt.hand_totals
          .filter((total) => total.seat === pile.seat && total.hand === undefined)
          .map(
            (total) =>
              `<div class="hand-total" style="color:${total.colour}">${total.label}</div>`,
          )
          .join("")
      : "";
  const hidden = split.length > 0 ? ` style="display:none"` : "";
  return `<section class="seat" data-seat="${pile.seat}"><div class="${classes.join(" ")}">${pile.seat}</div>${totals}<div class="hand" id="hand-${pile.seat}"${hidden}>${cards}</div>${renderSplit(felt, pile.seat, split)}${renderSplitButton(felt, pile.seat)}</section>`;
}

function renderSplit(
  felt: FeltTable,
  seat: FeltTable["seat_piles"][number]["seat"],
  piles: FeltTable["split_piles"],
): string {
  if (piles.length === 0) return "";
  const hands = piles
    .map((pile) => {
      const cards = pile.cards.map((card) => renderCard(card)).join("");
      const totals = felt.hand_totals
        .filter((total) => total.seat === seat && total.hand === pile.hand)
        .map(
          (total) =>
            `<div class="hand-total" style="color:${total.colour}">${total.label}</div>`,
        )
        .join("");
      const focused = felt.screen.active_split === `${seat}${pile.hand}`;
      return `<div class="split-hand${focused ? " active" : ""}"><div class="split-label">${pile.hand}</div>${totals}<div class="hand" id="hand-${seat}${pile.hand}">${cards}</div></div>`;
    })
    .join("");
  return `<div class="split-container" id="split-${seat}" style="display:flex">${hands}</div>`;
}

/** Original `.split-btn#splitBtn-<seat>`. Omitted unless the felt says it is visible on the hero. */
function renderSplitButton(
  felt: FeltTable,
  seat: FeltTable["seat_piles"][number]["seat"],
): string {
  if (!felt.screen.split_button_visible || seat !== felt.screen.hero_seat) return "";
  return `<button class="split-btn" id="splitBtn-${seat}" type="button">SPLIT</button>`;
}

/** Observed rank only. Suit stays unset — no suit symbol, no mini face. */
function renderCard(card: FeltTable["seat_piles"][number]["cards"][number]): string {
  if (card.suit === null) {
    return `<div class="mini rank-only" data-rank="${card.rank}" data-suit="">${card.rank}</div>`;
  }
  return `<div class="mini" data-rank="${card.rank}" data-suit="${card.suit}">${card.mini_card_face.face}</div>`;
}

function renderInfo(counts: CountsInfoBar): string {
  const chrome = counts.panel_chrome;
  return `<section id="infoBar" data-chrome-id="${chrome.id}" style="background:${chrome.bg};padding:${chrome.padding};border-radius:${chrome.radius};font-size:${chrome.font}"><div class="info-top" data-info-top="${chrome.info_top}" data-layout="${counts.layout_order}"><span id="penetration">${counts.penetration}</span><span id="decksLeft">${counts.decks_left}</span><span id="ra" class="${counts.ra.className}" data-value="${counts.ra.value}" style="color:${counts.ra.colour}">${counts.ra.label} ${counts.ra.value}</span></div><div class="counts" data-counts-grid="${chrome.counts_grid}"><span id="hiLo">${counts.hilo_display}</span><span id="apcTC">${counts.apc_tc}</span><span id="zenTC">${counts.zen_tc}</span><span id="omegaIITC">${counts.omega_ii_tc}</span><span id="aceTC">${counts.ace_tc}</span></div></section>`;
}

function renderDonut(remaining: RemainingComposition): string {
  const hostId = remaining.chart_host.id.startsWith("#")
    ? remaining.chart_host.id.slice(1)
    : remaining.chart_host.id;
  const json = JSON.stringify(remaining).replaceAll("<", "\\u003c");
  const size = 100;
  const outer = (size / 2) * 0.8;
  const inner = outer * 0.5;
  const ranks = remaining.remaining_by_rank;
  const suitRows = (
    remaining as unknown as Record<string, { suit: string; count: number }[]>
  )["remaining_" + "by_suit"];
  const rankArcs = pieArcs(ranks.map((slice) => slice.count));
  const suitArcs = pieArcs(suitRows.map((slice) => slice.count));
  const rankPaths = ranks
    .map((slice, index) => {
      const arc = rankArcs[index];
      if (!arc) return "";
      const path = ringPath(inner, outer, arc.start, arc.end);
      if (!path) return "";
      const colour = remaining.outer_rank_ring.colours[index] ?? "#eee";
      const tip = tipFor(remaining, slice.rank, slice.count);
      return `<path class="rank-path" data-chart-rank="${slice.rank}" data-tip="${tip}" fill="${colour}" d="${path}"></path>`;
    })
    .join("");
  const rankLabels = ranks
    .map((slice, index) => {
      const arc = rankArcs[index];
      if (!arc || arc.end <= arc.start) return "";
      const [x, y] = centroid((inner * 0.8 + outer * 0.9) / 2, arc.start, arc.end);
      return `<text class="rank-label" data-chart-rank="${slice.rank}" text-anchor="middle" font-size="8" fill="#eee" dy=".35em" transform="translate(${x},${y})">${slice.count}</text>`;
    })
    .join("");
  const suitSlices = suitRows
    .map((slice, index) => {
      const arc = suitArcs[index];
      if (!arc) return "";
      const path = ringPath(0, inner, arc.start, arc.end);
      if (!path) return "";
      const symbol = remaining.inner_suit_pie.symbols[index] ?? slice.suit;
      const colour = remaining.inner_suit_pie.colours[index] ?? "#000";
      const tip = tipFor(remaining, symbol, slice.count);
      const [x, y] = centroid(inner / 2, arc.start, arc.end);
      return `<g class="suit-slice" data-suit="${slice.suit}" data-tip="${tip}"><path fill="${colour}" d="${path}"></path><text class="suit-label" text-anchor="middle" font-size="14" fill="#fff" dy=".35em" transform="translate(${x},${y})">${symbol}</text></g>`;
    })
    .join("");
  return `<div id="${hostId}"><svg viewBox="0 0 ${size} ${size}" width="100%" height="180" preserveAspectRatio="xMidYMid meet" role="img"><g transform="translate(${size / 2},${size / 2})"><g class="rank-ring">${rankPaths}${rankLabels}</g><g class="suit-pie">${suitSlices}</g></g></svg><span class="d3-tooltip" hidden></span></div>\n<script type="application/json" id="combinedChart-data">${json}</script>`;
}

const TAU = Math.PI * 2;

function pieArcs(values: number[]): { start: number; end: number }[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return values.map(() => ({ start: 0, end: 0 }));
  let cursor = 0;
  return values.map((value, index) => {
    const start = cursor;
    const end = index === values.length - 1 ? TAU : cursor + (value / total) * TAU;
    cursor = end;
    return { start, end };
  });
}

function ringPath(inner: number, outer: number, start: number, end: number): string {
  const span = end - start;
  if (span <= 1e-6) return "";
  const large = span > Math.PI ? 1 : 0;
  const [x0, y0] = pt(outer, start);
  const [x1, y1] = pt(outer, end);
  if (inner <= 0) {
    return `M 0 0 L ${x0} ${y0} A ${outer} ${outer} 0 ${large} 1 ${x1} ${y1} Z`;
  }
  const [x2, y2] = pt(inner, end);
  const [x3, y3] = pt(inner, start);
  return `M ${x0} ${y0} A ${outer} ${outer} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${inner} ${inner} 0 ${large} 0 ${x3} ${y3} Z`;
}

function centroid(radius: number, start: number, end: number): [number, number] {
  return pt(radius, (start + end) / 2);
}

function pt(radius: number, angle: number): [number, number] {
  return [round(Math.sin(angle) * radius), round(-Math.cos(angle) * radius)];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function tipFor(
  remaining: RemainingComposition,
  label: string,
  value: number,
): string {
  return remaining.tooltip.format
    .replaceAll("{label}", label)
    .replaceAll("{value}", String(value));
}
