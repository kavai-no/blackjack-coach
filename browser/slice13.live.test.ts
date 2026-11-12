import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

/**
 * Live Pages entry for slice 13. Serves `dist/` under `/blackjack-coach/`.
 * boot.js mounts the page. Helpers are copied for this file only.
 * `pickSuitRandom` is 0, so a rank click's auto-suit is spades.
 * The suit pad corrects a suit when the journey names one.
 * Backspace is the withdraw control. NEXT HAND is not used.
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
    await clickRank(page, "5");
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

test("felt_withdraw split: header click walks A then B, and Backspace removes only 1B", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;
    await newShoe(page);

    await page.locator('[data-seat="1"] .seat-round').dblclick();
    assert.equal(
      await page.locator('[data-seat="1"] .seat-round').evaluate((element) => {
        return element.classList.contains("your-seat");
      }),
      true,
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
    assert.equal(await totalColour(page, "1"), "rgb(255, 212, 63)");

    const split = page.locator("#splitBtn-1");
    assert.equal(await split.isVisible(), true);
    assert.equal(await split.isEnabled(), true);
    await split.click();
    await page.locator("#hand-1A .mini").waitFor();
    await page.locator("#hand-1B .mini").waitFor();
    assert.equal(await page.locator('#hand-1A .mini[data-suit="spades"]').count(), 1);
    assert.equal(await page.locator('#hand-1B .mini[data-suit="hearts"]').count(), 1);
    const totals = page.locator("#split-1 .hand-total");
    assert.equal(await totals.count(), 2);
    assert.equal((await totals.nth(0).innerText()).trim(), "Total: 8");
    assert.equal((await totals.nth(1).innerText()).trim(), "Total: 8");
    assert.equal(
      await totals.nth(0).evaluate((element) => getComputedStyle(element).color),
      "rgb(255, 212, 63)",
    );
    assert.equal(
      await totals.nth(1).evaluate((element) => getComputedStyle(element).color),
      "rgb(255, 212, 63)",
    );

    await clickSeat(page, "1");
    const pileA = page.locator("#split-1 .split-hand").nth(0);
    const pileB = page.locator("#split-1 .split-hand").nth(1);
    assert.equal(await pileA.evaluate((element) => element.classList.contains("active")), true);
    assert.equal(await pileB.evaluate((element) => element.classList.contains("active")), false);

    await clickRank(page, "5");
    await page.locator('#hand-1A .mini[data-rank="5"]').waitFor();
    assert.equal(await page.locator("#hand-1A .mini").count(), 2);

    await clickSeat(page, "1");
    assert.equal(await pileB.evaluate((element) => element.classList.contains("active")), true);
    assert.equal(await pileA.evaluate((element) => element.classList.contains("active")), false);

    await backspace(page);
    await page.locator("#hand-1B .mini").waitFor({ state: "detached" });

    assert.equal(await page.locator("#hand-1A .mini").count(), 2);
    assert.equal(await page.locator('#hand-1A .mini[data-rank="8"][data-suit="spades"]').count(), 1);
    assert.equal(await page.locator("#hand-1B .mini").count(), 0);
    assert.equal(await page.locator('#hand-1B .mini[data-suit="hearts"]').count(), 0);
    const history = await readHistory(page);
    const withdrawn = history.at(-1);
    assert.equal(withdrawn?.type, "card_withdrawn");
    assert.equal(withdrawn?.rank, "8");
    assert.equal(withdrawn?.seat, "1B");
    assert.equal(
      history.filter((event) => event.type === "card_withdrawn").length,
      1,
    );
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
    await assertRing(page, "1");

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
