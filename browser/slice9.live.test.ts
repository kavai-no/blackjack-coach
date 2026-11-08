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
 * Rank and suit clicks go through that entry. Events come from `readTable`,
 * the mounted store. No shell substitute and no second store.
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

test("live Pages entry: NEW SHOE, click K, click hearts — felt, counts, donut, events", async () => {
  execFileSync(process.execPath, ["scripts/build-pages.mjs"], {
    cwd: root,
    stdio: "inherit",
  });
  const built = readFileSync(join(dist, "boot.js"), "utf8");
  assert.equal(built.includes("/commands/observe-card"), true);
  assert.equal(built.includes("/commands/set-suit"), true);
  assert.equal(built.includes("cardsGrid"), true);
  assert.equal(built.includes("suitGrid"), true);
  assert.equal(built.includes("es3"), false);

  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    page.on("dialog", (dialog) => {
      assert.equal(dialog.message(), "Start fresh 8-deck shoe?");
      return dialog.accept();
    });
    await page.goto(`${origin}${BASE}/`);
    await page.getByRole("button", { name: "NEW SHOE" }).waitFor();

    const ranks = page.locator("#cardsGrid button");
    const suits = page.locator("#suitGrid button");
    assert.equal(await page.locator("#cardsGrid").count(), 1);
    assert.equal(await page.locator("#suitGrid").count(), 1);
    assert.equal(await ranks.count(), 13);
    assert.equal(await suits.count(), 4);
    assert.deepEqual(
      await ranks.evaluateAll((nodes) => nodes.map((node) => node.textContent)),
      ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"],
    );
    assert.deepEqual(
      await suits.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-suit"))),
      ["clubs", "diamonds", "hearts", "spades"],
    );

    const king = page.locator('#cardsGrid button[data-rank="K"]');
    const hearts = page.locator('#suitGrid button[data-suit="hearts"]');
    assert.equal(await king.isVisible(), true);
    assert.equal(await king.isEnabled(), true);
    assert.equal(await hearts.isVisible(), true);
    assert.equal(await hearts.isEnabled(), true);
    assert.deepEqual(await readHistory(page), []);

    await king.click();
    assert.deepEqual(await readHistory(page), []);
    assert.equal(await page.locator("#hand-1 .mini").count(), 0);
    assert.equal(
      (await page.locator('#combinedChart .rank-label[data-chart-rank="K"]').textContent())?.trim(),
      "32",
    );
    assert.equal((await page.locator("#ra").innerText()).trim(), "RA: -0.88");

    await hearts.click();
    assert.deepEqual(await readHistory(page), []);

    await page.getByRole("button", { name: "NEW SHOE" }).click();
    assert.deepEqual(
      (await readHistory(page)).map((event) => event.type),
      ["shoe_started"],
    );
    assert.equal((await readHistory(page))[0]?.decks, 8);

    await hearts.click();
    const afterBareSuit = await readHistory(page);
    assert.deepEqual(
      afterBareSuit.map((event) => event.type),
      ["shoe_started"],
    );
    assert.equal(await page.locator(".mini").count(), 0);
    assert.equal(
      (await page.locator('#combinedChart .suit-slice[data-suit="hearts"]').getAttribute("data-tip")),
      "♥: 104",
    );

    await king.click();
    const observed = await readHistory(page);
    assert.deepEqual(
      observed.map((event) => event.type),
      ["shoe_started", "card_observed"],
    );
    assert.equal(observed[1]?.rank, "K");
    assert.equal(observed[1]?.seat, "1");
    assert.equal(observed[1] !== undefined && "suit" in observed[1], false);
    assert.equal(
      (await page.locator('[data-seat="1"] .hand-total').innerText()).trim(),
      "Total: 10",
    );
    const unsuited = page.locator("#hand-1 .mini");
    assert.equal((await unsuited.innerText()).trim(), "K");
    assert.equal(await unsuited.getAttribute("data-rank"), "K");
    assert.equal(await unsuited.getAttribute("data-suit"), "");
    assert.equal(await page.locator("#hand-1 .mini").count(), 1);
    for (const seat of ["D", "7", "6", "5", "4", "3", "2"]) {
      assert.equal((await page.locator(`#hand-${seat}`).innerText()).trim(), "");
    }
    assert.equal(await page.locator(".seat-round.active").count(), 1);
    assert.equal(
      await page.locator('[data-seat="1"] .seat-round.your-seat').count(),
      1,
    );

    await page.getByText("APC: -0.38", { exact: true }).waitFor();
    await page.getByText("Ace: +0.01", { exact: true }).waitFor();
    await page.getByText("Hi-Lo: -1 / -0.13", { exact: true }).waitFor();
    await page.getByText("Zen: -0.25", { exact: true }).waitFor();
    await page.getByText("Omega II: -0.25", { exact: true }).waitFor();
    await page.getByText("P: 0.24%", { exact: true }).waitFor();
    await page.getByText("D: 7.98", { exact: true }).waitFor();
    assert.equal((await page.locator("#ra").innerText()).trim(), "RA: -0.87");
    assert.equal(await page.getByText("APC: -0.50", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Ace: +0.00", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Omega II: +0.38", { exact: true }).count(), 0);

    for (const rank of ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q"]) {
      assert.equal(
        (await page.locator(`#combinedChart .rank-label[data-chart-rank="${rank}"]`).textContent())?.trim(),
        "32",
        rank,
      );
    }
    assert.equal(
      (await page.locator('#combinedChart .rank-label[data-chart-rank="K"]').textContent())?.trim(),
      "31",
    );
    assert.equal(
      (await page.locator('#combinedChart .suit-slice[data-suit="hearts"]').getAttribute("data-tip")),
      "♥: 104",
    );

    await hearts.click();
    const suited = await readHistory(page);
    assert.deepEqual(
      suited.map((event) => event.type),
      ["shoe_started", "card_observed", "card_suit_set"],
    );
    assert.equal(suited[2]?.suit, "hearts");
    assert.equal(suited[2]?.seat, "1");
    assert.equal(suited[2] !== undefined && "rank" in suited[2], false);
    const faced = page.locator("#hand-1 .mini");
    assert.equal((await faced.innerText()).trim(), "K♥");
    assert.equal(await faced.getAttribute("data-rank"), "K");
    assert.equal(await faced.getAttribute("data-suit"), "hearts");
    assert.equal(
      (await page.locator('[data-seat="1"] .hand-total').innerText()).trim(),
      "Total: 10",
    );
    assert.equal(
      (await page.locator('#combinedChart .rank-label[data-chart-rank="K"]').textContent())?.trim(),
      "31",
    );
    assert.equal(
      (await page.locator('#combinedChart .rank-label[data-chart-rank="10"]').textContent())?.trim(),
      "32",
    );
    assert.equal(
      (await page.locator('#combinedChart .suit-slice[data-suit="hearts"]').getAttribute("data-tip")),
      "♥: 103",
    );
    assert.equal(
      (await page.locator('#combinedChart .suit-slice[data-suit="spades"]').getAttribute("data-tip")),
      "♠: 104",
    );
    await page.getByText("APC: -0.38", { exact: true }).waitFor();
    await page.getByText("Ace: +0.01", { exact: true }).waitFor();
    assert.equal(/RoR|Wong|21\+3|sidebet/i.test(await page.locator("#app").innerText()), false);
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
