import { COUNT_SYSTEMS, countTag, type CountSystem } from "../counting/maps.ts";
import { runningAce } from "../counting/running-ace.ts";
import type { DomainEvent } from "../write/events.ts";

/** Original shoe is 8 decks (`SHOE_DECKS` in modules/state.js). */
export const SHOE_DECKS = 8;
const CARDS_PER_DECK = 52;
const ACES_PER_DECK = 4;

export type ShoeStarted = {
  type: "shoe_started";
  decks: number;
};

export type EmptyShoeCounts = {
  acesLeft: number;
  decksLeft: number;
  ra: number;
};

/** Fresh shoe, no cards dealt: initRemaining + updateAll decksLeft / acesLeft. */
export function emptyShoeCounts(decks: number = SHOE_DECKS): EmptyShoeCounts {
  const totalRemaining = decks * CARDS_PER_DECK;
  const decksLeft = Math.max(totalRemaining / CARDS_PER_DECK, 0.01);
  const acesLeft = decks * ACES_PER_DECK;
  return {
    acesLeft,
    decksLeft,
    ra: runningAce(acesLeft, decksLeft),
  };
}

/** Counts / info bar after Shoe started, before any card is observed. */
export function projectCountsAfterShoeStarted(
  events: readonly ShoeStarted[],
): EmptyShoeCounts {
  const last = [...events].reverse().find((event) => event.type === "shoe_started");
  if (!last) {
    throw new Error("empty shoe requires shoe_started");
  }
  return emptyShoeCounts(last.decks);
}

const PANEL_CHROME = {
  id: "#infoBar",
  bg: "linear-gradient(#1e293b,#161b22)",
  padding: "12px",
  radius: "10px",
  font: "0.85rem",
  info_top: "flex space-evenly",
  counts_grid: "3-col center",
} as const;

const LAYOUT_ORDER =
  "row1: P, D, RA; row2 grid: Hi-Lo RC/TC, APC TC, Zen TC, Omega II TC, Ace TC";

export type CountsInfoBar = {
  layout_order: typeof LAYOUT_ORDER;
  penetration: string;
  decks_left: string;
  decksLeft: number;
  acesLeft: number;
  ra: {
    label: "RA:";
    value: string;
    numeric: number;
    colour: "#22c55e" | "#ef4444";
    className: "" | "negative";
  };
  hilo_rc: number;
  hilo_tc: string;
  hilo_display: string;
  apc_tc: string;
  zen_tc: string;
  omega_ii_tc: string;
  ace_tc: string;
  panel_chrome: typeof PANEL_CHROME;
};

type CountFold = {
  decks: number;
  totalRemaining: number;
  acesLeft: number;
  rc: Record<CountSystem, number>;
};

function zeroRc(): Record<CountSystem, number> {
  return { HiLo: 0, APC: 0, Zen: 0, OmegaII: 0 };
}

/**
 * Original `aceTC.toFixed(2)` (`strategy.js`), including the idle shoe.
 * No forced plus. Hi-Lo, APC, Zen, Omega II, and RA use the same rounding.
 */
function aceLabel(excess: number): string {
  return `Ace: ${excess.toFixed(2)}`;
}

function present(fold: CountFold): CountsInfoBar {
  const decksLeft = Math.max(fold.totalRemaining / CARDS_PER_DECK, 0.01);
  const penetration = ((1 - fold.totalRemaining / (fold.decks * CARDS_PER_DECK)) * 100).toFixed(2);
  const tc = (rc: number) => (decksLeft > 0.01 ? rc / decksLeft : 0);
  const hiloTc = tc(fold.rc.HiLo);
  const ra = runningAce(fold.acesLeft, decksLeft);
  const negative = ra < 0;

  return {
    layout_order: LAYOUT_ORDER,
    penetration: `P: ${penetration}%`,
    decks_left: `D: ${decksLeft.toFixed(2)}`,
    decksLeft,
    acesLeft: fold.acesLeft,
    ra: {
      label: "RA:",
      value: ra.toFixed(2),
      numeric: ra,
      colour: negative ? "#ef4444" : "#22c55e",
      className: negative ? "negative" : "",
    },
    hilo_rc: fold.rc.HiLo,
    hilo_tc: hiloTc.toFixed(2),
    hilo_display: `Hi-Lo: ${fold.rc.HiLo} / ${hiloTc.toFixed(2)}`,
    apc_tc: `APC: ${tc(fold.rc.APC).toFixed(2)}`,
    zen_tc: `Zen: ${tc(fold.rc.Zen).toFixed(2)}`,
    omega_ii_tc: `Omega II: ${tc(fold.rc.OmegaII).toFixed(2)}`,
    ace_tc: aceLabel(aceExcess(fold.acesLeft, decksLeft)),
    panel_chrome: PANEL_CHROME,
  };
}

/**
 * Counts / info bar.
 * Shoe started resets P/D/RA and running counts.
 * Card observed applies that rank's tags, penetration, and (for an ace) RA.
 * Ace side count is aces left per deck minus 4. It is not a −1 running tally.
 * Card withdrawn reverses that observe, including Omega II.
 * Hand completed does not — the shoe persists.
 */
export function projectCountsInfoBar(
  events: readonly DomainEvent[],
): CountsInfoBar {
  let fold: CountFold | undefined;

  for (const event of events) {
    if (event.type === "shoe_started") {
      fold = {
        decks: event.decks,
        totalRemaining: event.decks * CARDS_PER_DECK,
        acesLeft: event.decks * ACES_PER_DECK,
        rc: zeroRc(),
      };
    } else if (event.type === "card_observed" && fold) {
      fold.totalRemaining -= 1;
      for (const system of COUNT_SYSTEMS) {
        fold.rc[system] += countTag(system, event.rank);
      }
      if (event.rank === "A") {
        fold.acesLeft -= 1;
      }
    } else if (event.type === "card_withdrawn" && fold) {
      fold.totalRemaining += 1;
      for (const system of COUNT_SYSTEMS) {
        fold.rc[system] -= countTag(system, event.rank);
      }
      if (event.rank === "A") {
        fold.acesLeft += 1;
      }
    }
  }

  if (!fold) {
    throw new Error("counts info bar requires shoe_started");
  }

  return present(fold);
}

/** Aces remaining per deck, minus the 4-ace baseline. Empty shoe is 0. */
function aceExcess(acesLeft: number, decksLeft: number): number {
  return decksLeft > 0.01 ? acesLeft / decksLeft - 4 : 0;
}

/**
 * Presentation only. The array is synthetic projector input for the idle
 * screen (original `updateAll()` after `initRemaining()`, before NEW SHOE).
 * Callers must not append it. No `shoe_started` is recorded.
 */
export function freshShoeCountsInfoBar(): CountsInfoBar {
  return projectCountsInfoBar([{ type: "shoe_started", decks: SHOE_DECKS }]);
}
