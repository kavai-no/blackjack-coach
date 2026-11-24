import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

/**
 * Live Pages entry for slice 15. Serves `dist/` under `/blackjack-coach/`
 * with the shipped boot.js. Helpers are copied for this file only.
 * `pickSuitRandom` is 0, so a rank's auto-suit is spades.
 * Hooks are pickSuitRandom and readTable. No injected DOM.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const BASE = "/blackjack-coach";
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
const YELLOW = "rgb(255, 212, 63)";
const CYAN = "rgb(0, 255, 245)";
const RED = "rgb(239, 68, 68)";
const FIFTEEN_FIVES = {
  p: "P: 3.61%",
  d: "D: 7.71",
  ra: "RA: -0.87",
  hilo: "Hi-Lo: 15 / 1.95",
  apc: "APC: 5.84",
  zen: "Zen: 3.89",
  omega: "Omega II: 3.89",
  ace: "Ace: 0.15",
};

const TOP: Record<string, string> = {
  A: "1",
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
  "10": "0",
  J: "o",
  Q: "p",
  K: "[",
};
const PAD: Record<string, string> = {
  A: "Numpad1",
  "2": "Numpad2",
  "3": "Numpad3",
  "4": "Numpad4",
  "5": "Numpad5",
  "6": "Numpad6",
  "7": "Numpad7",
  "8": "Numpad8",
  "9": "Numpad9",
  "10": "Numpad0",
  J: "NumpadDivide",
  Q: "NumpadMultiply",
  K: "NumpadSubtract",
};

type LiveEvent = { type: string; position: number; rank?: string; seat?: string; suit?: string };

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
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

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

async function dispatchKey(page: Page, key: string, code: string, keyCode: number): Promise<void> {
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
    await dispatchKey(page, key, "BracketRight", 221);
  }
}

async function readHistory(page: Page): Promise<LiveEvent[]> {
  return page.evaluate(() => {
    const read = Reflect.get(globalThis, "readTable");
    if (typeof read !== "function") throw new Error("readTable missing");
    return read();
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
  for (const value of [bar.p, bar.d, bar.ra, bar.hilo, bar.apc, bar.zen, bar.omega, bar.ace]) {
    assert.match(value, /\d\.\d{2}/);
  }
  return bar;
}

async function clickSeat(page: Page, seat: string): Promise<void> {
  const header = page.locator(`[data-seat="${seat}"] .seat-round`);
  assert.equal(await header.isVisible(), true);
  await header.click();
}

async function rightClick(page: Page, seat: string): Promise<void> {
  const header = page.locator(`[data-seat="${seat}"] .seat-round`);
  assert.equal(await header.isVisible(), true);
  await header.click({ button: "right" });
}

async function assertRing(page: Page, seat: string): Promise<void> {
  const header = page.locator(`[data-seat="${seat}"] .seat-round`);
  assert.equal(await header.evaluate((element) => element.classList.contains("active")), true, seat);
  assert.equal(await page.locator(".seat-round.active").count(), 1);
}

async function assertPile(page: Page, seat: string, hand: "A" | "B"): Promise<void> {
  await assertRing(page, seat);
  const pileA = page.locator(`#split-${seat} .split-hand`).nth(0);
  const pileB = page.locator(`#split-${seat} .split-hand`).nth(1);
  const active = hand === "A" ? pileA : pileB;
  const idle = hand === "A" ? pileB : pileA;
  assert.equal(await active.evaluate((element) => element.classList.contains("active")), true);
  assert.equal(await idle.evaluate((element) => element.classList.contains("active")), false);
  assert.equal((await page.locator(`#split-${seat} .split-label`).nth(0).innerText()).trim(), "A");
  assert.equal((await page.locator(`#split-${seat} .split-label`).nth(1).innerText()).trim(), "B");
}

async function pileText(page: Page, seat: string, hand: "A" | "B"): Promise<{ text: string; colour: string }> {
  const label = page.locator(`#hand-${seat}${hand} .hand-total`);
  return {
    text: (await label.innerText()).trim(),
    colour: await label.evaluate((element) => getComputedStyle(element).color),
  };
}

async function seatTotal(page: Page, seat: string): Promise<{ text: string; colour: string }> {
  const label = page.locator(`[data-seat="${seat}"] > .hand-total`);
  return {
    text: (await label.innerText()).trim(),
    colour: await label.evaluate((element) => getComputedStyle(element).color),
  };
}

let built = false;
function buildDist(): void {
  if (built) return;
  execFileSync(process.execPath, ["scripts/build-pages.mjs"], { cwd: root, stdio: "inherit" });
  built = true;
}

let origin = "";
let page: Page;
let browser: Browser;
let server: Server;

test.before(async () => {
  buildDist();
  const started = await startServer();
  server = started.server;
  origin = started.origin;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  page = await browser.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "pickSuitRandom", {
      configurable: true,
      enumerable: false,
      writable: false,
      value: 0,
    });
  });
  page.on("dialog", (dialog) => {
    if (dialog.message() !== "Start fresh 8-deck shoe?") throw new Error(dialog.message());
    return dialog.accept();
  });
});

test.after(async () => {
  await browser?.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function shoe(): Promise<void> {
  await page.goto(`${origin}${BASE}/`);
  await page.locator('#app[data-screen="felt_idle_no_events"]').waitFor();
  const script = page.locator('script[src="./boot.js"]');
  assert.equal(await script.count(), 1);
  const button = page.getByRole("button", { name: "NEW SHOE" });
  assert.equal(await button.isVisible(), true);
  assert.equal(await button.isEnabled(), true);
  await button.click();
  await page.locator('#app[data-screen="felt_new_shoe"]').waitFor();
  await assertRing(page, "1");
}

async function splitSeat(seat: string): Promise<void> {
  await clickSeat(page, seat);
  await pressKey(page, "8");
  await page.locator(`#hand-${seat} .mini[data-rank="8"]`).waitFor();
  await clickSeat(page, seat);
  await pressKey(page, "8");
  await page.locator(`#hand-${seat} .mini`).nth(1).waitFor();
  const split = page.locator(`#splitBtn-${seat}`);
  assert.equal(await split.isVisible(), true);
  assert.equal(await split.isEnabled(), true);
  await split.click();
  await page.locator(`#hand-${seat}A .mini`).waitFor();
  await page.locator(`#hand-${seat}B .mini`).waitFor();
  await assertPile(page, seat, "A");
}

test("keyboard_mouse_interchangeable_across_seats", async () => {
  await shoe();
  await clickSeat(page, "4");
  await pressKey(page, TOP["8"] ?? "8");
  await page.locator('#hand-4 .mini[data-rank="8"][data-suit="spades"]').waitFor();
  await assertRing(page, "5");
  await clickSeat(page, "4");
  const pad = page.locator('#cardsGrid button[data-rank="K"]');
  assert.equal(await pad.isVisible(), true);
  assert.equal(await pad.isEnabled(), true);
  await pad.click();
  await page.locator('#hand-4 .mini[data-rank="K"]').waitFor();
  assert.deepEqual(await seatTotal(page, "4"), { text: "Total: 18", colour: "rgb(34, 197, 94)" });
  await clickSeat(page, "6");
  await pressKey(page, PAD["5"] ?? "Numpad5");
  await page.locator('#hand-6 .mini[data-rank="5"][data-suit="spades"]').waitFor();
  await assertRing(page, "7");
  assert.deepEqual(await seatTotal(page, "6"), { text: "Total: 5", colour: YELLOW });
  const history = await readHistory(page);
  assert.deepEqual(
    history.filter((event) => event.type === "card_observed").map((event) => event.seat),
    ["4", "4", "6"],
  );
});

test("rank entry uses the top row and the numpad for every rank", async () => {
  const painted = (rank: string) => (rank === "10" ? "T" : rank);
  const total = (rank: string) =>
    rank === "A" ? "11" : rank === "10" || rank === "J" || rank === "Q" || rank === "K" ? "10" : rank;
  for (const rank of RANKS) {
    for (const key of [TOP[rank], PAD[rank]]) {
      await shoe();
      await clickSeat(page, "1");
      await pressKey(page, key ?? "");
      const card = page.locator("#hand-1 .mini");
      await card.waitFor();
      assert.equal((await page.locator("#hand-1 .corner.top-left").innerText()).trim(), painted(rank), key);
      assert.equal(await card.getAttribute("data-suit"), "spades", key);
      assert.deepEqual(await seatTotal(page, "1"), { text: `Total: ${total(rank)}`, colour: YELLOW }, key);
      await assertRing(page, "2");
    }
  }
  await shoe();
  await clickSeat(page, "1");
  await pressKey(page, "å");
  await page.locator('#hand-1 .mini[data-rank="K"]').waitFor();
  assert.deepEqual(await seatTotal(page, "1"), { text: "Total: 10", colour: YELLOW });
  await assertRing(page, "2");
  const suits = [
    { key: "d", suit: "diamonds", symbol: "♦" },
    { key: "x", suit: "hearts", symbol: "♥" },
    { key: "c", suit: "clubs", symbol: "♣" },
    { key: "s", suit: "spades", symbol: "♠" },
  ] as const;
  for (const step of suits) {
    await page.keyboard.press(step.key);
    const card = page.locator(`#hand-1 .mini[data-rank="K"][data-suit="${step.suit}"]`);
    await card.waitFor();
    assert.equal((await page.locator("#hand-1 .suit.top-right").innerText()).trim(), step.symbol, step.key);
    await assertRing(page, "2");
    const last = (await readHistory(page)).at(-1);
    assert.equal(last?.type, "card_suit_set", step.key);
    assert.equal(last?.suit, step.suit, step.key);
    assert.equal(last?.seat, "1", step.key);
  }
});

test("keyboard_mouse_alternating_in_split", async () => {
  await shoe();
  await clickSeat(page, "1");
  await pressKey(page, "8");
  await clickSeat(page, "1");
  const eight = page.locator('#cardsGrid button[data-rank="8"]');
  assert.equal(await eight.isEnabled(), true);
  await eight.click();
  await page.locator("#splitBtn-1").click();
  await assertPile(page, "1", "A");
  await pressKey(page, "3");
  await page.locator('#hand-1A .mini[data-rank="3"]').waitFor();
  await assertPile(page, "1", "B");
  assert.deepEqual(await pileText(page, "1", "A"), { text: "Total: 11", colour: YELLOW });
  await clickSeat(page, "1");
  await assertPile(page, "1", "A");
  await page.locator('#cardsGrid button[data-rank="2"]').click();
  await page.locator('#hand-1A .mini[data-rank="2"]').waitFor();
  await page.keyboard.press("ArrowLeft");
  await assertPile(page, "1", "B");
  await pressKey(page, "Numpad6");
  await page.locator('#hand-1B .mini[data-rank="6"]').waitFor();
  assert.deepEqual(await pileText(page, "1", "B"), { text: "Total: 14", colour: YELLOW });
  assert.deepEqual(await pileText(page, "1", "A"), { text: "Total: 13", colour: YELLOW });
});

test("keyboard_bust_advance_backspace_returns_focus", async () => {
  await shoe();
  await pressKey(page, "[");
  await clickSeat(page, "1");
  await pressKey(page, "6");
  await clickSeat(page, "1");
  await pressKey(page, "9");
  await page.locator('#hand-1 .mini[data-rank="9"]').waitFor();
  assert.deepEqual(await seatTotal(page, "1"), { text: "Total: 25", colour: RED });
  await assertRing(page, "2");
  await page.keyboard.press("Backspace");
  await page.locator('#hand-1 .mini[data-rank="9"]').waitFor({ state: "detached" });
  await assertRing(page, "1");
  assert.deepEqual(await seatTotal(page, "1"), { text: "Total: 16", colour: YELLOW });
  assert.equal((await readHistory(page)).at(-1)?.seat, "1");

  await clickSeat(page, "3");
  await pressKey(page, "4");
  await assertRing(page, "4");
  await page.keyboard.press("Backspace");
  await page.locator("#hand-3 .mini").waitFor({ state: "detached" });
  await assertRing(page, "4");
});

test("keyboard_split_a_then_b_then_next_seat", async () => {
  await shoe();
  await splitSeat("1");
  await pressKey(page, "3");
  await page.locator('#hand-1A .mini[data-rank="3"]').waitFor();
  await assertPile(page, "1", "B");
  assert.equal(await page.locator("#hand-1B .mini").count(), 1);
  await pressKey(page, "4");
  await page.locator('#hand-1B .mini[data-rank="4"]').waitFor();
  await assertRing(page, "2");
  assert.equal(await page.locator("#split-1 .split-hand.active").count(), 0);
  assert.deepEqual(await pileText(page, "1", "A"), { text: "Total: 11", colour: YELLOW });
  assert.deepEqual(await pileText(page, "1", "B"), { text: "Total: 12", colour: YELLOW });
});

test("keyboard_dealing_round_skips_dealer", async () => {
  await shoe();
  for (let step = 0; step < 8; step += 1) await pressKey(page, "5");
  for (let step = 0; step < 7; step += 1) await pressKey(page, "Numpad5");
  await assertRing(page, "1");
  for (const seat of ["1", "2", "3", "4", "5", "6", "7"]) {
    assert.equal(await page.locator(`#hand-${seat} .mini`).count(), 2, seat);
    assert.deepEqual(await seatTotal(page, seat), { text: "Total: 10", colour: YELLOW });
  }
  assert.equal(await page.locator("#hand-D .mini").count(), 1);
  assert.deepEqual(await seatTotal(page, "D"), { text: "Total: 5", colour: YELLOW });
  assert.deepEqual(await infoBar(page), FIFTEEN_FIVES);
  for (const rank of RANKS) {
    const label = (await page.locator(`#combinedChart .rank-label[data-chart-rank="${rank}"]`).textContent())?.trim();
    assert.equal(label, rank === "5" ? "17" : "32", rank);
  }
  await page.locator('#combinedChart .suit-slice[data-suit="spades"]').hover();
  // Eight 5♠ plus the zero-count draw still returns spades, so nine spades leave.
  assert.equal((await page.locator("#combinedChart .d3-tooltip").innerText()).trim(), "♠: 95");
  await page.locator('#combinedChart .suit-slice[data-suit="hearts"]').hover();
  assert.equal((await page.locator("#combinedChart .d3-tooltip").innerText()).trim(), "♥: 98");
});

test("keyboard_twenty_one_auto_advances", async () => {
  await shoe();
  await pressKey(page, "0");
  await clickSeat(page, "1");
  await pressKey(page, "6");
  await clickSeat(page, "1");
  await pressKey(page, "5");
  await page.locator('#hand-1 .mini').nth(2).waitFor();
  assert.deepEqual(await seatTotal(page, "1"), { text: "Total: 21", colour: CYAN });
  await assertRing(page, "2");
  await page.keyboard.press("Backspace");
  await assertRing(page, "1");
  assert.deepEqual(await seatTotal(page, "1"), { text: "Total: 16", colour: YELLOW });
});

test("keyboard_arrows_manual_focus", async () => {
  await shoe();
  const left = ["1"];
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press("ArrowLeft");
    const active = await page.locator(".seat-round.active").innerText();
    left.push(active.trim());
  }
  assert.deepEqual(left, ["1", "2", "3", "4", "5", "6", "7", "D", "1"]);
  const right = ["1"];
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press("ArrowRight");
    right.push((await page.locator(".seat-round.active").innerText()).trim());
  }
  assert.deepEqual(right, ["1", "D", "7", "6", "5", "4", "3", "2", "1"]);
});

test("keyboard_split_arrows_follow_screen_position", async () => {
  await shoe();
  await splitSeat("1");
  const box = async (hand: "A" | "B") => {
    const found = await page.locator(`#hand-1${hand}`).locator("xpath=ancestor::div[contains(@class,'split-hand')]").boundingBox();
    if (!found) throw new Error(`no box ${hand}`);
    return found;
  };
  const a = await box("A");
  const b = await box("B");
  assert.ok(a.x > b.x, `A ${a.x} should sit right of B ${b.x}`);
  await page.keyboard.press("ArrowLeft");
  await assertPile(page, "1", "B");
  await page.keyboard.press("ArrowRight");
  await assertPile(page, "1", "A");
  await page.keyboard.press("ArrowRight");
  await assertRing(page, "D");
});

test("keyboard_arrow_sets_manual_focus_for_backspace", async () => {
  await shoe();
  await pressKey(page, "5");
  await assertRing(page, "2");
  await pressKey(page, "[");
  await page.locator('#hand-2 .mini[data-rank="K"]').waitFor();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await assertRing(page, "1");
  const before = (await readHistory(page)).length;
  await page.keyboard.press("Backspace");
  await page.locator("#hand-1 .mini").waitFor({ state: "detached" });
  assert.equal(await page.locator("#hand-2 .mini").count(), 1);
  await assertRing(page, "1");
  const last = (await readHistory(page)).at(-1);
  assert.equal(last?.type, "card_withdrawn");
  assert.equal(last?.seat, "1");
  assert.equal(last?.rank, "5");
  assert.equal((await readHistory(page)).length, before + 1);
});

test("keyboard_split_header_click_follows_due_pile", async () => {
  await shoe();
  await splitSeat("1");
  await clickSeat(page, "1");
  await assertPile(page, "1", "A");
  await clickSeat(page, "1");
  await assertPile(page, "1", "A");
  await pressKey(page, "3");
  await clickSeat(page, "1");
  await pressKey(page, "[");
  await page.locator('#hand-1A .mini[data-rank="K"]').waitFor();
  assert.deepEqual(await pileText(page, "1", "A"), { text: "Total: 21", colour: CYAN });
  await clickSeat(page, "1");
  await assertPile(page, "1", "B");
  await clickSeat(page, "1");
  await assertPile(page, "1", "B");
});

test("keyboard_seat_toggle_space_and_right_click", async () => {
  await shoe();
  const before = await readHistory(page);
  await page.keyboard.press("Space");
  await assertRing(page, "2");
  const off = page.locator('[data-seat="1"] .seat-round');
  assert.equal(await off.evaluate((element) => element.classList.contains("disabled")), true);
  assert.equal(await off.evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(102, 102, 102)");
  await clickSeat(page, "D");
  await page.keyboard.press("Space");
  await rightClick(page, "D");
  await assertRing(page, "D");
  assert.equal(await page.locator('[data-seat="D"] .seat-round.disabled').count(), 0);
  await rightClick(page, "D");
  await clickSeat(page, "2");
  await rightClick(page, "2");
  await assertRing(page, "2");
  assert.equal(
    await page.locator('[data-seat="2"] .seat-round').evaluate((element) => element.classList.contains("disabled")),
    true,
  );
  await page.keyboard.press("Space");
  await assertRing(page, "2");
  assert.equal(await page.locator(".seat-round.disabled").count(), 1);
  assert.deepEqual(await readHistory(page), before);
});

test("keyboard_click_disabled_seat_goes_to_next_active", async () => {
  await shoe();
  await rightClick(page, "4");
  await rightClick(page, "5");
  await clickSeat(page, "4");
  await assertRing(page, "6");
  await page.keyboard.press("ArrowRight");
  await assertRing(page, "3");
  const before = await readHistory(page);
  await rightClick(page, "4");
  assert.deepEqual(await readHistory(page), before);
});

test("keyboard_disabled_seats_clear_on_next_hand_and_new_shoe", async () => {
  await shoe();
  await page.keyboard.press("Space");
  await rightClick(page, "6");
  assert.equal(await page.locator(".seat-round.disabled").count(), 2);
  const next = page.getByRole("button", { name: "NEXT HAND" });
  assert.equal(await next.isVisible(), true);
  assert.equal(await next.isEnabled(), true);
  await next.click();
  await page.locator('#app[data-screen="felt_new_shoe"]').waitFor();
  assert.equal(await page.locator(".seat-round.disabled").count(), 0);
  assert.equal(await page.locator(".mini").count(), 0);
  await assertRing(page, "1");
  await rightClick(page, "3");
  assert.equal(await page.locator(".seat-round.disabled").count(), 1);
  await page.getByRole("button", { name: "NEW SHOE" }).click();
  assert.equal(await page.locator(".seat-round.disabled").count(), 0);
  assert.equal(
    (await readHistory(page)).every((event) => event.type === "hand_completed" || event.type === "shoe_started"),
    true,
  );
});

test("keyboard_disabled_seat_not_kept_on_reload", async () => {
  await shoe();
  await pressKey(page, "[");
  await page.keyboard.press("Space");
  assert.equal(await page.locator(".seat-round.disabled").count(), 1);
  assert.equal((await readHistory(page)).some((event) => /disable|toggle/i.test(event.type)), false);
  await page.reload();
  await page.locator('#app[data-screen="felt_idle_no_events"]').waitFor();
  assert.equal(await page.locator(".seat-round.disabled").count(), 0);
  assert.equal(await page.locator(".mini").count(), 0);
  assert.deepEqual(await readHistory(page), []);
});

test("keyboard_dealing_round_skips_disabled_and_last_active", async () => {
  await shoe();
  await rightClick(page, "7");
  await rightClick(page, "3");
  const seen: string[] = ["1"];
  for (let step = 0; step < 11; step += 1) {
    await pressKey(page, step < 6 ? "5" : "Numpad5");
    seen.push((await page.locator(".seat-round.active").innerText()).trim());
  }
  assert.deepEqual(seen, ["1", "2", "4", "5", "6", "D", "1", "2", "4", "5", "6", "1"]);
  for (const seat of ["3", "7"]) {
    assert.equal(await page.locator(`#hand-${seat} .mini`).count(), 0, seat);
    assert.equal(
      await page.locator(`[data-seat="${seat}"] .seat-round`).evaluate((element) => element.classList.contains("disabled")),
      true,
      seat,
    );
  }
  for (const seat of ["1", "2", "4", "5", "6"]) {
    assert.equal(await page.locator(`#hand-${seat} .mini`).count(), 2, seat);
  }
  assert.equal(await page.locator("#hand-D .mini").count(), 1);
  const bar = await infoBar(page);
  assert.match(bar.hilo, /^Hi-Lo: 11 \/ \d\.\d{2}$/);
});

test("keyboard_split_header_click_both_done_lands_on_a", async () => {
  await shoe();
  await splitSeat("1");
  await pressKey(page, "3");
  await clickSeat(page, "1");
  await pressKey(page, "[");
  await page.locator('#hand-1A .mini[data-rank="K"]').waitFor();
  await clickSeat(page, "1");
  await pressKey(page, "3");
  await page.locator('#hand-1B .mini[data-rank="3"]').waitFor();
  await clickSeat(page, "1");
  await pressKey(page, "[");
  await page.locator('#hand-1B .mini[data-rank="K"]').waitFor();
  assert.deepEqual(await pileText(page, "1", "A"), { text: "Total: 21", colour: CYAN });
  assert.deepEqual(await pileText(page, "1", "B"), { text: "Total: 21", colour: CYAN });
  await clickSeat(page, "2");
  await clickSeat(page, "1");
  await assertPile(page, "1", "A");
  await clickSeat(page, "1");
  await assertPile(page, "1", "A");
});

test("keyboard_split_layout_flip_observable", async () => {
  await shoe();
  await splitSeat("1");
  const hands = page.locator("#split-1 .split-hand");
  const a = await hands.nth(0).boundingBox();
  const b = await hands.nth(1).boundingBox();
  if (!a || !b) throw new Error("split boxes missing");
  assert.ok(a.x > b.x, `A ${a.x} should sit right of B ${b.x}`);
  const overlap = b.x + b.width - a.x;
  assert.ok(Math.abs(overlap - 9) <= 1, `overlap ${overlap}`);
  assert.notEqual(Math.round(overlap), 11);
  const margin = await hands.nth(1).evaluate((element) => getComputedStyle(element).marginRight);
  assert.equal(margin, "-11px");
  const top = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll("#split-1 .split-hand")].map((hand) => hand.getBoundingClientRect());
    const right = boxes[0];
    const left = boxes[1];
    if (!right || !left) return "";
    const x = right.left + 2;
    const y = right.top + right.height / 2;
    const hit = document.elementFromPoint(x, y);
    return hit?.closest(".split-hand")?.querySelector(".split-label")?.textContent?.trim() ?? "";
  });
  assert.equal(top, "B");
});

test("keyboard_split_arrowleft_from_a_to_b_or_next_seat", async () => {
  await shoe();
  await splitSeat("1");
  await page.keyboard.press("ArrowLeft");
  await assertPile(page, "1", "B");
  await page.keyboard.press("Backspace");
  await page.locator("#hand-1B .mini").waitFor({ state: "detached" });
  await clickSeat(page, "1");
  await assertPile(page, "1", "A");
  await page.keyboard.press("ArrowLeft");
  await assertRing(page, "2");
  assert.equal(await page.locator("#split-1 .split-hand.active").count(), 0);
});

test("keyboard_arrow_enters_split_seat_nearest_pile", async () => {
  await shoe();
  await splitSeat("2");
  await clickSeat(page, "1");
  await page.keyboard.press("ArrowLeft");
  await assertPile(page, "2", "A");
  await clickSeat(page, "3");
  await page.keyboard.press("ArrowRight");
  await assertPile(page, "2", "B");
});

test("keyboard_click_disabled_seat_7_goes_to_dealer", async () => {
  await shoe();
  await rightClick(page, "7");
  await clickSeat(page, "7");
  await assertRing(page, "D");
  assert.equal(
    await page.locator('[data-seat="7"] .seat-round').evaluate((element) => element.classList.contains("active")),
    false,
  );
});

test("keyboard_arrow_enters_split_seat_nearest_pile_empty", async () => {
  await shoe();
  await splitSeat("2");
  await page.keyboard.press("Backspace");
  await page.locator("#hand-2A .mini").waitFor({ state: "detached" });
  await clickSeat(page, "3");
  await page.keyboard.press("ArrowRight");
  await assertPile(page, "2", "B");
  await clickSeat(page, "1");
  await page.keyboard.press("ArrowLeft");
  await assertPile(page, "2", "B");
});

test("keyboard_arrow_enters_split_seat_done_piles", async () => {
  await shoe();
  await splitSeat("2");
  await pressKey(page, "3");
  await clickSeat(page, "2");
  await pressKey(page, "[");
  await clickSeat(page, "2");
  await pressKey(page, "3");
  await clickSeat(page, "2");
  await pressKey(page, "[");
  await page.locator('#hand-2B .mini[data-rank="K"]').waitFor();
  assert.deepEqual(await pileText(page, "2", "A"), { text: "Total: 21", colour: CYAN });
  assert.deepEqual(await pileText(page, "2", "B"), { text: "Total: 21", colour: CYAN });
  await clickSeat(page, "1");
  await page.keyboard.press("ArrowLeft");
  await assertPile(page, "2", "A");
  await clickSeat(page, "3");
  await page.keyboard.press("ArrowRight");
  await assertPile(page, "2", "B");
});

test("keyboard_arrow_enters_split_seat_nearest_empty_other_21", async () => {
  await shoe();
  await splitSeat("2");
  await page.keyboard.press("Backspace");
  await page.locator("#hand-2A .mini").waitFor({ state: "detached" });
  await clickSeat(page, "3");
  await page.keyboard.press("ArrowRight");
  await pressKey(page, "[");
  await clickSeat(page, "3");
  await page.keyboard.press("ArrowRight");
  await pressKey(page, "3");
  await page.locator('#hand-2B .mini[data-rank="3"]').waitFor();
  assert.deepEqual(await pileText(page, "2", "B"), { text: "Total: 21", colour: CYAN });
  await clickSeat(page, "1");
  await page.keyboard.press("ArrowLeft");
  await assertPile(page, "2", "A");
  await clickSeat(page, "3");
  await page.keyboard.press("ArrowRight");
  await assertPile(page, "2", "B");
});

test("keyboard_auto_advance_onto_split_seat_due_pile", async () => {
  await shoe();
  await splitSeat("2");
  await clickSeat(page, "1");
  await pressKey(page, "5");
  await assertPile(page, "2", "A");
  await pressKey(page, "3");
  await assertPile(page, "2", "B");
  await clickSeat(page, "2");
  await pressKey(page, "[");
  await page.locator('#hand-2A .mini[data-rank="K"]').waitFor();
  await clickSeat(page, "1");
  await pressKey(page, "4");
  await assertPile(page, "2", "B");
  await pressKey(page, "3");
  await clickSeat(page, "2");
  await pressKey(page, "[");
  await page.locator('#hand-2B .mini[data-rank="K"]').waitFor();
  await clickSeat(page, "1");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await pressKey(page, "2");
  await assertRing(page, "3");
  assert.equal(await page.locator("#split-2 .split-hand.active").count(), 0);
  assert.equal(await page.locator("#hand-1 .mini[data-rank=\"2\"]").count(), 1);
});
