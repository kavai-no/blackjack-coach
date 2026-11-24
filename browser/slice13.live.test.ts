import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { projectFeltTable } from "../src/read/felt-table.ts";
import type { DomainEvent } from "../src/write/events.ts";

/**
 * Live Pages entry for slice 13. Serves `dist/` under `/blackjack-coach/`.
 * boot.js mounts the page. Helpers are copied for this file only.
 * `pickSuitRandom` is 0, so a rank click's auto-suit is spades.
 * The suit pad corrects a suit when the journey names one.
 * Backspace is the only withdraw control. There is no ⌫ button.
 * NEXT HAND is not used.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const BASE = "/blackjack-coach";
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;

type LiveEvent = {
  type: string;
  position: number;
  rank?: string;
  seat?: string;
  suit?: string;
};

function contentType(file: string): string {
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  return "text/html; charset=utf-8";
}

function startServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let path = decodeURIComponent(url.pathname);
    if (path === BASE || path === `${BASE}/`) path = `${BASE}/index.html`;
    if (!path.startsWith(`${BASE}/`)) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    const relative = path.slice(BASE.length + 1);
    const file = normalize(join(dist, relative));
    if (!file.startsWith(dist + sep) && file !== join(dist, relative)) {
      response.writeHead(403);
      response.end("forbidden");
      return;
    }
    if (!existsSync(file)) {
      response.writeHead(404);
      response.end("missing");
      return;
    }
    response.writeHead(200, { "content-type": contentType(file) });
    response.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("no port");
      }
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

function readHistory(page: Page): Promise<LiveEvent[]> {
  return page.evaluate(() => {
    const read = Reflect.get(globalThis, "readTable");
    if (typeof read !== "function") {
      throw new Error("readTable missing");
    }
    return read();
  });
}

/** `readTable` facts, without the store position, for `projectFeltTable`. */
function recordedFacts(history: LiveEvent[]): DomainEvent[] {
  return history.map((event) => {
    const { position: _position, ...fact } = event;
    return fact as DomainEvent;
  });
}

async function openLive(origin: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "pickSuitRandom", {
      configurable: true,
      enumerable: false,
      writable: false,
      value: 0,
    });
  });
  page.on("dialog", (dialog) => {
    if (dialog.message() !== "Start fresh 8-deck shoe?") {
      throw new Error(dialog.message());
    }
    return dialog.accept();
  });
  await page.goto(`${origin}${BASE}/`);
  await page.locator('#app[data-screen="felt_idle_no_events"]').waitFor();
  return { browser, page };
}

let built = false;
function buildDist(): void {
  if (built) return;
  execFileSync(process.execPath, ["scripts/build-pages.mjs"], {
    cwd: root,
    stdio: "inherit",
  });
  built = true;
}

async function close(server: Server, browser: Browser | undefined): Promise<void> {
  await browser?.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function infoBar(page: Page): Promise<Record<string, string>> {
  const bar = {
    p: (await page.locator("#penetration").innerText()).trim(),
    d: (await page.locator("#decksLeft").innerText()).trim(),
    ra: (await page.locator("#ra").innerText()).trim(),
    hilo: (await page.locator("#hiLo").innerText()).trim(),
    apc: (await page.locator("#apcTC").innerText()).trim(),
    zen: (await page.locator("#zenTC").innerText()).trim(),
    omega: (await page.locator("#omegaIITC").innerText()).trim(),
    ace: (await page.locator("#aceTC").innerText()).trim(),
  };
  assert.equal(/[+]/.test(Object.values(bar).join(" ")), false);
  return bar;
}

async function hoverSuit(page: Page, suit: string): Promise<string> {
  await page.locator(`#combinedChart .suit-slice[data-suit="${suit}"]`).hover();
  return (await page.locator("#combinedChart .d3-tooltip").innerText()).trim();
}

async function rankCounts(page: Page): Promise<Record<string, string>> {
  const counts: Record<string, string> = {};
  for (const rank of RANKS) {
    counts[rank] = (
      await page.locator(`#combinedChart .rank-label[data-chart-rank="${rank}"]`).textContent()
    )?.trim() ?? "";
  }
  return counts;
}

async function newShoe(page: Page): Promise<void> {
  const shoe = page.getByRole("button", { name: "NEW SHOE" });
  assert.equal(await shoe.isVisible(), true);
  assert.equal(await shoe.isEnabled(), true);
  await shoe.click();
  await page.locator('#app[data-screen="felt_new_shoe"]').waitFor();
  assert.equal(await page.locator("#backspaceBtn").count(), 0);
  assert.equal(await page.locator("button", { hasText: "⌫" }).count(), 0);
}

async function clickSeat(page: Page, seat: string): Promise<void> {
  const header = page.locator(`[data-seat="${seat}"] .seat-round`);
  assert.equal(await header.isVisible(), true);
  await header.click();
}

async function clickRank(page: Page, rank: string): Promise<void> {
  const button = page.locator(`#cardsGrid button[data-rank="${rank}"]`);
  assert.equal(await button.isVisible(), true);
  assert.equal(await button.isEnabled(), true);
  await button.click();
}

async function clickSuit(page: Page, suit: string): Promise<void> {
  const button = page.locator(`#suitGrid button[data-suit="${suit}"]`);
  assert.equal(await button.isVisible(), true);
  assert.equal(await button.isEnabled(), true);
  await button.click();
}

async function ringOn(page: Page, seat: string): Promise<boolean> {
  return page.locator(`[data-seat="${seat}"] .seat-round`).evaluate((element) => {
    return element.classList.contains("active");
  });
}

async function assertRing(page: Page, seat: string): Promise<void> {
  assert.equal(await ringOn(page, seat), true, seat);
  assert.equal(await page.locator(".seat-round.active").count(), 1);
  assert.match(
    await page
      .locator(`[data-seat="${seat}"] .seat-round`)
      .evaluate((element) => getComputedStyle(element).boxShadow),
    /rgb\(0,\s*255,\s*136\)/,
  );
}

async function totalColour(page: Page, seat: string): Promise<string> {
  return page
    .locator(`[data-seat="${seat}"] .hand-total`)
    .first()
    .evaluate((element) => getComputedStyle(element).color);
}

async function backspace(page: Page): Promise<void> {
  await page.keyboard.press("Backspace");
}

/** NumLock-on numpad. This Chromium reports Numpad1 as End unless the event's key is the digit. */
const NUMPAD_ON: Record<string, { key: string; code: string; keyCode: number }> = {
  Numpad0: { key: "0", code: "Numpad0", keyCode: 96 },
  Numpad1: { key: "1", code: "Numpad1", keyCode: 97 },
  Numpad2: { key: "2", code: "Numpad2", keyCode: 98 },
  Numpad3: { key: "3", code: "Numpad3", keyCode: 99 },
  Numpad4: { key: "4", code: "Numpad4", keyCode: 100 },
  Numpad5: { key: "5", code: "Numpad5", keyCode: 101 },
  Numpad6: { key: "6", code: "Numpad6", keyCode: 102 },
  Numpad7: { key: "7", code: "Numpad7", keyCode: 103 },
  Numpad8: { key: "8", code: "Numpad8", keyCode: 104 },
  Numpad9: { key: "9", code: "Numpad9", keyCode: 105 },
  NumpadDivide: { key: "/", code: "NumpadDivide", keyCode: 111 },
  NumpadMultiply: { key: "*", code: "NumpadMultiply", keyCode: 106 },
  NumpadSubtract: { key: "-", code: "NumpadSubtract", keyCode: 109 },
};

async function dispatchKey(
  page: Page,
  key: string,
  code: string,
  keyCode: number,
): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    text: key,
    unmodifiedText: key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    location: code.startsWith("Numpad") ? 3 : 0,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
  });
  await session.detach();
}

