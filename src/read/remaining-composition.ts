import { RANKS, type Rank, type Suit } from "../counting/maps.ts";
import { SEATS, type DomainEvent, type Seat } from "../write/events.ts";

/** Donut draw order (HCL inner pie), not `state.js` storage order. */
const SUIT_DRAW = [
  { suit: "spades", symbol: "♠", colour: "#000" },
  { suit: "clubs", symbol: "♣", colour: "#006400" },
  { suit: "hearts", symbol: "♥", colour: "#dc2626" },
  { suit: "diamonds", symbol: "♦", colour: "#00008b" },
] as const satisfies readonly { suit: Suit; symbol: string; colour: string }[];

const RANK_COLOURS = [
  "#ef4444",
  "#f97316",
  "#facc15",
  "#a3e635",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#6366f1",
  "#1e40af",
  "#dc2626",
  "#991b1b",
] as const;

export type RemainingComposition = {
  remaining_by_rank: { rank: Rank; count: number }[];
  remaining_by_suit: { suit: Suit; count: number }[];
  remaining_by_rank_suit: { rank: Rank; suit: Suit; count: number }[];
  outer_rank_ring: {
    order: "A,2,3,4,5,6,7,8,9,10,J,Q,K";
    label: "slice label = remaining count";
    colours: readonly string[];
    geometry: "donut ring: outerRadius≈0.8·half, innerRadiusBase≈0.5·outer";
  };
  inner_suit_pie: {
    draw_order: "spades, clubs, hearts, diamonds";
    symbols: readonly ["♠", "♣", "♥", "♦"];
    colours: readonly ["#000", "#006400", "#dc2626", "#00008b"];
    geometry: "pie from center to innerRadiusBase; label = suit symbol";
  };
  tooltip: {
    format: "{label}: {value}";
    on: "hover rank or suit slice";
    style: "dark rgba tooltip .d3-tooltip";
  };
  chart_host: {
    id: "#combinedChart";
    note: "D3 render is implement detail; ResizeObserver re-renders on size change";
  };
};

const PRESENTATION = {
  outer_rank_ring: {
    order: "A,2,3,4,5,6,7,8,9,10,J,Q,K",
    label: "slice label = remaining count",
    colours: RANK_COLOURS,
    geometry: "donut ring: outerRadius≈0.8·half, innerRadiusBase≈0.5·outer",
  },
  inner_suit_pie: {
    draw_order: "spades, clubs, hearts, diamonds",
    symbols: ["♠", "♣", "♥", "♦"],
    colours: ["#000", "#006400", "#dc2626", "#00008b"],
    geometry: "pie from center to innerRadiusBase; label = suit symbol",
  },
  tooltip: {
    format: "{label}: {value}",
    on: "hover rank or suit slice",
    style: "dark rgba tooltip .d3-tooltip",
  },
  chart_host: {
    id: "#combinedChart",
    note: "D3 render is implement detail; ResizeObserver re-renders on size change",
  },
} as const satisfies Pick<
  RemainingComposition,
  "outer_rank_ring" | "inner_suit_pie" | "tooltip" | "chart_host"
>;

function fullShoe(decks: number): RemainingComposition {
  return {
    remaining_by_rank: RANKS.map((rank) => ({ rank, count: decks * 4 })),
    remaining_by_suit: SUIT_DRAW.map((entry) => ({
      suit: entry.suit,
      count: decks * 13,
    })),
    remaining_by_rank_suit: RANKS.flatMap((rank) =>
      SUIT_DRAW.map((entry) => ({
        rank,
        suit: entry.suit,
        count: decks,
      })),
    ),
    ...PRESENTATION,
  };
}

/** Remaining composition.
 *  Shoe started fills the shoe. Hand completed leaves it.
 *  Card observed decrements that rank on the outer ring only.
 *  Card suit set moves one unit onto that suit (and that rank×suit).
 *  A later suit on the same card moves the unit off the previous suit.
 */
export function projectRemainingComposition(
  events: readonly DomainEvent[],
): RemainingComposition {
  let composition: RemainingComposition | undefined;
  let tracked = emptyTracked();

  for (const event of events) {
    if (event.type === "shoe_started") {
      composition = fullShoe(event.decks);
      tracked = emptyTracked();
    } else if (event.type === "card_observed" && composition) {
      const slice = composition.remaining_by_rank.find(
        (row) => row.rank === event.rank,
      );
      if (!slice) {
        throw new Error(`no remaining slice for rank ${event.rank}`);
      }
      slice.count -= 1;
      tracked[event.seat].push({ rank: event.rank, suit: null });
    } else if (event.type === "card_suit_set" && composition) {
      const card = tracked[event.seat].at(-1);
      if (!card) {
        throw new Error(`no observed card on seat ${event.seat}`);
      }
      moveSuit(composition, card.rank, card.suit, event.suit);
      card.suit = event.suit;
    }
  }

  if (!composition) {
    throw new Error("remaining composition requires shoe_started");
  }
  return composition;
}

type TrackedCard = { rank: Rank; suit: Suit | null };

function emptyTracked(): Record<Seat, TrackedCard[]> {
  const tracked = {} as Record<Seat, TrackedCard[]>;
  for (const seat of SEATS) tracked[seat] = [];
  return tracked;
}

function moveSuit(
  composition: RemainingComposition,
  rank: Rank,
  from: Suit | null,
  to: Suit,
): void {
  if (from === to) return;
  if (from) {
    const previous = suitCell(composition, rank, from);
    previous.bySuit.count += 1;
    previous.byRankSuit.count += 1;
  }
  const next = suitCell(composition, rank, to);
  next.bySuit.count -= 1;
  next.byRankSuit.count -= 1;
}

function suitCell(composition: RemainingComposition, rank: Rank, suit: Suit) {
  const bySuit = composition.remaining_by_suit.find((row) => row.suit === suit);
  const byRankSuit = composition.remaining_by_rank_suit.find(
    (row) => row.rank === rank && row.suit === suit,
  );
  if (!bySuit || !byRankSuit) {
    throw new Error(`no remaining cell for ${rank} of ${suit}`);
  }
  return { bySuit, byRankSuit };
}
