import { RANKS, SUITS, type Rank, type Suit } from "../counting/maps.ts";
import { SUIT_SYMBOL, displayRank } from "../felt/mini-card-face.ts";
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
import {
  computeTotal,
  type FeltTable,
} from "../read/felt-table.ts";
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
  /**
   * `#splitBtn-<seat>` → Split hand on that player seat. Seat only.
   * Focus moves to `<seat>A` as a MANUAL focus, so Backspace right after
   * SPLIT withdraws A's card (focus_sources_for_withdraw, source 4;
   * original cardHandler.js:157, seatManager.js:14/:25, cardHandler.js:100-104).
   */
  pressSplit(seat: string): SplitPress;
  /**
   * Backspace → withdraw the resolved card.
   * After a manual seat click, that pile's last card.
   * After observation auto-advance, the last card this shell registered.
   * An empty manual pile posts nothing.
   * Ordinary dealing does not move focus. A 21 or bust advance does:
   * Backspace returns focus to the pile that advanced (keyboard_bust_advance_backspace_returns_focus).
   */
  pressWithdraw(): WithdrawPress;
  /**
   * Header click. A split seat lands on its due pile: A unless A is 21 or
   * bust, otherwise B, and A again when both piles are 21 or bust
   * (ruling_q6, Kristoffer 2026-11-24 14:12). A disabled seat is not
   * focused; the click walks to the next active seat on the left.
   * Repeating the click does not toggle. UI only.
   */
  pressSeat(seat: string): void;
  /**
   * ArrowLeft / ArrowRight. UI only, and a manual Backspace focus
   * (keyboard_arrow_sets_manual_focus_for_backspace).
   * Left walks 1→2→…→7→dealer→1. Right walks the other way.
   * Inside a flipped split, ArrowLeft from A goes to B when B is open,
   * otherwise to the next seat on the left. An arrow that enters a split
   * seat lands on the pile nearest on screen, or the other pile when that
   * nearest one is empty, 21 or bust and the other is open.
   */
  pressArrow(direction: "left" | "right"): void;
  /**
   * Space toggles the focused player seat. UI only, no event.
   * The dealer cannot be toggled. Disabling the focused seat moves focus
   * left. Re-enabling does not move focus.
   */
  pressSpace(): void;
  /**
   * Right-click toggles that player seat and does not move focus,
   * including when the seat is the focused one. The dealer cannot be toggled.
   */
  pressToggleSeat(seat: string): void;
  /**
   * Ordinary-seat auto-advance after the last Observe.
   * 1st and 2nd cards move left. The last active player's 2nd card skips
   * the dealer and jumps to the first active seat. A 3rd+ card stays unless
   * the pile is 21 or bust. Split: A's 2nd card (or a 21/bust on A) goes to
   * B when B is not 21 or bust, then B's 2nd card goes to the next active
   * seat. Landing on a split seat uses that due pile and skips the seat
   * when both piles are 21 or bust. A 21 or bust advance arms Backspace
   * to put focus back on that pile.
   */
  advanceFocus(): void;
  /** UI focus pile, or null before NEW SHOE and before any header click. */
  focusKey(): string | null;
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
  /** Player seats whose SPLIT the felt shows. Copied from the view, not a rule. */
  const splitReady = new Set<string>();
  /** UI focus. Null until NEW SHOE or a header click. Not an event. */
  let uiFocus: string | null = null;
  /** Player seats switched off. UI only — not events, not reloaded. */
  const disabled = new Set<string>();
  /**
   * Pile a 21/bust auto-advance left. Backspace returns focus here.
   * An ordinary dealing advance does not set it.
   */
  let returnPile: string | null = null;
  /** Manual header click targets the focused pile. Observation targets the last card. */
  let provenance: "manual" | "observation" = "observation";
  const splitBases = new Set<string>();
  /** Seat of the card the suit pad still corrects. Survives the auto-advance. */
  let openSeat = "1";
  /** Rank + seat posted by this shell, oldest first. Not a count fold. */
  const registered: { rank: Rank; seat: string }[] = [];
  let feltNow: FeltTable | null = null;
  let countsNow: CountsInfoBar | null = null;
  let remainingNow: RemainingComposition | null = null;
  let lastDeal: { seat: string; length: number } | null = null;

  return {
    html() {
      return page;
    },

    focusKey() {
      return uiFocus;
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
      openSeat = "1";
      uiFocus = "1";
      disabled.clear();
      returnPile = null;
      provenance = "observation";
      lastDeal = null;
      rememberViews(felt, counts, remaining);
      page = renderNewShoe(felt, counts, remaining, uiFocus, disabled);
      return { cancelled: false, post, html: page };
    },

    pressRank(rank: string) {
      if (!shoeLive || !isPadRank(rank)) return { rejected: true };
      returnPile = null;
      retargetDisabledFocus();

      const seat = uiFocus ?? "1";
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
      rememberViews(felt, counts, remaining);
      registered.push({ rank, seat });
      openSeat = seat;
      focusHasCard = true;
      lastDeal = { seat, length: pileLength(felt, seat) };
      page = renderNewShoe(felt, counts, remaining, uiFocus, disabled);
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
      rememberViews(felt, counts, remaining);
      page = renderNewShoe(felt, counts, remaining, uiFocus, disabled);
      return { rejected: false, post, html: page };
    },

    pressSplit(seat: string) {
      if (!shoeLive || !splitReady.has(seat)) return { rejected: true };

      const post = handle({
        method: "POST",
        path: SPLIT_HAND_PATH,
        body: { seat },
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
      rekeySplit(seat);
      uiFocus = `${seat}A`;
      provenance = "manual";
      returnPile = null;
      rememberViews(felt, counts, remaining);
      page = renderNewShoe(felt, counts, remaining, uiFocus, disabled);
      return { rejected: false, post, html: page };
    },

    pressSeat(seat: string) {
      if (!isPlainSeat(seat)) return;
      // Due pile: A while A is not 21 or bust, else B, else A when both
      // are. Card total, not the stale Total label. A click does not toggle.
      // A disabled seat sends focus to the next active seat on the left.
      returnPile = null;
      if (seat !== "D" && disabled.has(seat)) {
        const dest = walkActive(moveLeft(seat));
        uiFocus = splitBases.has(dest) ? `${dest}${duePile(dest)}` : dest;
      } else {
        uiFocus = splitBases.has(seat) ? `${seat}${duePile(seat)}` : seat;
      }
      provenance = "manual";
      repaint();
    },

    pressArrow(direction: "left" | "right") {
      if (!shoeLive || !uiFocus) return;
      returnPile = null;
      const base = focusBase(uiFocus);
      if (!base) return;
      if (direction === "left") {
        if (uiFocus.endsWith("A") && pilePhase(base, "B") === "open") {
          uiFocus = `${base}B`;
        } else {
          uiFocus = enterSeat(moveLeft(base), "right");
        }
      } else if (uiFocus.endsWith("B") && pilePhase(base, "A") === "open") {
        uiFocus = `${base}A`;
      } else {
        uiFocus = enterSeat(moveRight(base), "left");
      }
      provenance = "manual";
      repaint();
    },

    pressSpace() {
      if (!uiFocus) return;
      const base = focusBase(uiFocus);
      if (!base || base === "D") return;
      returnPile = null;
      if (disabled.has(base)) {
        disabled.delete(base);
        repaint();
        return;
      }
      disabled.add(base);
      uiFocus = enterSeat(moveLeft(base), "right");
      provenance = "manual";
      repaint();
    },

    pressToggleSeat(seat: string) {
      if (seat === "D" || !isPlainSeat(seat)) return;
      if (disabled.has(seat)) disabled.delete(seat);
      else disabled.add(seat);
      repaint();
    },

    advanceFocus() {
      if (!lastDeal) return;
      const from = lastDeal.seat;
      const total = totalOf(from);
      const done = total >= 21;
      const next = computeNext(from, lastDeal.length, done);
      uiFocus = next;
      provenance = "observation";
      returnPile = done && next !== from ? from : null;
      repaint();
    },

    pressWithdraw() {
      const target = withdrawTarget();
      if (!shoeLive || !target) return { rejected: true };

      const post = handle({
        method: "POST",
        path: WITHDRAW_CARD_PATH,
        body: { rank: target.rank, seat: target.seat },
      });
      if (post.status !== 200) {
        throw new Error(`withdraw_card HTTP ${post.status}`);
      }

      dropRegistered(target.rank, target.seat);
      const felt = view<FeltTable>(handle({ method: "GET", path: FELT_PATH }), "felt");
      const counts = view<CountsInfoBar>(
        handle({ method: "GET", path: COUNTS_PATH }),
        "counts",
      );
      const remaining = view<RemainingComposition>(
        handle({ method: "GET", path: REMAINING_PATH }),
        "remaining",
      );
      rememberViews(felt, counts, remaining);
      const jumped = returnPile !== null && target.seat === returnPile;
      returnPile = null;
      if (jumped) {
        uiFocus = target.seat;
        provenance = "manual";
      }
      focusHasCard = registered.some((card) => card.seat === openSeat);
      page = renderNewShoe(felt, counts, remaining, uiFocus, disabled);
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
      openSeat = "1";
      uiFocus = "1";
      disabled.clear();
      returnPile = null;
      provenance = "observation";
      lastDeal = null;
      rememberViews(felt, counts, remaining);
      page = renderNewShoe(felt, counts, remaining, uiFocus, disabled);
      return { rejected: false, post, html: page };
    },
  };

  function duePile(seat: string): "A" | "B" {
    return autoDue(seat) ?? "A";
  }

  function totalOf(seat: string): number {
    return computeTotal(cardsOn(seat).map((card) => card.rank));
  }

  function cardsOn(seat: string): { rank: Rank }[] {
    if (!feltNow) return [];
    if (seat.length === 2 && (seat.endsWith("A") || seat.endsWith("B"))) {
      const hand = seat.endsWith("A") ? "A" : "B";
      const base = seat.slice(0, 1);
      return (
        feltNow.split_piles.find((pile) => pile.seat === base && pile.hand === hand)
          ?.cards ?? []
      );
    }
    return feltNow.seat_piles.find((pile) => pile.seat === seat)?.cards ?? [];
  }

  type PilePhase = "absent" | "empty" | "open" | "done";

  function pilePhase(base: string, hand: "A" | "B"): PilePhase {
    if (!splitBases.has(base)) return "absent";
    const cards = cardsOn(`${base}${hand}`);
    if (cards.length === 0) return "empty";
    if (computeTotal(cards.map((card) => card.rank)) >= 21) return "done";
    return "open";
  }

  /** A while A is not 21 or bust, else B, else neither (both done). */
  function autoDue(base: string): "A" | "B" | null {
    const a = pilePhase(base, "A");
    const b = pilePhase(base, "B");
    if (a === "open" || a === "empty") return "A";
    if (b === "open" || b === "empty") return "B";
    return null;
  }

  function firstPlaying(): string {
    for (const seat of ["1", "2", "3", "4", "5", "6", "7"]) {
      if (!disabled.has(seat)) return seat;
    }
    return "D";
  }

  function isLastActive(seat: string): boolean {
    for (let number = 7; number >= 1; number -= 1) {
      const candidate = String(number);
      if (!disabled.has(candidate)) return candidate === seat;
    }
    return false;
  }

  function landAuto(start: string): string {
    let seat = start;
    for (let guard = 0; guard < MOVE_LEFT.length * 2; guard += 1) {
      if (seat !== "D" && disabled.has(seat)) {
        seat = moveLeft(seat);
        continue;
      }
      if (splitBases.has(seat)) {
        const due = autoDue(seat);
        if (due) return `${seat}${due}`;
        seat = moveLeft(seat);
        continue;
      }
      return seat;
    }
    return firstPlaying();
  }

  function walkActive(start: string): string {
    let seat = start;
    for (let guard = 0; guard < MOVE_LEFT.length * 2; guard += 1) {
      if (seat === "D" || !disabled.has(seat)) return seat;
      seat = moveLeft(seat);
    }
    return start;
  }

  function retargetDisabledFocus(): void {
    if (!uiFocus) return;
    const base = focusBase(uiFocus);
    if (!base || base === "D" || !disabled.has(base)) return;
    uiFocus = landAuto(moveLeft(base));
  }

  function arrowPile(base: string, from: "left" | "right"): "A" | "B" {
    const nearest = from === "right" ? "A" : "B";
    const other = nearest === "A" ? "B" : "A";
    const near = pilePhase(base, nearest);
    const alt = pilePhase(base, other);
    if ((near === "empty" || near === "done") && alt === "open") return other;
    return nearest;
  }

  function enterSeat(start: string, from: "left" | "right"): string {
    const step = from === "right" ? moveLeft : moveRight;
    let seat = start;
    for (let guard = 0; guard < MOVE_LEFT.length * 2; guard += 1) {
      if (seat !== "D" && disabled.has(seat)) {
        seat = step(seat);
        continue;
      }
      if (splitBases.has(seat)) return `${seat}${arrowPile(seat, from)}`;
      return seat;
    }
    return seat;
  }

  function computeNext(seat: string, length: number, done: boolean): string {
    if (seat.length === 2 && (seat.endsWith("A") || seat.endsWith("B"))) {
      const base = seat.slice(0, 1);
      const leave = length === 2 || (length > 2 && done);
      if (!leave) return seat;
      if (seat.endsWith("A")) {
        const b = pilePhase(base, "B");
        if (b === "open" || b === "empty") return `${base}B`;
        return landAuto(moveLeft(base));
      }
      return landAuto(moveLeft(base));
    }
    if (seat === "D") {
      if (length === 1 || done) return firstPlaying();
      return "D";
    }
    if (length > 2 && !done) return seat;
    if (length <= 0) return seat;
    if (length === 2 && isLastActive(seat)) return firstPlaying();
    return landAuto(moveLeft(seat));
  }

  function withdrawTarget(): { rank: Rank; seat: string } | undefined {
    if (provenance === "manual") {
      if (!uiFocus) return undefined;
      for (let index = registered.length - 1; index >= 0; index -= 1) {
        const card = registered[index];
        if (card && card.seat === uiFocus) return card;
      }
      return undefined;
    }
    return registered.at(-1);
  }

  function dropRegistered(rank: Rank, seat: string): void {
    for (let index = registered.length - 1; index >= 0; index -= 1) {
      const card = registered[index];
      if (card && card.rank === rank && card.seat === seat) {
        registered.splice(index, 1);
        return;
      }
    }
  }

  function rekeySplit(base: string): void {
    const hits = registered.filter((card) => card.seat === base);
    if (hits.length !== 2) return;
    let seen = 0;
    for (const card of registered) {
      if (card.seat !== base) continue;
      card.seat = seen === 0 ? `${base}A` : `${base}B`;
      seen += 1;
    }
    if (openSeat === base) openSeat = `${base}B`;
  }

  function rememberViews(
    felt: FeltTable,
    counts: CountsInfoBar,
    remaining: RemainingComposition,
  ): void {
    feltNow = felt;
    countsNow = counts;
    remainingNow = remaining;
    splitReady.clear();
    for (const seat of felt.screen.split_ready_seats) splitReady.add(seat);
    splitBases.clear();
    for (const pile of felt.split_piles) splitBases.add(pile.seat);
  }

  function repaint(): void {
    if (!shoeLive || !feltNow || !countsNow || !remainingNow) return;
    page = renderNewShoe(feltNow, countsNow, remainingNow, uiFocus, disabled);
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
  return `<button id="shuffleBtn" type="button">NEW SHOE</button>\n<button id="nextHandBtn" type="button">NEXT HAND</button>\n${renderRankPad()}\n${renderSuitPad()}\n${body}`;
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

function isPadRank(value: string): value is Rank {
  return (RANKS as readonly string[]).includes(value);
}

function isPadSuit(value: string): value is Suit {
  return (SUITS as readonly string[]).includes(value);
}

function isPlainSeat(value: string): boolean {
  return value === "D" || /^[1-7]$/.test(value);
}

/** Dealing order for moveLeft: 1 → 2 → … → 7 → dealer → 1. */
const MOVE_LEFT = ["1", "2", "3", "4", "5", "6", "7", "D"] as const;

function moveLeft(seat: string): string {
  const index = MOVE_LEFT.indexOf(seat as (typeof MOVE_LEFT)[number]);
  if (index < 0) return "1";
  return MOVE_LEFT[(index + 1) % MOVE_LEFT.length] ?? "1";
}

/** Screen-right: 1 → dealer → 7 → … → 2 → 1. */
function moveRight(seat: string): string {
  const index = MOVE_LEFT.indexOf(seat as (typeof MOVE_LEFT)[number]);
  if (index < 0) return "D";
  return MOVE_LEFT[(index - 1 + MOVE_LEFT.length) % MOVE_LEFT.length] ?? "D";
}

function pileLength(felt: FeltTable, seat: string): number {
  if (seat.length === 2 && (seat.endsWith("A") || seat.endsWith("B"))) {
    const hand = seat.endsWith("A") ? "A" : "B";
    const base = seat.slice(0, 1);
    return (
      felt.split_piles.find((pile) => pile.seat === base && pile.hand === hand)?.cards
        .length ?? 0
    );
  }
  return felt.seat_piles.find((pile) => pile.seat === seat)?.cards.length ?? 0;
}

function focusBase(focus: string | null): string | null {
  if (!focus) return null;
  return focus.length === 2 ? focus.slice(0, 1) : focus;
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
  focus: string | null,
  disabled: ReadonlySet<string>,
): string {
  const seats = felt.seat_piles
    .map((pile) => renderSeat(felt, pile, focus, disabled))
    .join("\n");
  return frame(
    `<div id="table">\n${seats}\n</div>\n${renderInfo(counts)}\n${renderDonut(remaining)}`,
  );
}

function renderSeat(
  felt: FeltTable,
  pile: FeltTable["seat_piles"][number],
  focus: string | null,
  disabled: ReadonlySet<string>,
): string {
  const classes = ["seat-round"];
  if (disabled.has(pile.seat)) classes.push("disabled");
  if (pile.seat === focusBase(focus)) classes.push("active");
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
  return `<section class="seat" data-seat="${pile.seat}"><div class="${classes.join(" ")}">${pile.seat}</div>${totals}<div class="hand" id="hand-${pile.seat}"${hidden}>${cards}</div>${renderSplit(felt, pile.seat, split, focus)}${renderSplitButton(felt, pile.seat)}</section>`;
}

function renderSplit(
  felt: FeltTable,
  seat: FeltTable["seat_piles"][number]["seat"],
  piles: FeltTable["split_piles"],
  focus: string | null,
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
      const focused = focus === `${seat}${pile.hand}`;
      return `<div class="split-hand${focused ? " active" : ""}"><div class="split-label">${pile.hand}</div><div class="hand" id="hand-${seat}${pile.hand}">${totals}${cards}</div></div>`;
    })
    .join("");
  return `<div class="split-container" id="split-${seat}">${hands}</div>`;
}

/** Original `.split-btn#splitBtn-<seat>`. Omitted unless the felt lists that seat as split-ready. */
function renderSplitButton(
  felt: FeltTable,
  seat: FeltTable["seat_piles"][number]["seat"],
): string {
  if (!felt.screen.split_ready_seats.includes(seat)) return "";
  return `<button class="split-btn" id="splitBtn-${seat}" type="button">SPLIT</button>`;
}

/** Original `addCard` mini: corners and suit pips, no centre face. Ten is `T`. */
function renderCard(card: FeltTable["seat_piles"][number]["cards"][number]): string {
  const painted = displayRank(card.rank);
  const corners = `<span class="corner top-left">${painted}</span><span class="corner bottom-right">${painted}</span>`;
  if (card.suit === null) {
    return `<div class="mini rank-only" data-rank="${card.rank}" data-suit="">${corners}</div>`;
  }
  const symbol = SUIT_SYMBOL[card.suit];
  return `<div class="mini" data-rank="${card.rank}" data-suit="${card.suit}">${corners}<span class="suit top-right">${symbol}</span><span class="suit bottom-left">${symbol}</span></div>`;
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