async function pressKey(page: Page, key: string): Promise<void> {
  const numpad = NUMPAD_ON[key];
  if (numpad) {
    await dispatchKey(page, numpad.key, numpad.code, numpad.keyCode);
    return;
  }
  try {
    await page.keyboard.press(key);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Unknown key")) throw error;
    // Playwright's US layout has no å/Å. Same CDP channel as keyboard.press.
    await dispatchKey(page, key, "BracketRight", 221);
  }
}

const YELLOW = "rgb(255, 212, 63)";
const CYAN = "rgb(0, 255, 245)";
const PILE_RING = "rgb(34, 197, 94)";

async function assertNoWithdraw(page: Page): Promise<void> {
  assert.equal(await page.locator("#backspaceBtn").count(), 0);
  assert.equal(await page.locator("button", { hasText: "⌫" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /withdraw|backspace/i }).count(), 0);
}

async function assertSplitFocus(page: Page, hand: "A" | "B"): Promise<void> {
  await assertRing(page, "1");
  const pileA = page.locator("#split-1 .split-hand").nth(0);
  const pileB = page.locator("#split-1 .split-hand").nth(1);
  const active = hand === "A" ? pileA : pileB;
  const idle = hand === "A" ? pileB : pileA;
  assert.equal(await active.evaluate((element) => element.classList.contains("active")), true);
  assert.equal(await idle.evaluate((element) => element.classList.contains("active")), false);
  assert.equal(
    await active.evaluate((element) => getComputedStyle(element).borderTopColor),
    PILE_RING,
  );
  assert.notEqual(
    await idle.evaluate((element) => getComputedStyle(element).borderTopColor),
    PILE_RING,
  );
}

async function splitEights(page: Page): Promise<void> {
  // No hero step: split needs no hero (split_on_every_player_seat, 03).
  assert.equal(
    await page.locator('[data-seat="1"] .seat-round').evaluate((element) => {
      return getComputedStyle(element).backgroundColor;
    }),
    "rgb(22, 101, 52)",
  );

  await clickSeat(page, "1");
  await clickRank(page, "8");
  await page.locator('#hand-1 .mini[data-rank="8"][data-suit="spades"]').waitFor();
  await clickSeat(page, "1");
  await clickRank(page, "8");
  await page.locator('#hand-1 .mini[data-suit="spades"]').nth(1).waitFor();
  await clickSuit(page, "hearts");
  await page.locator('#hand-1 .mini[data-suit="hearts"]').waitFor();
  assert.equal((await page.locator('[data-seat="1"] .hand-total').innerText()).trim(), "Total: 16");
  assert.equal(await totalColour(page, "1"), YELLOW);

  const split = page.locator("#splitBtn-1");
  assert.equal(await split.isVisible(), true);
  assert.equal(await split.isEnabled(), true);
  await split.click();
  await page.locator("#hand-1A .mini").waitFor();
  await page.locator("#hand-1B .mini").waitFor();
  assert.equal(await page.locator('#hand-1A .mini[data-rank="8"][data-suit="spades"]').count(), 1);
  assert.equal(await page.locator('#hand-1B .mini[data-rank="8"][data-suit="hearts"]').count(), 1);
  assert.equal((await page.locator("#hand-1A .hand-total").innerText()).trim(), "Total: 8");
  assert.equal((await page.locator("#hand-1B .hand-total").innerText()).trim(), "Total: 8");
  assert.equal(
    await page.locator("#hand-1A .hand-total").evaluate((element) => getComputedStyle(element).color),
    YELLOW,
  );
  assert.equal(
    await page.locator("#hand-1B .hand-total").evaluate((element) => getComputedStyle(element).color),
    YELLOW,
  );
  await assertSplitFocus(page, "A");
}

async function pileTotal(page: Page, hand: "A" | "B"): Promise<{ text: string; colour: string }> {
  const label = page.locator(`#hand-1${hand} .hand-total`);
  return {
    text: (await label.innerText()).trim(),
    colour: await label.evaluate((element) => getComputedStyle(element).color),
  };
}

