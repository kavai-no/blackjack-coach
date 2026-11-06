import { projectCountsInfoBar } from "../read/counts-info-bar.ts";
import { projectFeltTable } from "../read/felt-table.ts";
import { projectRemainingComposition } from "../read/remaining-composition.ts";
import {
  TABLE_STREAM,
  type InMemoryEventStore,
} from "../write/in-memory-store.ts";
import { startShoe } from "../write/start-shoe.ts";

/** Pages-friendly command/query boundary. No network server. */
export const START_SHOE_PATH = "/commands/start-shoe";
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
 * POST start shoe → `{ ack, events, position }` only.
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
