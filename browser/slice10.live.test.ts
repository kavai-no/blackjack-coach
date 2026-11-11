import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

/**
 * live_page_not_proven_10 — mid-shoe NEW SHOE, no split.
 * Serves dist/ (the Pages artifact) under /blackjack-coach/.
 * boot.js mounts the page. pickSuitRandom = 0 is set before boot.
 * Helpers below are copies for this file only.
 *
 * Journey: NEW SHOE → click K → K♠ on seat 1 → click seat 2 → NEW SHOE.
 * Accept appends hand_completed then shoe_started and clears the felt.
 * Dismiss leaves the dealt king, the seat-2 ring, and the three events.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const BASE = "/blackjack-coach";
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
const SUITS = [
  { suit: "spades", symbol: "♠" },
  { suit: "clubs", symbol: "♣" },
  { suit: "hearts", symbol: "♥" },
  { suit: "diamonds", symbol: "♦" },
] as const;
const SEATS = ["D", "7", "6", "5", "4", "3", "2", "1"] as const;

type LiveEvent = {
  type: string;
  position: number;
  decks?: number;
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

let built = false;
function buildDist(): void {
  if (built) return;
  execFileSync(process.execPath, ["scripts/build-pages.mjs"], {
    cwd: root,
    stdio: "inherit",
  });
  built = true;
}

/** Real confirm dialog. `choices` are consumed in order, first NEW SHOE first. */
function watchConfirms(page: Page, choices: Array<"accept" | "dismiss">): string[] {
  const seen: string[] = [];
  page.on("dialog", (dialog) => {
    const choice = choices[seen.length];
    seen.push(dialog.message());
    if (dialog.message() !== "Start fresh 8-deck shoe?") {
      throw new Error(dialog.message());
    }
    if (choice === undefined) {
      throw new Error("unexpected confirm");
    }
    return choice === "accept" ? dialog.accept() : dialog.dismiss();
  });
  return seen;
}

async function openLive(
  origin: string,
  choices: Array<"accept" | "dismiss">,
): Promise<{ browser: Browser; page: Page; confirms: string[] }> {
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
  const confirms = watchConfirms(page, choices);
  await page.goto(`${origin}${BASE}/`);
  await page.locator('#app[data-screen="felt_idle_no_events"]').waitFor();
  return { browser, page, confirms };
}

async function hoverTip(page: Page, selector: string): Promise<string> {
  await page.locator(selector).hover();
  return (await page.locator("#combinedChart .d3-tooltip").innerText()).trim();
}

function rankLabel(page: Page, rank: string) {
  return page.locator(`#combinedChart .rank-label[data-chart-rank="${rank}"]`);
}

async function ringOn(page: Page, seat: string): Promise<boolean> {
  return page.locator(`[data-seat="${seat}"] .seat-round`).evaluate((element) => {
    return element.classList.contains("active");
  });
}