test("felt_withdraw manual focus: Backspace removes seat 1's 5, not the later seat 2 king", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;
    await newShoe(page);

    await clickSeat(page, "1");
    await clickRank(page, "K");
    await page.locator('#hand-1 .mini[data-suit="spades"]').waitFor();
    await clickSuit(page, "hearts");
    await page.locator('#hand-1 .mini[data-suit="hearts"]').waitFor();

    await clickSeat(page, "1");
    await clickRank(page, "5");
    await page.locator('#hand-1 .mini[data-rank="5"][data-suit="spades"]').waitFor();
    await clickSuit(page, "clubs");
    await page.locator('#hand-1 .mini[data-rank="5"][data-suit="clubs"]').waitFor();

    await clickRank(page, "K");
    await page.locator('#hand-2 .mini[data-suit="spades"]').waitFor();

    assert.equal((await page.locator('[data-seat="1"] .hand-total').innerText()).trim(), "Total: 15");
    assert.equal(await totalColour(page, "1"), "rgb(255, 212, 63)");
    assert.equal((await page.locator('[data-seat="2"] .hand-total').innerText()).trim(), "Total: 10");
    assert.equal(await totalColour(page, "2"), "rgb(255, 212, 63)");

    await clickSeat(page, "1");
    await assertRing(page, "1");
    await backspace(page);
    await page.locator("#hand-1 .mini").nth(0).waitFor();

    assert.equal(await page.locator("#hand-1 .mini").count(), 1);
    assert.equal(await page.locator('#hand-1 .mini[data-rank="K"][data-suit="hearts"]').count(), 1);
    assert.equal(await page.locator('#hand-1 .mini[data-rank="5"]').count(), 0);
    assert.equal((await page.locator('[data-seat="1"] .hand-total').innerText()).trim(), "Total: 10");
    assert.equal(await totalColour(page, "1"), "rgb(255, 212, 63)");
    assert.equal(await page.locator("#hand-2 .mini").count(), 1);
    assert.equal(await page.locator('#hand-2 .mini[data-rank="K"][data-suit="spades"]').count(), 1);
    assert.equal((await page.locator('[data-seat="2"] .hand-total').innerText()).trim(), "Total: 10");
    assert.equal(await totalColour(page, "2"), "rgb(255, 212, 63)");
    await assertRing(page, "1");

    assert.deepEqual(await infoBar(page), {
      p: "P: 0.48%",
      d: "D: 7.96",
      ra: "RA: -0.87",
      hilo: "Hi-Lo: -2 / -0.25",
      apc: "APC: -0.75",
      zen: "Zen: -0.50",
      omega: "Omega II: -0.50",
      ace: "Ace: 0.02",
    });
    const counts = await rankCounts(page);
    for (const rank of RANKS) {
      assert.equal(counts[rank], rank === "K" ? "30" : "32", rank);
    }
    assert.equal(await hoverSuit(page, "spades"), "♠: 103");
    assert.equal(await hoverSuit(page, "clubs"), "♣: 104");
    assert.equal(await hoverSuit(page, "hearts"), "♥: 103");
    assert.equal(await hoverSuit(page, "diamonds"), "♦: 104");

    const history = await readHistory(page);
    const withdrawn = history.at(-1);
    assert.equal(withdrawn?.type, "card_withdrawn");
    assert.equal(withdrawn?.rank, "5");
    assert.equal(withdrawn?.seat, "1");
    assert.equal(withdrawn !== undefined && "suit" in withdrawn, false);
  } finally {
    await close(server, browser);
  }
});

test("felt_withdraw auto-advance: Backspace removes the last-entered 5 while seat 2 stays focused", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;
    await newShoe(page);

    await clickSeat(page, "1");
    await clickRank(page, "K");
    await page.locator('#hand-1 .mini[data-suit="spades"]').waitFor();
    await clickSuit(page, "hearts");
    await page.locator('#hand-1 .mini[data-suit="hearts"]').waitFor();

    await clickSeat(page, "1");
    // felt_withdraw drives this five from the top-row key, not the rank pad.
    await page.keyboard.press("5");
    await page.locator('#hand-1 .mini[data-rank="5"][data-suit="spades"]').waitFor();
    await clickSuit(page, "clubs");
    await page.locator('#hand-1 .mini[data-rank="5"][data-suit="clubs"]').waitFor();

    await assertRing(page, "2");
    assert.equal(await ringOn(page, "1"), false);
    assert.equal((await page.locator("#hand-2").innerText()).trim(), "");

    await backspace(page);
    await page.locator('#hand-1 .mini[data-suit="hearts"]').waitFor();

    assert.equal(await page.locator("#hand-1 .mini").count(), 1);
    assert.equal(await page.locator('#hand-1 .mini[data-rank="K"][data-suit="hearts"]').count(), 1);
    assert.equal(await page.locator('#hand-1 .mini[data-rank="5"]').count(), 0);
    assert.equal((await page.locator('[data-seat="1"] .hand-total').innerText()).trim(), "Total: 10");
    assert.equal(await totalColour(page, "1"), "rgb(255, 212, 63)");
    assert.equal(await page.locator("#hand-2 .mini").count(), 0);
    assert.equal(await page.locator('[data-seat="2"] .hand-total').count(), 0);
    await assertRing(page, "2");

    assert.deepEqual(await infoBar(page), {
      p: "P: 0.24%",
      d: "D: 7.98",
      ra: "RA: -0.87",
      hilo: "Hi-Lo: -1 / -0.13",
      apc: "APC: -0.38",
      zen: "Zen: -0.25",
      omega: "Omega II: -0.25",
      ace: "Ace: 0.01",
    });
    const counts = await rankCounts(page);
    for (const rank of RANKS) {
      assert.equal(counts[rank], rank === "K" ? "31" : "32", rank);
    }
    assert.equal(await hoverSuit(page, "spades"), "♠: 104");
    assert.equal(await hoverSuit(page, "clubs"), "♣: 104");
    assert.equal(await hoverSuit(page, "hearts"), "♥: 103");
    assert.equal(await hoverSuit(page, "diamonds"), "♦: 104");

    const history = await readHistory(page);
    assert.equal(history.at(-1)?.type, "card_withdrawn");
    assert.equal(history.at(-1)?.rank, "5");
    assert.equal(history.at(-1)?.seat, "1");
  } finally {
    await close(server, browser);
  }
});

