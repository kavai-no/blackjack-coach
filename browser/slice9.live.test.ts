import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

/**
 * Live Pages entry. Serves `dist/` — the directory deploy.yml uploads —
 * under `/blackjack-coach/`. The page script is `./boot.js`.
 * A rank click posts observe-card then set-suit. The suit pad corrects it.
 * Events come from `readTable`. `pickSuitRandom` is set before boot.js.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const BASE = "/blackjack-coach";

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

/** Same read-only `readTable` the page publishes. Not a second store. */
function readHistory(page: Page): Promise<LiveEvent[]> {
  return page.evaluate(() => {
    const read = Reflect.get(globalThis, "readTable");
    if (typeof read !== "function") {
      throw new Error("readTable missing");
    }
    return read();
  });
}

/** Fixture value 0, installed before the page's boot.js evaluates. */
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

async function handTotalColour(page: Page): Promise<string> {
  return page.locator('[data-seat="1"] .hand-total').evaluate((element) => {
    return getComputedStyle(element).color;
  });
}

async function hoverTip(page: Page, selector: string): Promise<string> {
  await page.locator(selector).hover();
  return (await page.locator("#combinedChart .d3-tooltip").innerText()).trim();
}

function rankLabel(page: Page, rank: string) {
  return page.locator(`#combinedChart .rank-label[data-chart-rank="${rank}"]`);
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

test("felt_pick_rank: NEW SHOE, click K, fixture 0 draws K♠", async () => {
  buildDist();
  const builtJs = readFileSync(join(dist, "boot.js"), "utf8");
  assert.equal(builtJs.includes("/commands/observe-card"), true);
  assert.equal(builtJs.includes("/commands/set-suit"), true);
  assert.equal(builtJs.includes("pickSuitRandom"), true);
  assert.equal(builtJs.includes("es3"), false);

  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;

    const ranks = page.locator("#cardsGrid button");
    const suits = page.locator("#suitGrid button");
    assert.equal(await page.locator("#cardsGrid").count(), 1);
    assert.equal(await page.locator("#suitGrid").count(), 1);
    assert.equal(await ranks.count(), 13);
    assert.equal(await suits.count(), 4);
    const king = page.locator('#cardsGrid button[data-rank="K"]');
    assert.equal(await king.isEnabled(), true);
    assert.deepEqual(await readHistory(page), []);

    await king.click();
    assert.deepEqual(await readHistory(page), []);

    await page.getByRole("button", { name: "NEW SHOE" }).click();
    await page.locator('#app[data-screen="felt_new_shoe"]').waitFor();
    await page.locator('#suitGrid button[data-suit="hearts"]').click();
    assert.deepEqual(
      (await readHistory(page)).map((event) => event.type),
      ["shoe_started"],
    );

    await king.click();
    await page.getByText("K♠", { exact: true }).waitFor();
    const history = await readHistory(page);
    assert.deepEqual(
      history.map((event) => event.type),
      ["shoe_started", "card_observed", "card_suit_set"],
    );
    assert.equal(history[1]?.rank, "K");
    assert.equal(history[1]?.seat, "1");
    assert.equal(history[1] !== undefined && "suit" in history[1], false);
    assert.equal(history[2]?.suit, "spades");
    assert.equal(history[2]?.seat, "1");
    assert.equal(history[2] !== undefined && "rank" in history[2], false);

    const card = page.locator("#hand-1 .mini");
    assert.equal(await card.count(), 1);
    assert.equal((await card.innerText()).trim(), "K♠");
    assert.equal(await card.getAttribute("data-rank"), "K");
    assert.equal(await card.getAttribute("data-suit"), "spades");
    assert.equal(
      (await page.locator('[data-seat="1"] .hand-total').innerText()).trim(),
      "Total: 10",
    );
    assert.equal(await handTotalColour(page), "rgb(255, 212, 63)");
    for (const seat of ["D", "7", "6", "5", "4", "3", "2"]) {
      assert.equal((await page.locator(`#hand-${seat}`).innerText()).trim(), "");
    }

    assert.equal((await page.locator("#penetration").innerText()).trim(), "P: 0.24%");
    assert.equal((await page.locator("#decksLeft").innerText()).trim(), "D: 7.98");
    assert.equal((await page.locator("#ra").innerText()).trim(), "RA: -0.87");
    assert.equal((await page.locator("#hiLo").innerText()).trim(), "Hi-Lo: -1 / -0.13");
    assert.equal((await page.locator("#apcTC").innerText()).trim(), "APC: -0.38");
    assert.equal((await page.locator("#zenTC").innerText()).trim(), "Zen: -0.25");
    assert.equal((await page.locator("#omegaIITC").innerText()).trim(), "Omega II: -0.25");
    assert.equal((await page.locator("#aceTC").innerText()).trim(), "Ace: 0.01");

    for (const rank of ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q"]) {
      assert.equal((await rankLabel(page, rank).textContent())?.trim(), "32", rank);
    }
    assert.equal((await rankLabel(page, "K").textContent())?.trim(), "31");
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
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("felt_set_suit: hearts corrects the drawn K♠ to K♥", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;
    await page.getByRole("button", { name: "NEW SHOE" }).click();
    await page.locator('#app[data-screen="felt_new_shoe"]').waitFor();
    await page.locator('#cardsGrid button[data-rank="K"]').click();
    await page.getByText("K♠", { exact: true }).waitFor();

    await page.locator('#suitGrid button[data-suit="hearts"]').click();
    await page.getByText("K♥", { exact: true }).waitFor();

    const history = await readHistory(page);
    assert.deepEqual(
      history.map((event) => event.type),
      ["shoe_started", "card_observed", "card_suit_set", "card_suit_set"],
    );
    assert.equal(history[2]?.suit, "spades");
    assert.equal(history[3]?.suit, "hearts");
    assert.equal(history[3]?.seat, "1");
    assert.equal(history[3] !== undefined && "rank" in history[3], false);

    const card = page.locator("#hand-1 .mini");
    assert.equal(await card.count(), 1);
    assert.equal((await card.innerText()).trim(), "K♥");
    assert.equal(await card.getAttribute("data-rank"), "K");
    assert.equal(await card.getAttribute("data-suit"), "hearts");
    assert.equal(
      (await page.locator('[data-seat="1"] .hand-total').innerText()).trim(),
      "Total: 10",
    );
    assert.equal(await handTotalColour(page), "rgb(255, 212, 63)");
    assert.equal((await rankLabel(page, "K").textContent())?.trim(), "31");
    for (const rank of ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q"]) {
      assert.equal((await rankLabel(page, rank).textContent())?.trim(), "32", rank);
    }
    assert.equal(
      await hoverTip(page, '#combinedChart .suit-slice[data-suit="spades"]'),
      "♠: 104",
    );
    assert.equal(
      await hoverTip(page, '#combinedChart .suit-slice[data-suit="clubs"]'),
      "♣: 104",
    );
    assert.equal(
      await hoverTip(page, '#combinedChart .suit-slice[data-suit="hearts"]'),
      "♥: 103",
    );
    assert.equal(
      await hoverTip(page, '#combinedChart .suit-slice[data-suit="diamonds"]'),
      "♦: 104",
    );
    assert.equal((await page.locator("#penetration").innerText()).trim(), "P: 0.24%");
    assert.equal((await page.locator("#decksLeft").innerText()).trim(), "D: 7.98");
    assert.equal((await page.locator("#ra").innerText()).trim(), "RA: -0.87");
    assert.equal((await page.locator("#hiLo").innerText()).trim(), "Hi-Lo: -1 / -0.13");
    assert.equal((await page.locator("#apcTC").innerText()).trim(), "APC: -0.38");
    assert.equal((await page.locator("#zenTC").innerText()).trim(), "Zen: -0.25");
    assert.equal((await page.locator("#omegaIITC").innerText()).trim(), "Omega II: -0.25");
    assert.equal((await page.locator("#aceTC").innerText()).trim(), "Ace: 0.01");
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
