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
 * Live Pages entry for slice 12 v2 (split rules v2) and the reopened slice 13
 * post-split Backspace journey. Serves `dist/` under `/blackjack-coach/`.
 * boot.js mounts the page; hooks are only `pickSuitRandom` (0 → spades) and
 * the read-only `readTable`. Real clicks and real keys. Rank entry uses both
 * the top-row keys and the NumLock-on numpad. No hero step: split needs none.
 * Gates: live_page_not_proven_12b, live_page_not_proven_13 (03).
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

async function assertSplitFocus(page: Page, hand: "A" | "B", seat = "1"): Promise<void> {
  await assertRing(page, seat);
  const pileA = page.locator(`#split-${seat} .split-hand`).nth(0);
  const pileB = page.locator(`#split-${seat} .split-hand`).nth(1);
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


async function pileTotal(page: Page, hand: "A" | "B"): Promise<{ text: string; colour: string }> {
  const label = page.locator(`#hand-1${hand} .hand-total`);
  return {
    text: (await label.innerText()).trim(),
    colour: await label.evaluate((element) => getComputedStyle(element).color),
  };
}

/** Seat header, then a rank by real key (top-row or numpad). Auto-suit is spades. */
async function keyRank(page: Page, seat: string, key: string, rank: string): Promise<void> {
  await clickSeat(page, seat);
  const before = await page.locator(`#hand-${seat} .mini`).count();
  await pressKey(page, key);
  await page.locator(`#hand-${seat} .mini`).nth(before).waitFor();
  assert.equal(
    await page.locator(`#hand-${seat} .mini`).nth(before).getAttribute("data-rank"),
    rank,
  );
}

async function splitButtons(page: Page): Promise<string[]> {
  return page.locator(".split-btn").evaluateAll((nodes) => nodes.map((node) => node.id));
}

for (const entry of [
  { name: "top-row", king: "[" },
  { name: "numpad", king: "NumpadSubtract" },
] as const) {
  test(`felt_withdraw post-split Backspace (${entry.name} K): SPLIT then Backspace withdraws 1A's K♥`, async () => {
    buildDist();
    const { server, origin } = await startServer();
    let browser: Browser | undefined;
    try {
      const opened = await openLive(origin);
      browser = opened.browser;
      const page = opened.page;
      await newShoe(page);

      await keyRank(page, "1", entry.king, "K");
      await pressKey(page, "x");
      await page.locator('#hand-1 .mini[data-suit="hearts"]').waitFor();
      await keyRank(page, "1", entry.king, "K");
      await pressKey(page, "s");
      assert.equal((await page.locator('[data-seat="1"] .hand-total').innerText()).trim(), "Total: 20");

      const split = page.locator("#splitBtn-1");
      assert.equal(await split.isVisible(), true);
      assert.equal(await split.isEnabled(), true);
      await split.click();
      await page.locator('#hand-1A .mini[data-rank="K"][data-suit="hearts"]').waitFor();
      await page.locator('#hand-1B .mini[data-rank="K"][data-suit="spades"]').waitFor();
      assert.equal((await pileTotal(page, "A")).text, "Total: 10");
      assert.equal((await pileTotal(page, "B")).colour, YELLOW);
      await assertSplitFocus(page, "A");
      const splitHistory = await readHistory(page);
      assert.equal(splitHistory.at(-1)?.type, "hand_split");

      // No click: Backspace goes to the manual focus on 1A (focus_sources_for_withdraw, 4).
      await backspace(page);
      await page.locator("#hand-1A .mini").waitFor({ state: "detached" });
      const after = await readHistory(page);
      assert.deepEqual(
        recordedFacts(after.slice(splitHistory.length)),
        [{ type: "card_withdrawn", rank: "K", seat: "1A" }],
      );
      assert.equal(await page.locator("#hand-1A .mini").count(), 0);
      assert.equal(await page.locator('#hand-1B .mini[data-rank="K"][data-suit="spades"]').count(), 1);
      assert.deepEqual(await pileTotal(page, "A"), { text: "Total: 10", colour: YELLOW });
      assert.deepEqual(await pileTotal(page, "B"), { text: "Total: 10", colour: YELLOW });
      await assertSplitFocus(page, "A");
      await assertNoWithdraw(page);
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
      const ranks = await rankCounts(page);
      for (const rank of RANKS) assert.equal(ranks[rank], rank === "K" ? "31" : "32", rank);
      assert.equal(await hoverSuit(page, "spades"), "♠: 103");
      assert.equal(await hoverSuit(page, "clubs"), "♣: 104");
      assert.equal(await hoverSuit(page, "hearts"), "♥: 104");
      assert.equal(await hoverSuit(page, "diamonds"), "♦: 104");

      // Manual focus on the emptied 1A: a second Backspace does nothing.
      await backspace(page);
      assert.deepEqual(await readHistory(page), after);
      assert.equal(await page.locator('#hand-1B .mini[data-rank="K"]').count(), 1);
    } finally {
      await close(server, browser);
    }
  });
}

test("felt_split v2: seat 4 splits 10+K, the dealer never shows SPLIT, J+Q shows on seat 2", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;
    await newShoe(page);

    // 10 from the top-row '0', K from the numpad '-'.
    await keyRank(page, "4", "0", "10");
    await pressKey(page, "x");
    await keyRank(page, "4", "NumpadSubtract", "K");
    // Dealer 8, 8 from top-row '8' and numpad 8.
    await keyRank(page, "D", "8", "8");
    await keyRank(page, "D", "Numpad8", "8");
    // Seat 2: J from the numpad '/', Q from the top-row 'p'.
    await keyRank(page, "2", "NumpadDivide", "J");
    await keyRank(page, "2", "p", "Q");

    assert.deepEqual(await splitButtons(page), ["splitBtn-4", "splitBtn-2"]);
    assert.equal(await page.locator("#splitBtn-D").count(), 0);
    assert.equal(await page.locator("#splitBtn-1").count(), 0);

    const split = page.locator("#splitBtn-4");
    assert.equal(await split.isVisible(), true);
    assert.equal(await split.isEnabled(), true);
    assert.equal((await split.innerText()).trim(), "SPLIT");
    await split.click();
    await page.locator('#hand-4A .mini[data-rank="10"][data-suit="hearts"]').waitFor();
    await page.locator('#hand-4B .mini[data-rank="K"][data-suit="spades"]').waitFor();
    const history = await readHistory(page);
    assert.deepEqual(recordedFacts(history.slice(-1)), [{ type: "hand_split", seat: "4" }]);
    assert.equal((await page.locator("#hand-4A .hand-total").innerText()).trim(), "Total: 10");
    assert.equal((await page.locator("#hand-4B .hand-total").innerText()).trim(), "Total: 10");
    await assertSplitFocus(page, "A", "4");
    // No resplit: split piles never carry a SPLIT button; seat 2 still can.
    assert.deepEqual(await splitButtons(page), ["splitBtn-2"]);
    assert.equal(await page.locator("#split-4 .split-btn").count(), 0);
  } finally {
    await close(server, browser);
  }
});

