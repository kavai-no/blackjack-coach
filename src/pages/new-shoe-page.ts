import { handleHttp, type HttpRequest } from "../http/handle.ts";
import { createNewShoeShell, type NewShoeShell } from "../ui/new-shoe-shell.ts";
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
};

const IDLE_SEATS = ["D", "7", "6", "5", "4", "3", "2", "1"] as const;

/** Seats exist before any shoe. Hero class only. Focus ring waits for a click or NEW SHOE. */
function idleSeatChrome(): string {
  return IDLE_SEATS.map((seat) => {
    const round = seat === "1" ? "seat-round your-seat" : "seat-round";
    return `<section class="seat" data-seat="${seat}"><div class="${round}">${seat}</div><div class="hand" id="hand-${seat}"></div></section>`;
  }).join("");
}

/**
 * NEW SHOE / NEXT HAND screen. `#cardsGrid` and `#suitGrid` stay mounted.
 * This page does not strip either pad.
 */
export function presentNewShoeFragment(fragment: string): string {
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
      `<div class="table" id="table">${idleSeatChrome()}</div>`,
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

  let screen = "felt_idle_no_events";
  const paint = () => {
    root.innerHTML = presentNewShoeFragment(shell.html());
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
    bindRankPad(root, shell, paint);
    bindSuitPad(root, shell, paint);
    bindFocus(root);
    bindChartTips(root);
    root.setAttribute("data-screen", screen);
  };

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

/** Rank pad → POST observe-card on the focus seat. No suit is sent. */
function bindRankPad(root: AppRoot, shell: NewShoeShell, paint: () => void): void {
  for (const button of Array.from(root.querySelectorAll("#cardsGrid button"))) {
    button.addEventListener("click", () => {
      const rank = button.getAttribute("data-rank");
      if (!rank) return;
      const result = shell.pressRank(rank);
      if (!result.rejected) paint();
    });
  }
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

/** Focus ring is UI chrome. Clicking a seat header does not append an event. */
function bindFocus(root: AppRoot): void {
  const rounds = Array.from(root.querySelectorAll(".seat-round"));
  for (const round of rounds) {
    round.addEventListener("click", () => {
      for (const other of rounds) other.classList.remove("active");
      round.classList.add("active");
    });
  }
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