test("felt_withdraw manual empty seat: Backspace posts nothing", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;
    await newShoe(page);

    await clickSeat(page, "1");
    await clickRank(page, "K");
    await page.locator('#hand-1 .mini[data-suit="spades"]').waitFor();
    await clickSuit(page, "hearts");
    await clickSeat(page, "1");
    await clickRank(page, "5");
    await page.locator('#hand-1 .mini[data-rank="5"][data-suit="spades"]').waitFor();
    await clickSuit(page, "clubs");
    await page.locator('#hand-1 .mini[data-rank="5"][data-suit="clubs"]').waitFor();

    const before = await infoBar(page);
    const beforeCounts = await rankCounts(page);
    await clickSeat(page, "2");
    await assertRing(page, "2");
    const historyBefore = await readHistory(page);
    assert.equal(
      historyBefore.some((event) => event.type === "card_withdrawn"),
      false,
    );

    await backspace(page);

    assert.equal(await page.locator("#hand-1 .mini").count(), 2);
    assert.equal(await page.locator('#hand-1 .mini[data-rank="K"][data-suit="hearts"]').count(), 1);
    assert.equal(await page.locator('#hand-1 .mini[data-rank="5"][data-suit="clubs"]').count(), 1);
    assert.equal((await page.locator('[data-seat="1"] .hand-total').innerText()).trim(), "Total: 15");
    assert.equal(await totalColour(page, "1"), "rgb(255, 212, 63)");
    assert.equal(await page.locator("#hand-2 .mini").count(), 0);
    await assertRing(page, "2");
    assert.deepEqual(await readHistory(page), historyBefore);
    assert.deepEqual(await infoBar(page), before);
    assert.deepEqual(await infoBar(page), {
      p: "P: 0.48%",
      d: "D: 7.96",
      ra: "RA: -0.87",
      hilo: "Hi-Lo: 0 / 0.00",
      apc: "APC: 0.00",
      zen: "Zen: 0.00",
      omega: "Omega II: 0.00",
      ace: "Ace: 0.02",
    });
    const counts = await rankCounts(page);
    assert.deepEqual(counts, beforeCounts);
    for (const rank of RANKS) {
      const expected = rank === "K" || rank === "5" ? "31" : "32";
      assert.equal(counts[rank], expected, rank);
    }
    assert.equal(await hoverSuit(page, "spades"), "♠: 104");
    assert.equal(await hoverSuit(page, "clubs"), "♣: 103");
    assert.equal(await hoverSuit(page, "hearts"), "♥: 103");
    assert.equal(await hoverSuit(page, "diamonds"), "♦: 104");
  } finally {
    await close(server, browser);
  }
});