test("felt_split v2: SPLIT hidden for K+9, for three same-value cards, and after a split", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;
    await newShoe(page);

    // K+9 on seat 3: different point values.
    await keyRank(page, "3", "[", "K");
    await keyRank(page, "3", "Numpad9", "9");
    assert.equal(await page.locator("#splitBtn-3").count(), 0);

    // Three kings on seat 5: SPLIT shows at two, then goes at three.
    await keyRank(page, "5", "NumpadSubtract", "K");
    await keyRank(page, "5", "[", "K");
    assert.equal(await page.locator("#splitBtn-5").isVisible(), true);
    await keyRank(page, "5", "å", "K");
    assert.equal(await page.locator("#splitBtn-5").count(), 0);

    // Seat 6 K+K split, then another K on 6A: still no SPLIT anywhere.
    await keyRank(page, "6", "[", "K");
    await keyRank(page, "6", "NumpadSubtract", "K");
    await page.locator("#splitBtn-6").click();
    await page.locator("#hand-6B .mini").waitFor();
    await assertSplitFocus(page, "A", "6");
    await pressKey(page, "[");
    await page.locator("#hand-6A .mini").nth(1).waitFor();
    assert.deepEqual(await splitButtons(page), []);
    const history = await readHistory(page);
    assert.equal(history.filter((event) => event.type === "hand_split").length, 1);
  } finally {
    await close(server, browser);
  }
});
