import { handleHttp, type HttpRequest } from "../http/handle.ts";
import { pickSuit, type RankSuitCount } from "../felt/pick-suit.ts";
import { createNewShoeShell, type NewShoeShell } from "../ui/new-shoe-shell.ts";
import { SEATS as IDLE_SEATS } from "../write/events.ts";
import {
  TABLE_STREAM,
  createInMemoryEventStore,
  type InMemoryEventStore,
} from "../write/in-memory-store.ts";

export type Confirm = (message: string) => boolean;

type ClassList = {
  add(token: string): void;
  remove(token: string): void;
};

type BoundNode = {
  classList: ClassList;
  hidden?: boolean;
  textContent: string | null;
  getAttribute(name: string): string | null;
  addEventListener(type: string, listener: () => void): void;
};

type AppRoot = {
  innerHTML: string;
  querySelector(selector: string): BoundNode | null;
  querySelectorAll(selector: string): ArrayLike<BoundNode>;
  setAttribute(name: string, value: string): void;
};

type PageDocument = {
  querySelector(selector: string): AppRoot | null;
  addEventListener?(
    type: string,
    listener: (event: { key?: string; preventDefault?: () => void }) => void,
  ): void;
};

/** Seats exist before any shoe. Hero class only. Focus ring waits for a click or NEW SHOE. */
function idleSeatChrome(focus: string | null): string {
  return IDLE_SEATS.map((seat) => {
    const classes = ["seat-round"];
    if (seat === focus) classes.push("active");
    if (seat === "1") classes.push("your-seat");
    return `<section class="seat" data-seat="${seat}"><div class="${classes.join(" ")}">${seat}</div><div class="hand" id="hand-${seat}"></div></section>`;
  }).join("");
}

/**
 * NEW SHOE / NEXT HAND screen. `#cardsGrid` and `#suitGrid` stay mounted.
 * This page does not strip either pad.
 */
export function presentNewShoeFragment(fragment: string, focus: string | null = null): string {
  return fragment
    .replace(
      '<button id="shuffleBtn" type="button">NEW SHOE</button>\n<button id="nextHandBtn" type="button">NEXT HAND</button>',
      '<div class="topbar"><button class="btn shuffle" id="shuffleBtn" type="button">NEW SHOE</button><button class="btn next-hand" id="nextHandBtn" type="button">NEXT HAND</button></div>',
    )
    .replace(
      '<div id="table">',
      '<div class="table-container"><div class="table" id="table">',
    )
    .replace(
      "</div>\n<section id=\"infoBar\"",
      "</div></div>\n<section id=\"infoBar\"",
    )
    .replace(
      /<div id="combinedChart">[\s\S]*?<\/div>/,
      (host) =>
        `<div class="bottom"><div class="charts-grid">${host}</div></div>`,
    )
    .replace(
      '<div class="table" id="table"></div>',
      `<div class="table" id="table">${idleSeatChrome(focus)}</div>`,
    );
}

/** Mount the existing shell. Confirm and POST stay inside the shell. */
export function mountNewShoePage(
  document: PageDocument,
  confirm: Confirm,
): InMemoryEventStore {
  const root = document.querySelector("#app");
  if (!root) {
    throw new Error("#app missing");
  }
  const store = createInMemoryEventStore();
  const shell = createNewShoeShell(
    (request: HttpRequest) => handleHttp(store, request),
    confirm,
  );
  // Same store the shell writes. Read-only copy of the table stream; no append.
  publishTableRead(store);
  // `globalThis.pickSuitRandom` is the unit-interval fixture (a number).
  // Read once at mount, which is boot.js startup. Unset → Math.random.
  const random = readPickSuitRandom();

  let screen = "felt_idle_no_events";
  const paint = () => {
    root.innerHTML = presentNewShoeFragment(shell.html(), shell.focusKey());
    root.querySelector("#shuffleBtn")?.addEventListener("click", () => {
      const result = shell.pressNewShoe();
      if (!result.cancelled) {
        screen = "felt_new_shoe";
        paint();
      }
    });
    root.querySelector("#nextHandBtn")?.addEventListener("click", () => {
      const result = shell.pressNextHand();
      if (!result.rejected) paint();
    });
    bindRankPad(root, shell, paint, random);
    bindSuitPad(root, shell, paint);
    bindSplit(root, shell, paint, () => {
      screen = "felt_split";
    });
    bindFocus(root, shell, paint);
    bindWithdraw(root, shell, paint);
    bindChartTips(root);
    root.setAttribute("data-screen", screen);
  };

  document.addEventListener?.("keydown", (event) => {
    if (event.key !== "Backspace") return;
    event.preventDefault?.();
    const result = shell.pressWithdraw();
    if (!result.rejected) paint();
  });

  paint();
  return store;
}