test("withdraw_card_split_b_equal_rank and due_pile_header_click_b_empty_a_done", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;
    await newShoe(page);
    await splitEights(page);

    await clickSeat(page, "1");
    await assertSplitFocus(page, "A");

    await page.keyboard.press("3");
    await page.locator('#hand-1A .mini[data-rank="3"][data-suit="spades"]').waitFor();
    assert.equal(await page.locator("#hand-1A .mini").count(), 2);
    assert.deepEqual(
      await page.locator("#hand-1A .mini").evaluateAll((cards) =>
        cards.map((card) => `${card.getAttribute("data-rank")}${card.getAttribute("data-suit")}`),
      ),
      ["8spades", "3spades"],
    );
    assert.deepEqual(await pileTotal(page, "A"), { text: "Total: 11", colour: YELLOW });
    // Slice 15: A's second card focuses B (keyboard_split_a_then_b_then_next_seat).
    await assertSplitFocus(page, "B");

    await clickSeat(page, "1");
    await assertSplitFocus(page, "A");

    await page.keyboard.press("[");
    await page.locator('#hand-1A .mini[data-rank="K"][data-suit="spades"]').waitFor();
    assert.equal(await page.locator("#hand-1A .mini").count(), 3);
    assert.deepEqual(
      await page.locator("#hand-1A .mini").evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("data-rank")),
      ),
      ["8", "3", "K"],
    );
    assert.deepEqual(await pileTotal(page, "A"), { text: "Total: 21", colour: CYAN });
    // Slice 15: 21 on A advances to open B (keyboard_twenty_one_auto_advances).
    await assertSplitFocus(page, "B");
    assert.deepEqual(await infoBar(page), {
      p: "P: 0.96%",
      d: "D: 7.92",
      ra: "RA: -0.87",
      hilo: "Hi-Lo: 0 / 0.00",
      apc: "APC: 0.13",
      zen: "Zen: -0.13",
      omega: "Omega II: -0.13",
      ace: "Ace: 0.04",
    });
    const beforeWithdraw = await rankCounts(page);
    for (const rank of RANKS) {
      const expected = rank === "3" || rank === "K" ? "31" : rank === "8" ? "30" : "32";
      assert.equal(beforeWithdraw[rank], expected, rank);
    }
    assert.equal(await hoverSuit(page, "spades"), "♠: 101");
    assert.equal(await hoverSuit(page, "clubs"), "♣: 104");
    assert.equal(await hoverSuit(page, "hearts"), "♥: 103");
    assert.equal(await hoverSuit(page, "diamonds"), "♦: 104");

    await clickSeat(page, "1");
    await assertSplitFocus(page, "B");
    assert.equal(await page.locator("#hand-1A").evaluate((element) => {
      return element.closest(".split-hand")?.classList.contains("active") ?? false;
    }), false);

    await backspace(page);
    await page.locator("#hand-1B .mini").waitFor({ state: "detached" });
    assert.equal(await page.locator("#hand-1A .mini").count(), 3);
    assert.equal(await page.locator('#hand-1A .mini[data-suit="spades"]').count(), 3);
    assert.deepEqual(await pileTotal(page, "A"), { text: "Total: 21", colour: CYAN });
    assert.equal(await page.locator("#hand-1B .mini").count(), 0);
    assert.equal(await page.locator('#hand-1B .mini[data-suit="hearts"]').count(), 0);
    assert.deepEqual(await pileTotal(page, "B"), { text: "Total: 8", colour: YELLOW });
    await assertNoWithdraw(page);
    await assertSplitFocus(page, "B");
    const withdrawn = (await readHistory(page)).at(-1);
    assert.equal(withdrawn?.type, "card_withdrawn");
    assert.equal(withdrawn?.rank, "8");
    assert.equal(withdrawn?.seat, "1B");
    assert.deepEqual(await infoBar(page), {
      p: "P: 0.72%",
      d: "D: 7.94",
      ra: "RA: -0.87",
      hilo: "Hi-Lo: 0 / 0.00",
      apc: "APC: 0.00",
      zen: "Zen: -0.13",
      omega: "Omega II: -0.13",
      ace: "Ace: 0.03",
    });
    const afterWithdraw = await rankCounts(page);
    for (const rank of RANKS) {
      const expected = rank === "3" || rank === "8" || rank === "K" ? "31" : "32";
      assert.equal(afterWithdraw[rank], expected, rank);
    }
    assert.equal(await hoverSuit(page, "spades"), "♠: 101");
    assert.equal(await hoverSuit(page, "clubs"), "♣: 104");
    assert.equal(await hoverSuit(page, "hearts"), "♥: 104");
    assert.equal(await hoverSuit(page, "diamonds"), "♦: 104");

    const frozen = await readHistory(page);
    const frozenInfo = await infoBar(page);
    const frozenCounts = await rankCounts(page);
    const frozenSuits = {
      spades: await hoverSuit(page, "spades"),
      clubs: await hoverSuit(page, "clubs"),
      hearts: await hoverSuit(page, "hearts"),
      diamonds: await hoverSuit(page, "diamonds"),
    };
    await clickSeat(page, "2");
    await assertRing(page, "2");
    await clickSeat(page, "1");
    await assertSplitFocus(page, "B");
    await backspace(page);
    assert.deepEqual(await readHistory(page), frozen);
    assert.deepEqual(await infoBar(page), frozenInfo);
    assert.deepEqual(await rankCounts(page), frozenCounts);
    assert.equal(await hoverSuit(page, "spades"), frozenSuits.spades);
    assert.equal(await hoverSuit(page, "clubs"), frozenSuits.clubs);
    assert.equal(await hoverSuit(page, "hearts"), frozenSuits.hearts);
    assert.equal(await hoverSuit(page, "diamonds"), frozenSuits.diamonds);
    assert.equal(await page.locator("#hand-1B .mini").count(), 0);
    assert.deepEqual(await pileTotal(page, "A"), { text: "Total: 21", colour: CYAN });
    assert.deepEqual(await pileTotal(page, "B"), { text: "Total: 8", colour: YELLOW });

    await page.keyboard.press("5");
    await page.locator('#hand-1B .mini[data-rank="5"][data-suit="spades"]').waitFor();
    assert.equal(await page.locator("#hand-1B .mini").count(), 1);
    assert.deepEqual(await pileTotal(page, "B"), { text: "Total: 5", colour: YELLOW });
    assert.equal(await page.locator("#hand-1A .mini").count(), 3);
    assert.deepEqual(await pileTotal(page, "A"), { text: "Total: 21", colour: CYAN });
    assert.deepEqual(await infoBar(page), {
      p: "P: 0.96%",
      d: "D: 7.92",
      ra: "RA: -0.87",
      hilo: "Hi-Lo: 1 / 0.13",
      apc: "APC: 0.38",
      zen: "Zen: 0.13",
      omega: "Omega II: 0.13",
      ace: "Ace: 0.04",
    });
    const afterFive = await rankCounts(page);
    for (const rank of RANKS) {
      const expected = rank === "3" || rank === "5" || rank === "8" || rank === "K" ? "31" : "32";
      assert.equal(afterFive[rank], expected, rank);
    }
    assert.equal(await hoverSuit(page, "spades"), "♠: 100");
    assert.equal(await hoverSuit(page, "clubs"), "♣: 104");
    assert.equal(await hoverSuit(page, "hearts"), "♥: 104");
    assert.equal(await hoverSuit(page, "diamonds"), "♦: 104");
  } finally {
    await close(server, browser);
  }
});

test("felt_withdraw ordinary auto-advance: seat 7, dealer, and a third card", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;
    await newShoe(page);

    await clickSeat(page, "7");
    await clickRank(page, "K");
    await page.locator('#hand-7 .mini[data-rank="K"]').waitFor();
    await assertRing(page, "D");

    await clickSeat(page, "7");
    await clickRank(page, "5");
    await page.locator('#hand-7 .mini[data-rank="5"]').waitFor();
    await assertRing(page, "1");

    await clickSeat(page, "1");
    await clickRank(page, "K");
    await clickSeat(page, "1");
    await clickRank(page, "K");
    await page.locator("#hand-1 .mini").nth(1).waitFor();
    await assertRing(page, "2");

    await clickSeat(page, "1");
    await clickRank(page, "9");
    await page.locator('#hand-1 .mini[data-rank="9"]').waitFor();
    // K+K+9 busts, so focus leaves seat 1 (keyboard_twenty_one_auto_advances).
    await assertRing(page, "2");

    await clickSeat(page, "D");
    await clickRank(page, "A");
    await page.locator('#hand-D .mini[data-rank="A"]').waitFor();
    await assertRing(page, "1");

    await clickSeat(page, "D");
    await clickRank(page, "3");
    await page.locator('#hand-D .mini[data-rank="3"]').waitFor();
    await assertRing(page, "D");
    assert.equal(await page.locator("#hand-D .mini").count(), 2);
    assert.equal(await page.locator("#hand-7 .mini").count(), 2);
  } finally {
    await close(server, browser);
  }
});