/** Dealt K♠ on seat 1, focus moved to seat 2. Assert before the second NEW SHOE. */
async function assertDealtKing(page: Page): Promise<void> {
  const card = page.locator("#hand-1 .mini");
  assert.equal(await card.count(), 1);
  assert.equal((await card.innerText()).trim(), "K♠");
  assert.equal(await card.getAttribute("data-rank"), "K");
  assert.equal(await card.getAttribute("data-suit"), "spades");
  const total = page.locator('[data-seat="1"] .hand-total');
  assert.equal(await total.count(), 1);
  assert.equal((await total.innerText()).trim(), "Total: 10");
  assert.equal(
    await total.evaluate((element) => getComputedStyle(element).color),
    "rgb(255, 212, 63)",
  );
  for (const seat of SEATS) {
    if (seat === "1") continue;
    assert.equal((await page.locator(`#hand-${seat}`).innerText()).trim(), "", seat);
  }
  assert.equal(await page.getByRole("button", { name: "SPLIT" }).count(), 0);
  assert.equal(await ringOn(page, "2"), true);
  assert.equal(await ringOn(page, "1"), false);
  assert.match(
    await page
      .locator('[data-seat="2"] .seat-round')
      .evaluate((element) => getComputedStyle(element).boxShadow),
    /rgb\(0,\s*255,\s*136\)/,
  );

  assert.equal((await page.locator("#penetration").innerText()).trim(), "P: 0.24%");
  assert.equal((await page.locator("#decksLeft").innerText()).trim(), "D: 7.98");
  assert.equal((await page.locator("#ra").innerText()).trim(), "RA: -0.87");
  assert.equal((await page.locator("#hiLo").innerText()).trim(), "Hi-Lo: -1 / -0.13");
  assert.equal((await page.locator("#apcTC").innerText()).trim(), "APC: -0.38");
  assert.equal((await page.locator("#zenTC").innerText()).trim(), "Zen: -0.25");
  assert.equal((await page.locator("#omegaIITC").innerText()).trim(), "Omega II: -0.25");
  assert.equal((await page.locator("#aceTC").innerText()).trim(), "Ace: 0.01");
  for (const text of [
    await page.locator("#hiLo").innerText(),
    await page.locator("#apcTC").innerText(),
    await page.locator("#zenTC").innerText(),
    await page.locator("#omegaIITC").innerText(),
    await page.locator("#aceTC").innerText(),
  ]) {
    assert.equal(text.includes("+"), false, text);
  }

  for (const rank of RANKS) {
    const expected = rank === "K" ? "31" : "32";
    assert.equal((await rankLabel(page, rank).textContent())?.trim(), expected, rank);
  }
  assert.equal(
    await hoverTip(page, '#combinedChart .suit-slice[data-suit="spades"]'),
    "♠: 103",
  );
  assert.equal(
    await hoverTip(page, '#combinedChart .suit-slice[data-suit="clubs"]'),
    "♣: 104",
  );
  assert.equal(
    await hoverTip(page, '#combinedChart .suit-slice[data-suit="hearts"]'),
    "♥: 104",
  );
  assert.equal(
    await hoverTip(page, '#combinedChart .suit-slice[data-suit="diamonds"]'),
    "♦: 104",
  );
}

async function assertFreshShoe(page: Page): Promise<void> {
  for (const seat of SEATS) {
    assert.equal((await page.locator(`#hand-${seat}`).innerText()).trim(), "", seat);
  }
  assert.equal(await page.locator(".mini").count(), 0);
  assert.equal(await page.locator(".hand-total").count(), 0);
  assert.equal(await page.locator(".split-container").count(), 0);
  assert.equal(await page.getByRole("button", { name: "SPLIT" }).count(), 0);
  assert.equal(await ringOn(page, "1"), true);
  assert.equal(await ringOn(page, "2"), false);
  assert.equal(await page.locator(".seat-round.active").count(), 1);
  assert.match(
    await page
      .locator('[data-seat="1"] .seat-round')
      .evaluate((element) => getComputedStyle(element).boxShadow),
    /rgb\(0,\s*255,\s*136\)/,
  );

  assert.equal((await page.locator("#penetration").innerText()).trim(), "P: 0.00%");
  assert.equal((await page.locator("#decksLeft").innerText()).trim(), "D: 8.00");
  const ra = page.locator("#ra");
  assert.equal((await ra.innerText()).trim(), "RA: -0.88");
  assert.equal(await ra.getAttribute("class"), "negative");
  assert.equal(
    await ra.evaluate((element) => getComputedStyle(element).color),
    "rgb(239, 68, 68)",
  );
  assert.equal((await page.locator("#hiLo").innerText()).trim(), "Hi-Lo: 0 / 0.00");
  assert.equal((await page.locator("#apcTC").innerText()).trim(), "APC: 0.00");
  assert.equal((await page.locator("#zenTC").innerText()).trim(), "Zen: 0.00");
  assert.equal((await page.locator("#omegaIITC").innerText()).trim(), "Omega II: 0.00");
  assert.equal((await page.locator("#aceTC").innerText()).trim(), "Ace: 0.00");
  for (const text of [
    await page.locator("#hiLo").innerText(),
    await page.locator("#apcTC").innerText(),
    await page.locator("#zenTC").innerText(),
    await page.locator("#omegaIITC").innerText(),
    await page.locator("#aceTC").innerText(),
  ]) {
    assert.equal(text.includes("+"), false, text);
  }

  for (const rank of RANKS) {
    assert.equal((await rankLabel(page, rank).textContent())?.trim(), "32", rank);
  }
  for (const suit of SUITS) {
    assert.equal(
      await hoverTip(page, `#combinedChart .suit-slice[data-suit="${suit.suit}"]`),
      `${suit.symbol}: 104`,
    );
  }
}