/** `store.read` of the mounted table stream. Copies only — no writer, no second store. */
function publishTableRead(store: InMemoryEventStore): void {
  const readTable = () =>
    store.read(TABLE_STREAM).map((event) => ({ ...event }));
  Object.defineProperty(globalThis, "readTable", {
    configurable: true,
    enumerable: false,
    writable: false,
    value: readTable,
  });
}

/**
 * `globalThis.pickSuitRandom`: unit interval in `[0, 1)`.
 * Set before `boot.js` runs. Absent in production.
 */
function readPickSuitRandom(): () => number {
  const fixture = Reflect.get(globalThis, "pickSuitRandom");
  if (typeof fixture === "number" && Number.isFinite(fixture)) {
    return () => fixture;
  }
  return Math.random;
}

/** Rank pad → observe-card, then set-suit from pickSuit, one gesture. */
function bindRankPad(
  root: AppRoot,
  shell: NewShoeShell,
  paint: () => void,
  random: () => number,
): void {
  for (const button of Array.from(root.querySelectorAll("#cardsGrid button"))) {
    button.addEventListener("click", () => {
      const rank = button.getAttribute("data-rank");
      if (!rank) return;
      const observed = shell.pressRank(rank);
      if (observed.rejected) return;
      const suit = pickSuit(rank, rankSuitCells(observed.html), random);
      shell.pressSuit(suit);
      shell.advanceFocus();
      paint();
    });
  }
}

/** Rank×suit counts from the remaining view the shell just painted. */
function rankSuitCells(html: string): RankSuitCount[] {
  const match = /id="combinedChart-data">([^<]*)<\/script>/.exec(html);
  const json = match?.[1];
  if (!json) throw new Error("remaining view missing");
  const view = JSON.parse(json) as { remaining_by_rank_suit?: RankSuitCount[] };
  return view.remaining_by_rank_suit ?? [];
}

/** Hero `#splitBtn-1` → split hand. The button is absent unless felt shows it. */
function bindSplit(
  root: AppRoot,
  shell: NewShoeShell,
  paint: () => void,
  showSplit: () => void,
): void {
  root.querySelector("#splitBtn-1")?.addEventListener("click", () => {
    const result = shell.pressSplit();
    if (!result.rejected) {
      showSplit();
      paint();
    }
  });
}

/** Suit pad → POST set-suit on the focus seat. Rejected when no card is there. */
function bindSuitPad(root: AppRoot, shell: NewShoeShell, paint: () => void): void {
  for (const button of Array.from(root.querySelectorAll("#suitGrid button"))) {
    button.addEventListener("click", () => {
      const suit = button.getAttribute("data-suit");
      if (!suit) return;
      const result = shell.pressSuit(suit);
      if (!result.rejected) paint();
    });
  }
}

/** Focus ring is UI chrome. A header click tells the shell the withdraw pile. */
function bindFocus(root: AppRoot, shell: NewShoeShell, paint: () => void): void {
  const rounds = Array.from(root.querySelectorAll(".seat-round"));
  const seats = IDLE_SEATS;
  for (let index = 0; index < rounds.length; index += 1) {
    const round = rounds[index];
    const seat = seats[index];
    if (!round || !seat) continue;
    round.addEventListener("click", () => {
      shell.pressSeat(seat);
      paint();
    });
  }
}

/** Backspace key and the shell's #backspaceBtn. Not click-delete of an older card. */
function bindWithdraw(root: AppRoot, shell: NewShoeShell, paint: () => void): void {
  root.querySelector("#backspaceBtn")?.addEventListener("click", () => {
    const result = shell.pressWithdraw();
    if (!result.rejected) paint();
  });
}

/** Rank or suit slice hover shows the projection tooltip. No command. */
function bindChartTips(root: AppRoot): void {
  const tip = root.querySelector(".d3-tooltip");
  if (!tip) return;
  const slices = [
    ...Array.from(root.querySelectorAll(".rank-path")),
    ...Array.from(root.querySelectorAll(".suit-slice")),
  ];
  for (const slice of slices) {
    slice.addEventListener("mouseenter", () => {
      tip.textContent = slice.getAttribute("data-tip");
      tip.hidden = false;
    });
    slice.addEventListener("mouseleave", () => {
      tip.hidden = true;
    });
  }
}