test("due_pile_header_click_b_nonempty_a_live", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;
    await newShoe(page);
    await splitEights(page);

    await page.keyboard.press("3");
    await page.locator('#hand-1A .mini[data-rank="3"][data-suit="spades"]').waitFor();
    assert.equal(await page.locator("#hand-1A .mini").count(), 2);
    assert.deepEqual(await pileTotal(page, "A"), { text: "Total: 11", colour: YELLOW });
    // Slice 15: A's second card focuses B, not seat 2.
    await assertSplitFocus(page, "B");
    assert.deepEqual(await infoBar(page), {
      p: "P: 0.72%",
      d: "D: 7.94",
      ra: "RA: -0.87",
      hilo: "Hi-Lo: 1 / 0.13",
      apc: "APC: 0.50",
      zen: "Zen: 0.13",
      omega: "Omega II: 0.13",
      ace: "Ace: 0.03",
    });
    const dealt = await rankCounts(page);
    for (const rank of RANKS) {
      const expected = rank === "3" ? "31" : rank === "8" ? "30" : "32";
      assert.equal(dealt[rank], expected, rank);
    }
    assert.equal(await hoverSuit(page, "spades"), "♠: 102");
    assert.equal(await hoverSuit(page, "clubs"), "♣: 104");
    assert.equal(await hoverSuit(page, "hearts"), "♥: 103");
    assert.equal(await hoverSuit(page, "diamonds"), "♦: 104");

    await clickSeat(page, "1");
    await assertSplitFocus(page, "A");
    assert.equal(await ringOn(page, "2"), false);
    await clickSeat(page, "1");
    await assertSplitFocus(page, "A");

    await backspace(page);
    await page.locator('#hand-1A .mini[data-rank="3"]').waitFor({ state: "detached" });
    assert.equal(await page.locator("#hand-1A .mini").count(), 1);
    assert.equal(await page.locator('#hand-1A .mini[data-rank="8"][data-suit="spades"]').count(), 1);
    assert.deepEqual(await pileTotal(page, "A"), { text: "Total: 8", colour: YELLOW });
    assert.equal(await page.locator('#hand-1B .mini[data-rank="8"][data-suit="hearts"]').count(), 1);
    assert.deepEqual(await pileTotal(page, "B"), { text: "Total: 8", colour: YELLOW });
    await assertSplitFocus(page, "A");
    const withdrawn = (await readHistory(page)).at(-1);
    assert.equal(withdrawn?.type, "card_withdrawn");
    assert.equal(withdrawn?.rank, "3");
    assert.equal(withdrawn?.seat, "1A");
    assert.deepEqual(await infoBar(page), {
      p: "P: 0.48%",
      d: "D: 7.96",
      ra: "RA: -0.87",
      hilo: "Hi-Lo: 0 / 0.00",
      apc: "APC: 0.25",
      zen: "Zen: 0.00",
      omega: "Omega II: 0.00",
      ace: "Ace: 0.02",
    });
    const left = await rankCounts(page);
    for (const rank of RANKS) {
      assert.equal(left[rank], rank === "8" ? "30" : "32", rank);
    }
    assert.equal(await hoverSuit(page, "spades"), "♠: 103");
    assert.equal(await hoverSuit(page, "clubs"), "♣: 104");
    assert.equal(await hoverSuit(page, "hearts"), "♥: 103");
    assert.equal(await hoverSuit(page, "diamonds"), "♦: 104");
  } finally {
    await close(server, browser);
  }
});

test("felt_table_new_shoe_clears_stale_totals on the real entry", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;
    await newShoe(page);
    await clickSeat(page, "1");
    await clickRank(page, "8");
    await page.locator('#hand-1 .mini[data-rank="8"][data-suit="spades"]').waitFor();
    await clickRank(page, "5");
    await page.locator('#hand-2 .mini[data-rank="5"][data-suit="spades"]').waitFor();
    await clickSeat(page, "1");
    await backspace(page);
    await page.locator("#hand-1 .mini").waitFor({ state: "detached" });

    assert.equal(await page.locator("#hand-1 .mini").count(), 0);
    assert.equal((await page.locator('[data-seat="1"] .hand-total').innerText()).trim(), "Total: 8");
    assert.equal(await totalColour(page, "1"), YELLOW);
    assert.equal(await page.locator('#hand-2 .mini[data-rank="5"][data-suit="spades"]').count(), 1);
    assert.equal((await page.locator('[data-seat="2"] .hand-total').innerText()).trim(), "Total: 5");
    assert.equal(await totalColour(page, "2"), YELLOW);

    await newShoe(page);
    assert.equal(await page.locator(".mini").count(), 0);
    assert.equal(await page.locator(".hand-total").count(), 0);
    for (const seat of ["D", "7", "6", "5", "4", "3", "2", "1"]) {
      assert.equal(await page.locator(`#hand-${seat} .mini`).count(), 0, seat);
      assert.equal(await page.locator(`[data-seat="${seat}"] .hand-total`).count(), 0, seat);
    }
  } finally {
    await close(server, browser);
  }
});

