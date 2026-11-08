import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { chromium, type Browser, type Page } from "playwright";
import { mountNewShoePage } from "../src/pages/new-shoe-page.ts";
import { TABLE_STREAM } from "../src/write/in-memory-store.ts";

/**
 * Real-browser acceptance for the Pages artifact.
 * Serves `dist/` — the directory `.github/workflows/deploy.yml` uploads —
 * under the project-site base path `/blackjack-coach/`.
 * The page's own `<script src="./boot.js">` mounts the app.
 *
 * Not claimed here: the HCL mid-shoe branch that double-clicks hero seat 1,
 * Not claimed here: the HCL mid-shoe branch that double-clicks hero seat 1,
 * deals K♥/K♠, and clicks SPLIT. The live entry mounts `#cardsGrid` and
 * `#suitGrid`. It does not paint SPLIT until a hero pair exists. No seat
 * wears `.active` until a click or NEW SHOE. Hero `your-seat` on seat 1
 * is original `buildTable`. The Chromium test loads `dist/boot.js` and
 * reads `readTable`, the mounted store's table stream. The linkedom mount
 * below is supporting only. `live_page_not_proven_8` stays open until
 * SPLIT is reachable live.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const BASE = "/blackjack-coach";

const SUITS = [
  { suit: "spades", symbol: "♠" },
  { suit: "clubs", symbol: "♣" },
  { suit: "hearts", symbol: "♥" },
  { suit: "diamonds", symbol: "♦" },
] as const;

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;

type RecordedTableEvent = {
  type: string;
  position: number;
  decks?: number;
};

/** Read the table stream of the page boot.js mounted. Not a second store. */
async function recordedTable(page: Page): Promise<RecordedTableEvent[]> {
  const history = await page.evaluate(() => {
    const read = Reflect.get(globalThis, "readTable");
    if (typeof read !== "function") {
      throw new Error("readTable missing");
    }
    return read();
  });
  return history as RecordedTableEvent[];
}

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

test("felt_idle_no_events: idle paint leaves the event history empty", () => {
  const { document } = parseHTML(readFileSync(join(root, "index.html"), "utf8"));
  const store = mountNewShoePage(document, () => {
    throw new Error("confirm must not run while the idle screen mounts");
  });
  const history = store.read(TABLE_STREAM);
  assert.equal(
    history.some((event) => event.type === "shoe_started"),
    false,
  );
  assert.deepEqual(history, []);
  const painted = document.querySelector("#app")?.innerHTML ?? "";
  assert.match(painted, />RA: -0\.88</);
  assert.equal(painted.includes("seat-round active"), false);
});

async function assertFullShoeChart(page: Page): Promise<void> {
  await page.getByText("P: 0.00%", { exact: true }).waitFor();
  await page.getByText("D: 8.00", { exact: true }).waitFor();
  const ra = page.locator("#ra");
  assert.equal((await ra.innerText()).trim(), "RA: -0.88");
  assert.equal(await ra.getAttribute("data-value"), "-0.88");
  assert.equal(await ra.getAttribute("class"), "negative");
  assert.equal(
    await ra.evaluate((element) => getComputedStyle(element).color),
    "rgb(239, 68, 68)",
  );
  await page.getByText("Hi-Lo: 0 / +0.00", { exact: true }).waitFor();
  await page.getByText("APC: +0.00", { exact: true }).waitFor();
  await page.getByText("Zen: +0.00", { exact: true }).waitFor();
  await page.getByText("Omega II: +0.00", { exact: true }).waitFor();
  await page.getByText("Ace: +0.00", { exact: true }).waitFor();

  const labels = page.locator("#combinedChart .rank-label");
  assert.equal(await page.locator("#combinedChart svg .rank-path").count(), 13);
  assert.equal(await page.locator("#combinedChart svg .suit-slice").count(), 4);
  assert.equal(await labels.count(), 13);
  for (let index = 0; index < 13; index += 1) {
    const label = labels.nth(index);
    assert.equal(await label.isVisible(), true);
    assert.equal((await label.textContent())?.trim(), "32");
  }

  const tip = page.locator("#combinedChart .d3-tooltip");
  for (const rank of RANKS) {
    const slice = page.locator(`#combinedChart .rank-path[data-chart-rank="${rank}"]`);
    assert.equal(await slice.isVisible(), true);
    await slice.hover();
    await tip.waitFor({ state: "visible" });
    assert.equal((await tip.textContent())?.trim(), `${rank}: 32`);
  }

  for (const suit of SUITS) {
    const slice = page.locator(`#combinedChart .suit-slice[data-suit="${suit.suit}"]`);
    assert.equal(await slice.isVisible(), true);
    assert.equal((await slice.textContent())?.trim(), suit.symbol);
    await slice.hover();
    await tip.waitFor({ state: "visible" });
    assert.equal((await tip.textContent())?.trim(), `${suit.symbol}: 104`);
  }
}

async function assertEmptyShoe(page: Page): Promise<void> {
  const seats = await page.locator("[data-seat]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-seat")),
  );
  assert.deepEqual(seats, ["D", "7", "6", "5", "4", "3", "2", "1"]);

  for (const seat of seats) {
    const hand = page.locator(`#hand-${seat}`);
    assert.equal(await hand.count(), 1);
    assert.equal((await hand.innerText()).trim(), "");
  }
  assert.equal(await page.locator(".hand-total").count(), 0);
  assert.equal(await page.locator(".split-container").count(), 0);
  assert.equal(await page.locator(".split-hand").count(), 0);
  assert.equal(await page.getByRole("button", { name: "SPLIT" }).count(), 0);
  assert.equal(await page.locator(".mini").count(), 0);

  const seat1 = page.locator('[data-seat="1"] .seat-round');
  assert.equal(await seat1.evaluate((element) => element.classList.contains("active")), true);
  assert.equal(
    await seat1.evaluate((element) => element.classList.contains("your-seat")),
    true,
  );
  const ring = await seat1.evaluate((element) => getComputedStyle(element).boxShadow);
  assert.match(ring, /rgb\(0,\s*255,\s*136\)/);
  assert.equal(await page.locator(".seat-round.active").count(), 1);

  await page.getByText("Ace: +0.00", { exact: true }).waitFor();

  await assertFullShoeChart(page);
}

