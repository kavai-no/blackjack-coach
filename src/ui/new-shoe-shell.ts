import {
  COUNTS_PATH,
  FELT_PATH,
  REMAINING_PATH,
  START_SHOE_PATH,
  type HttpRequest,
  type HttpResponse,
} from "../http/handle.ts";
import {
  SHOE_DECKS,
  type CountsInfoBar,
} from "../read/counts-info-bar.ts";
import type { FeltTable } from "../read/felt-table.ts";
import type { RemainingComposition } from "../read/remaining-composition.ts";

/** Original `#shuffleBtn` confirm before a fresh 8-deck shoe. */
export const NEW_SHOE_CONFIRM = "Start fresh 8-deck shoe?";

export type NewShoeShell = {
  html(): string;
  pressNewShoe():
    | { cancelled: true }
    | { cancelled: false; post: HttpResponse; html: string };
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
      page = renderNewShoe(felt, counts, remaining);
      return { cancelled: false, post, html: page };
    },
  };
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
  return `<button id="shuffleBtn" type="button">NEW SHOE</button>\n${body}`;
}

function renderIdle(): string {
  return frame(
    `<div id="table"></div>\n<section id="infoBar"></section>\n<div id="combinedChart"></div>`,
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
  const cards = pile.cards
    .map((card) => {
      const face = "mini_card_face" in card ? card.mini_card_face.face : card.rank;
      return `<div class="mini">${face}</div>`;
    })
    .join("");
  const totals = felt.hand_totals
    .filter((total) => total.seat === pile.seat && total.hand === undefined)
    .map(
      (total) =>
        `<div class="hand-total" style="color:${total.colour}">${total.label}</div>`,
    )
    .join("");
  return `<section class="seat" data-seat="${pile.seat}"><div class="${classes.join(" ")}">${pile.seat}</div>${totals}<div class="hand" id="hand-${pile.seat}">${cards}</div></section>`;
}

function renderInfo(counts: CountsInfoBar): string {
  const chrome = counts.panel_chrome;
  return `<section id="infoBar" data-chrome-id="${chrome.id}" style="background:${chrome.bg};padding:${chrome.padding};border-radius:${chrome.radius};font-size:${chrome.font}"><div class="info-top" data-info-top="${chrome.info_top}" data-layout="${counts.layout_order}"><span id="penetration">${counts.penetration}</span><span id="decksLeft">${counts.decks_left}</span><span id="ra" class="${counts.ra.className}" data-value="${counts.ra.value}" style="color:${counts.ra.colour}">${counts.ra.label} ${counts.ra.numeric}</span></div><div class="counts" data-counts-grid="${chrome.counts_grid}"><span id="hiLo">${counts.hilo_display}</span><span id="apcTC">${counts.apc_tc}</span><span id="zenTC">${counts.zen_tc}</span><span id="omegaIITC">${counts.omega_ii_tc}</span><span id="aceTC">${counts.ace_tc}</span></div></section>`;
}

function renderDonut(remaining: RemainingComposition): string {
  const hostId = remaining.chart_host.id.startsWith("#")
    ? remaining.chart_host.id.slice(1)
    : remaining.chart_host.id;
  const json = JSON.stringify(remaining).replaceAll("<", "\\u003c");
  return `<div id="${hostId}"></div>\n<script type="application/json" id="combinedChart-data">${json}</script>`;
}