test("rank_keys_top_row_and_numpad_every_rank", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;
    const entry = `${origin}${BASE}/`;

    const keys: { key: string; rank: string }[] = [
      { key: "1", rank: "A" },
      { key: "2", rank: "2" },
      { key: "3", rank: "3" },
      { key: "4", rank: "4" },
      { key: "5", rank: "5" },
      { key: "6", rank: "6" },
      { key: "7", rank: "7" },
      { key: "8", rank: "8" },
      { key: "9", rank: "9" },
      { key: "0", rank: "10" },
      { key: "o", rank: "J" },
      { key: "p", rank: "Q" },
      { key: "[", rank: "K" },
      { key: "å", rank: "K" },
      { key: "Numpad1", rank: "A" },
      { key: "Numpad2", rank: "2" },
      { key: "Numpad3", rank: "3" },
      { key: "Numpad4", rank: "4" },
      { key: "Numpad5", rank: "5" },
      { key: "Numpad6", rank: "6" },
      { key: "Numpad7", rank: "7" },
      { key: "Numpad8", rank: "8" },
      { key: "Numpad9", rank: "9" },
      { key: "Numpad0", rank: "10" },
      { key: "NumpadDivide", rank: "J" },
      { key: "NumpadMultiply", rank: "Q" },
      { key: "NumpadSubtract", rank: "K" },
    ];

    async function fresh(): Promise<void> {
      await page.goto(entry);
      await page.locator('#app[data-screen="felt_idle_no_events"]').waitFor();
      await newShoe(page);
      await clickSeat(page, "1");
    }

    async function assertLanded(rank: string, label: string): Promise<void> {
      const painted = rank === "10" ? "T" : rank;
      const total =
        rank === "A"
          ? "11"
          : rank === "10" || rank === "J" || rank === "Q" || rank === "K"
            ? "10"
            : rank;
      const card = page.locator("#hand-1 .mini");
      try {
        await card.waitFor({ timeout: 3000 });
      } catch (error) {
        throw new Error(`${label}: card did not land`, { cause: error });
      }
      assert.equal(await page.locator(".mini").count(), 1, label);
      assert.equal(await page.locator("#hand-1 .mini").count(), 1, label);
      assert.equal((await page.locator("#hand-1 .corner.top-left").innerText()).trim(), painted, label);
      assert.equal(
        (await page.locator("#hand-1 .corner.bottom-right").innerText()).trim(),
        painted,
        label,
      );
      assert.equal(await page.locator('#hand-1 .mini[data-suit="spades"]').count(), 1, label);
      assert.equal((await page.locator("#hand-1 .suit.top-right").innerText()).trim(), "♠", label);
      const totalLabel = page.locator('[data-seat="1"] .hand-total');
      assert.equal((await totalLabel.innerText()).trim(), `Total: ${total}`, label);
      assert.equal(
        await totalLabel.evaluate((element) => getComputedStyle(element).color),
        YELLOW,
        label,
      );
      const history = await readHistory(page);
      assert.deepEqual(
        history.map((event) => event.type),
        ["shoe_started", "card_observed", "card_suit_set"],
        label,
      );
      assert.equal(history[1]?.rank, rank, label);
      assert.equal(history[1]?.seat, "1", label);
      assert.equal(history[2]?.suit, "spades", label);
      assert.equal(history[2]?.seat, "1", label);
      await assertNoWithdraw(page);
    }

    for (const item of keys) {
      await fresh();
      await pressKey(page, item.key);
      await assertLanded(item.rank, item.key);
    }

    for (const rank of RANKS) {
      await fresh();
      await clickRank(page, rank);
      await assertLanded(rank, `pad ${rank}`);
    }

    for (const key of ["a", "A", "t", "T", "Å", "O", "P"]) {
      await fresh();
      await pressKey(page, key);
      assert.equal(await page.locator("#hand-1 .mini").count(), 0, key);
      assert.equal(await page.locator('[data-seat="1"] .hand-total').count(), 0, key);
      assert.deepEqual(
        (await readHistory(page)).map((event) => event.type),
        ["shoe_started"],
        key,
      );
      await assertNoWithdraw(page);
    }
  } finally {
    await close(server, browser);
  }
});

test("suit keys correct the last 5 and leave focus on seat 2", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;
    await newShoe(page);
    await clickSeat(page, "1");
    await page.keyboard.press("5");
    await page.locator('#hand-1 .mini[data-rank="5"][data-suit="spades"]').waitFor();
    await assertRing(page, "2");
    assert.equal(await ringOn(page, "1"), false);

    const steps = [
      { key: "x", suit: "hearts", symbol: "♥" },
      { key: "d", suit: "diamonds", symbol: "♦" },
      { key: "c", suit: "clubs", symbol: "♣" },
      { key: "s", suit: "spades", symbol: "♠" },
    ] as const;
    for (const step of steps) {
      await page.keyboard.press(step.key);
      const card = page.locator(`#hand-1 .mini[data-rank="5"][data-suit="${step.suit}"]`);
      await card.waitFor();
      assert.equal(await page.locator("#hand-1 .mini").count(), 1, step.key);
      assert.equal(await page.locator("#hand-2 .mini").count(), 0, step.key);
      assert.equal(
        (await page.locator("#hand-1 .suit.top-right").innerText()).trim(),
        step.symbol,
        step.key,
      );
      assert.equal(
        (await page.locator("#hand-1 .suit.bottom-left").innerText()).trim(),
        step.symbol,
        step.key,
      );
      await assertRing(page, "2");
      assert.equal(await ringOn(page, "1"), false, step.key);
      const last = (await readHistory(page)).at(-1);
      assert.equal(last?.type, "card_suit_set", step.key);
      assert.equal(last?.suit, step.suit, step.key);
      assert.equal(last?.seat, "1", step.key);
    }
  } finally {
    await close(server, browser);
  }
});