test("live Pages entry at /blackjack-coach/ — NEW SHOE, focus return, confirm dismiss", async () => {
  execFileSync(process.execPath, ["scripts/build-pages.mjs"], {
    cwd: root,
    stdio: "inherit",
  });
  const built = readFileSync(join(dist, "index.html"), "utf8");
  assert.match(built, /src="\.\/boot\.js"/);
  assert.match(built, /href="\.\/styles\.css"/);
  assert.equal(existsSync(join(dist, "boot.js")), true);

  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    const loaded: string[] = [];
    page.on("response", (response) => {
      loaded.push(`${response.status()} ${response.url()}`);
    });
    page.on("dialog", (dialog) => {
      assert.equal(dialog.message(), "Start fresh 8-deck shoe?");
      return dialog.accept();
    });
    await page.goto(`${origin}${BASE}/`);
    await page.locator('#app[data-screen="felt_idle_no_events"]').waitFor();

    assert.equal(page.url(), `${origin}${BASE}/`);
    assert.equal(
      loaded.some((line) => line.startsWith(`200 ${origin}${BASE}/boot.js`)),
      true,
    );
    assert.equal(
      loaded.some((line) => line.startsWith(`200 ${origin}${BASE}/styles.css`)),
      true,
    );
    assert.equal(loaded.some((line) => line === `200 ${origin}/boot.js`), false);

    const shoe = page.getByRole("button", { name: "NEW SHOE" });
    assert.equal(await shoe.isVisible(), true);
    assert.equal(await shoe.isEnabled(), true);
    assert.equal(await page.locator("#cardsGrid").count(), 1);
    assert.equal(await page.locator("#suitGrid").count(), 1);
    assert.equal(await page.getByRole("button", { name: "SPLIT" }).count(), 0);
    await assertFullShoeChart(page);
    assert.equal(await page.locator("[data-seat]").count(), 8);
    assert.equal(await page.locator(".hand-total").count(), 0);
    assert.equal(await page.locator(".seat-round.active").count(), 0);
    assert.equal(
      await page
        .locator('[data-seat="1"] .seat-round')
        .evaluate((element) => element.classList.contains("your-seat")),
      true,
    );
    const idleHistory = await recordedTable(page);
    assert.equal(
      idleHistory.some((event) => event.type === "shoe_started"),
      false,
    );
    assert.deepEqual(idleHistory, []);

    const seat2 = page.locator('[data-seat="2"] .seat-round');
    await seat2.waitFor();
    assert.equal(await seat2.isVisible(), true);
    await seat2.click();
    assert.equal(
      await seat2.evaluate((element) => element.classList.contains("active")),
      true,
    );
    assert.match(
      await seat2.evaluate((element) => getComputedStyle(element).boxShadow),
      /rgb\(0,\s*255,\s*136\)/,
    );
    assert.equal(
      await page
        .locator('[data-seat="1"] .seat-round')
        .evaluate((element) => element.classList.contains("active")),
      false,
    );

    await shoe.click();
    await page.locator('#app[data-screen="felt_new_shoe"]').waitFor();
    const started = await recordedTable(page);
    assert.deepEqual(started, [
      { type: "shoe_started", decks: 8, position: 1 },
    ]);
    await assertEmptyShoe(page);

    await page.locator('[data-seat="2"] .seat-round').click();
    assert.equal(
      await page
        .locator('[data-seat="2"] .seat-round')
        .evaluate((element) => element.classList.contains("active")),
      true,
    );
    assert.equal(
      await page
        .locator('[data-seat="1"] .seat-round')
        .evaluate((element) => element.classList.contains("active")),
      false,
    );
    assert.equal(
      await page
        .locator('[data-seat="1"] .seat-round')
        .evaluate((element) => element.classList.contains("your-seat")),
      true,
    );

    await shoe.click();
    await assertEmptyShoe(page);
    await page.close();

    const cancelled = await browser.newPage();
    cancelled.on("dialog", (dialog) => {
      assert.equal(dialog.message(), "Start fresh 8-deck shoe?");
      return dialog.dismiss();
    });
    await cancelled.goto(`${origin}${BASE}/`);
    await cancelled.locator('#app[data-screen="felt_idle_no_events"]').waitFor();
    const again = cancelled.getByRole("button", { name: "NEW SHOE" });
    await again.waitFor();
    assert.equal(await again.isEnabled(), true);
    const before = cancelled.locator('[data-seat="2"] .seat-round');
    await before.click();
    assert.equal(
      await before.evaluate((element) => element.classList.contains("active")),
      true,
    );
    await again.click();
    assert.equal(
      await before.evaluate((element) => element.classList.contains("active")),
      true,
    );
    assert.equal(
      await cancelled
        .locator('[data-seat="1"] .seat-round')
        .evaluate((element) => element.classList.contains("active")),
      false,
    );
    assert.equal((await cancelled.locator("#ra").innerText()).trim(), "RA: -0.88");
    assert.equal(await cancelled.locator(".rank-label").count(), 13);
    assert.equal(
      await cancelled.locator("#app").getAttribute("data-screen"),
      "felt_idle_no_events",
    );
    assert.deepEqual(await recordedTable(cancelled), []);
    await cancelled.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
