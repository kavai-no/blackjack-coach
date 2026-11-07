import { handleHttp, type HttpRequest } from "../http/handle.ts";
import { createNewShoeShell } from "../ui/new-shoe-shell.ts";
import { createInMemoryEventStore } from "../write/in-memory-store.ts";

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
};

type PageDocument = {
  querySelector(selector: string): AppRoot | null;
};

const IDLE_SEATS = ["D", "7", "6", "5", "4", "3", "2", "1"] as const;

/** Seats exist before any shoe so the player can move the focus ring. Not a projection. */
function idleSeatChrome(): string {
  return IDLE_SEATS.map((seat) => {
    const round = seat === "1" ? "seat-round active your-seat" : "seat-round";
    return `<section class="seat" data-seat="${seat}"><div class="${round}">${seat}</div><div class="hand" id="hand-${seat}"></div></section>`;
  }).join("");
}

/**
 * NEW SHOE / NEXT HAND screen. The shell also emits the rank pad and the suit pad;
 * this page does not paint either pad.
 */
export function presentNewShoeFragment(fragment: string): string {
  const withoutPads = fragment
    .replace(/<div id="cardsGrid">[\s\S]*?<\/div>\n?/, "")
    .replace(/<div id="suitGrid">[\s\S]*?<\/div>\n?/, "");
  return withoutPads
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
export function mountNewShoePage(document: PageDocument, confirm: Confirm): void {
  const root = document.querySelector("#app");
  if (!root) {
    throw new Error("#app missing");
  }
  const store = createInMemoryEventStore();
  const shell = createNewShoeShell(
    (request: HttpRequest) => handleHttp(store, request),
    confirm,
  );

  const paint = () => {
    root.innerHTML = presentNewShoeFragment(shell.html());
    root.querySelector("#shuffleBtn")?.addEventListener("click", () => {
      const result = shell.pressNewShoe();
      if (!result.cancelled) paint();
    });
    root.querySelector("#nextHandBtn")?.addEventListener("click", () => {
      const result = shell.pressNextHand();
      if (!result.rejected) paint();
    });
    bindFocus(root);
    bindSuitTips(root);
  };

  paint();
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

/** Suit-slice hover shows the projection tooltip. No command. */
function bindSuitTips(root: AppRoot): void {
  const tip = root.querySelector(".d3-tooltip");
  if (!tip) return;
  for (const slice of Array.from(root.querySelectorAll(".suit-slice"))) {
    slice.addEventListener("mouseenter", () => {
      tip.textContent = slice.getAttribute("data-tip");
      tip.hidden = false;
    });
    slice.addEventListener("mouseleave", () => {
      tip.hidden = true;
    });
  }
}
