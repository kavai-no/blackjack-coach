import { RANKS, type Rank, type Suit } from "../counting/maps.ts";
import { SHOE_DECKS } from "./counts-info-bar.ts";
import { type CardSeat, type DomainEvent } from "../write/events.ts";

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
 *  Card withdrawn restores that rank, and the suit unit only if one was set.
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
      const card: TrackedCard = {
        rank: event.rank,
        suit: null,
        seat: event.seat,
      };
      cardsOn(tracked, event.seat).push(card);
    } else if (event.type === "card_suit_set" && composition) {
      const card = cardsOn(tracked, event.seat).at(-1);
      if (!card) {
        throw new Error(`no observed card on seat ${event.seat}`);
      }
      moveSuit(composition, card.rank, card.suit, event.suit);
      card.suit = event.suit;
    } else if (event.type === "hand_split" && composition) {
      const pile = cardsOn(tracked, event.seat);
      const [first, second] = pile;
      if (pile.length !== 2 || first === undefined || second === undefined) {
        throw new Error(`hand_split on seat ${event.seat} lost its cards`);
      }
      const a = `${event.seat}A` as CardSeat;
      const b = `${event.seat}B` as CardSeat;
      first.seat = a;
      second.seat = b;
      tracked[a] = [first];
      tracked[b] = [second];
      tracked[event.seat] = [];
    } else if (event.type === "card_withdrawn" && composition) {
      const seatCards = cardsOn(tracked, event.seat);
      const card = seatCards.at(-1);
      if (!card) {
        throw new Error("card_withdrawn with no registered card");
      }
      if (card.rank !== event.rank) {
        throw new Error("card_withdrawn is not the last registered card of that pile");
      }
      seatCards.pop();

      const slice = composition.remaining_by_rank.find(
        (row) => row.rank === card.rank,
      );
      if (!slice) {
        throw new Error(`no remaining slice for rank ${card.rank}`);
      }
      slice.count += 1;
      if (card.suit) {
        const restored = suitCell(composition, card.rank, card.suit);
        restored.bySuit.count += 1;
        restored.byRankSuit.count += 1;
      }
    }
  }

  if (!composition) {
    throw new Error("remaining composition requires shoe_started");
  }
  return composition;
}

/**
 * Presentation only. Synthetic projector input for the idle donut
 * (`charting.js` initial 32s and 104s). Callers must not append it.
 */
export function freshShoeRemaining(): RemainingComposition {
  return projectRemainingComposition([
    { type: "shoe_started", decks: SHOE_DECKS },
  ]);
}

type TrackedCard = { rank: Rank; suit: Suit | null; seat: CardSeat };

function emptyTracked(): Record<string, TrackedCard[]> {
  return {};
}

function cardsOn(tracked: Record<string, TrackedCard[]>, seat: CardSeat): TrackedCard[] {
  const list = tracked[seat] ?? [];
  tracked[seat] = list;
  return list;
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