/** NEW SHOE, click K (fixture 0 → K♠ on seat 1), click seat 2. */
async function dealKingThenFocusSeat2(page: Page): Promise<LiveEvent[]> {
  const shoe = page.getByRole("button", { name: "NEW SHOE" });
  assert.equal(await shoe.isVisible(), true);
  assert.equal(await shoe.isEnabled(), true);
  await shoe.click();
  await page.locator('#app[data-screen="felt_new_shoe"]').waitFor();

  const king = page.locator('#cardsGrid button[data-rank="K"]');
  assert.equal(await king.isVisible(), true);
  assert.equal(await king.isEnabled(), true);
  await king.click();
  await page.getByText("K♠", { exact: true }).waitFor();

  const seat2 = page.locator('[data-seat="2"] .seat-round');
  assert.equal(await seat2.isVisible(), true);
  await seat2.click();
  await assertDealtKing(page);
  return readHistory(page);
}

async function closeAll(
  browser: Browser | undefined,
  server: Server,
): Promise<void> {
  await browser?.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("start_shoe_mid_shoe_no_split: accept NEW SHOE clears the king and appends hand_completed then shoe_started", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin, ["accept", "accept"]);
    browser = opened.browser;
    const page = opened.page;
    const before = await dealKingThenFocusSeat2(page);
    assert.deepEqual(
      before.map((event) => event.type),
      ["shoe_started", "card_observed", "card_suit_set"],
    );
    assert.equal(before[1]?.rank, "K");
    assert.equal(before[1]?.seat, "1");
    assert.equal(before[2]?.suit, "spades");
    assert.equal(before[2]?.seat, "1");

    const shoe = page.getByRole("button", { name: "NEW SHOE" });
    assert.equal(await shoe.isVisible(), true);
    assert.equal(await shoe.isEnabled(), true);
    await shoe.click();
    await page.getByText("Hi-Lo: 0 / 0.00", { exact: true }).waitFor();
    await assertFreshShoe(page);

    const after = await readHistory(page);
    assert.deepEqual(after.slice(0, 3), before);
    assert.deepEqual(
      after.map((event) => event.type),
      [
        "shoe_started",
        "card_observed",
        "card_suit_set",
        "hand_completed",
        "shoe_started",
      ],
    );
    assert.deepEqual(after[3], { type: "hand_completed", position: 4 });
    assert.deepEqual(after[4], { type: "shoe_started", decks: 8, position: 5 });
    assert.deepEqual(opened.confirms, [
      "Start fresh 8-deck shoe?",
      "Start fresh 8-deck shoe?",
    ]);
  } finally {
    await closeAll(browser, server);
  }
});

test("start_shoe_mid_shoe_no_split: dismiss NEW SHOE leaves K♠, seat 2, and three events", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin, ["accept", "dismiss"]);
    browser = opened.browser;
    const page = opened.page;
    const before = await dealKingThenFocusSeat2(page);

    const shoe = page.getByRole("button", { name: "NEW SHOE" });
    assert.equal(await shoe.isVisible(), true);
    assert.equal(await shoe.isEnabled(), true);
    await shoe.click();
    await assertDealtKing(page);
    assert.deepEqual(await readHistory(page), before);
    assert.deepEqual(
      before.map((event) => event.type),
      ["shoe_started", "card_observed", "card_suit_set"],
    );
    assert.deepEqual(opened.confirms, [
      "Start fresh 8-deck shoe?",
      "Start fresh 8-deck shoe?",
    ]);
  } finally {
    await closeAll(browser, server);
  }
});
