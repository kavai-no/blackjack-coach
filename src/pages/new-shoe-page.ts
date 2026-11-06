import { handleHttp, type HttpRequest } from "../http/handle.ts";
import { createNewShoeShell } from "../ui/new-shoe-shell.ts";
import { createInMemoryEventStore } from "../write/in-memory-store.ts";

export type Confirm = (message: string) => boolean;

type Clickable = {
  addEventListener(type: "click", listener: () => void): void;
};

type AppRoot = {
  innerHTML: string;
  querySelector(selector: string): Clickable | null;
};

type PageDocument = {
  querySelector(selector: string): AppRoot | null;
};

/**
 * NEW SHOE screen only. The shell also emits the rank pad; this page does not
 * paint it (suit pad and observe stay later slices).
 */
export function presentNewShoeFragment(fragment: string): string {
  const withoutPads = fragment.replace(
    /<div id="cardsGrid">[\s\S]*?<\/div>\n?/,
    "",
  );
  return withoutPads
    .replace(
      '<button id="shuffleBtn" type="button">NEW SHOE</button>',
      '<div class="topbar"><button class="btn shuffle" id="shuffleBtn" type="button">NEW SHOE</button></div>',
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
      '<div id="combinedChart"></div>',
      '<div class="bottom"><div class="charts-grid"><div id="combinedChart"></div></div></div>',
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
  };

  paint();
}