test("stale base total does not return after refill and split", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;
    await newShoe(page);

    await clickSeat(page, "1");
    await clickRank(page, "8");
    await page.locator('#hand-1 .mini[data-rank="8"][data-suit="spades"]').waitFor();
    await clickSeat(page, "1");
    await backspace(page);
    await page.locator("#hand-1 .mini").waitFor({ state: "detached" });
    assert.equal(await page.locator("#hand-1 .mini").count(), 0);
    assert.equal((await page.locator('[data-seat="1"] .hand-total').innerText()).trim(), "Total: 8");
    assert.equal(await totalColour(page, "1"), YELLOW);

    await clickSeat(page, "1");
    await clickRank(page, "8");
    await page.locator('#hand-1 .mini[data-rank="8"][data-suit="spades"]').waitFor();
    await clickSeat(page, "1");
    await clickRank(page, "8");
    await page.locator('#hand-1 .mini[data-suit="spades"]').nth(1).waitFor();
    await clickSuit(page, "hearts");
    await page.locator('#hand-1 .mini[data-suit="hearts"]').waitFor();
    const split = page.locator("#splitBtn-1");
    assert.equal(await split.isVisible(), true);
    await split.click();
    await page.locator("#hand-1A .mini").waitFor();
    await page.locator("#hand-1B .mini").waitFor();

    const felt = projectFeltTable(recordedFacts(await readHistory(page)));
    assert.deepEqual(felt.hand_totals, [
      { seat: "1", hand: "A", total: 8, colour: "#ffd43f", label: "Total: 8" },
      { seat: "1", hand: "B", total: 8, colour: "#ffd43f", label: "Total: 8" },
    ]);
    assert.equal(await page.locator('[data-seat="1"] > .hand-total').count(), 0);
    assert.deepEqual(await pileTotal(page, "A"), { text: "Total: 8", colour: YELLOW });
    assert.deepEqual(await pileTotal(page, "B"), { text: "Total: 8", colour: YELLOW });
    assert.equal(await page.locator('#hand-1A .mini[data-rank="8"][data-suit="spades"]').count(), 1);
    assert.equal(await page.locator('#hand-1B .mini[data-rank="8"][data-suit="hearts"]').count(), 1);
  } finally {
    await close(server, browser);
  }
});

test("due_pile_header_click_emptied_a_is_live", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;
    await newShoe(page);
    await splitEights(page);

    await clickSeat(page, "1");
    await assertSplitFocus(page, "A");
    await backspace(page);
    await page.locator('#hand-1A .mini[data-rank="8"]').waitFor({ state: "detached" });
    assert.equal(await page.locator("#hand-1A .mini").count(), 0);
    assert.equal(await page.locator('#hand-1A .mini[data-suit="spades"]').count(), 0);
    assert.deepEqual(await pileTotal(page, "A"), { text: "Total: 8", colour: YELLOW });
    assert.equal(await page.locator('#hand-1B .mini[data-rank="8"][data-suit="hearts"]').count(), 1);
    assert.deepEqual(await pileTotal(page, "B"), { text: "Total: 8", colour: YELLOW });
    await assertSplitFocus(page, "A");
    const withdrawn = (await readHistory(page)).at(-1);
    assert.equal(withdrawn?.type, "card_withdrawn");
    assert.equal(withdrawn?.rank, "8");
    assert.equal(withdrawn?.seat, "1A");

    await clickSeat(page, "2");
    await assertRing(page, "2");
    assert.equal(await page.locator("#split-1 .split-hand.active").count(), 0);
    await clickSeat(page, "1");
    await assertSplitFocus(page, "A");
    await clickSeat(page, "1");
    await assertSplitFocus(page, "A");

    const frozen = await readHistory(page);
    await backspace(page);
    assert.deepEqual(await readHistory(page), frozen);
    assert.equal(await page.locator("#hand-1A .mini").count(), 0);
    assert.deepEqual(await pileTotal(page, "A"), { text: "Total: 8", colour: YELLOW });
    assert.equal(await page.locator('#hand-1B .mini[data-rank="8"][data-suit="hearts"]').count(), 1);
  } finally {
    await close(server, browser);
  }
});

test("due_pile_header_click_both_done_lands_on_a", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;
    await newShoe(page);
    await splitEights(page);

    await page.keyboard.press("3");
    await page.locator('#hand-1A .mini[data-rank="3"][data-suit="spades"]').waitFor();
    // Slice 15: A's second card focuses B, not seat 2.
    await assertSplitFocus(page, "B");
    await clickSeat(page, "1");
    await assertSplitFocus(page, "A");
    await page.keyboard.press("[");
    await page.locator('#hand-1A .mini[data-rank="K"][data-suit="spades"]').waitFor();
    assert.deepEqual(
      await page.locator("#hand-1A .mini").evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("data-rank")),
      ),
      ["8", "3", "K"],
    );
    assert.deepEqual(await pileTotal(page, "A"), { text: "Total: 21", colour: CYAN });
    // 21 advances onto open B.
    await assertSplitFocus(page, "B");

    await clickSeat(page, "1");
    await assertSplitFocus(page, "B");
    await page.keyboard.press("3");
    await page.locator('#hand-1B .mini[data-rank="3"][data-suit="spades"]').waitFor();
    // B's second card leaves for the next seat. Click back before the king.
    await clickSeat(page, "1");
    await assertSplitFocus(page, "B");
    await page.keyboard.press("[");
    await page.locator('#hand-1B .mini[data-rank="K"][data-suit="spades"]').waitFor();
    assert.deepEqual(
      await page.locator("#hand-1B .mini").evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("data-rank")),
      ),
      ["8", "3", "K"],
    );
    assert.equal(await page.locator('#hand-1B .mini[data-suit="hearts"]').count(), 1);
    assert.deepEqual(await pileTotal(page, "A"), { text: "Total: 21", colour: CYAN });
    assert.deepEqual(await pileTotal(page, "B"), { text: "Total: 21", colour: CYAN });

    await clickSeat(page, "2");
    await assertRing(page, "2");
    await clickSeat(page, "1");
    // Q6 / keyboard_split_header_click_both_done_lands_on_a: both piles done → A.
    await assertSplitFocus(page, "A");
    await clickSeat(page, "1");
    await assertSplitFocus(page, "A");
  } finally {
    await close(server, browser);
  }
});
