import { RANKS, SUITS, type Rank, type Suit } from "../counting/maps.ts";
import { projectCountsInfoBar } from "../read/counts-info-bar.ts";
import { projectFeltTable } from "../read/felt-table.ts";
import { projectRemainingComposition } from "../read/remaining-composition.ts";
import { SEATS, type Seat } from "../write/events.ts";
import {
  TABLE_STREAM,
  type InMemoryEventStore,
} from "../write/in-memory-store.ts";
import { observeCard } from "../write/observe-card.ts";
import { setSuit } from "../write/set-suit.ts";
import { startShoe } from "../write/start-shoe.ts";

/** Pages-friendly command/query boundary. No network server. */
export const START_SHOE_PATH = "/commands/start-shoe";
export const OBSERVE_CARD_PATH = "/commands/observe-card";
export const SET_SUIT_PATH = "/commands/set-suit";
export const FELT_PATH = "/views/felt";
export const COUNTS_PATH = "/views/counts";
export const REMAINING_PATH = "/views/remaining";

export type HttpRequest = {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
};

export type HttpResponse = {
  status: number;
  body: unknown;
};

/**
 * POST start shoe / observe card / set suit → `{ ack, events, position }` only.
 * GET felt / counts / remaining → the existing projections.
 */
export function handleHttp(
  store: InMemoryEventStore,
  request: HttpRequest,
): HttpResponse {
  if (request.method === "POST" && request.path === START_SHOE_PATH) {
    const decks = readDecks(request.body);
    if (decks === undefined) {
      return { status: 400, body: { error: "decks_required" } };
    }
    const result = startShoe(store, { decks });
    return {
      status: 200,
      body: {
        ack: result.ack,
        events: result.events,
        position: result.position,
      },
    };
  }

  if (request.method === "POST" && request.path === OBSERVE_CARD_PATH) {
    const command = readObserveCard(request.body);
    if (!command) {
      return { status: 400, body: { error: "rank_and_seat_required" } };
    }
    const result = observeCard(store, command);
    return {
      status: 200,
      body: {
        ack: result.ack,
        events: result.events,
        position: result.position,
      },
    };
  }

  if (request.method === "POST" && request.path === SET_SUIT_PATH) {
    const command = readSetSuit(request.body);
    if (!command) {
      return { status: 400, body: { error: "suit_and_seat_required" } };
    }
    const result = setSuit(store, command);
    return {
      status: 200,
      body: {
        ack: result.ack,
        events: result.events,
        position: result.position,
      },
    };
  }

  const events = store.read(TABLE_STREAM);
  if (request.method === "GET" && request.path === FELT_PATH) {
    return { status: 200, body: projectFeltTable(events) };
  }
  if (request.method === "GET" && request.path === COUNTS_PATH) {
    return { status: 200, body: projectCountsInfoBar(events) };
  }
  if (request.method === "GET" && request.path === REMAINING_PATH) {
    return { status: 200, body: projectRemainingComposition(events) };
  }

  return { status: 404, body: { error: "not_found" } };
}

function readDecks(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null || !("decks" in body)) {
    return undefined;
  }
  const decks = (body as { decks: unknown }).decks;
  if (typeof decks !== "number") return undefined;
  return decks;
}

/** Rank and seat only. Extra fields (suit) are not forwarded. */
function readObserveCard(body: unknown): { rank: Rank; seat: Seat } | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  if (!("rank" in body) || !("seat" in body)) return undefined;
  const rank = (body as { rank: unknown }).rank;
  const seat = (body as { seat: unknown }).seat;
  if (!isRank(rank) || !isSeat(seat)) return undefined;
  return { rank, seat };
}

/** Suit and seat only. Extra fields (rank) are not forwarded. */
function readSetSuit(body: unknown): { suit: Suit; seat: Seat } | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  if (!("suit" in body) || !("seat" in body)) return undefined;
  const suit = (body as { suit: unknown }).suit;
  const seat = (body as { seat: unknown }).seat;
  if (!isSuit(suit) || !isSeat(seat)) return undefined;
  return { suit, seat };
}

function isRank(value: unknown): value is Rank {
  return typeof value === "string" && (RANKS as readonly string[]).includes(value);
}

function isSuit(value: unknown): value is Suit {
  return typeof value === "string" && (SUITS as readonly string[]).includes(value);
}

function isSeat(value: unknown): value is Seat {
  return typeof value === "string" && (SEATS as readonly string[]).includes(value);
}
