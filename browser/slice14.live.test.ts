import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page } from "playwright";

/**
 * Live Pages entry for slice 14. Serves `dist/` — the directory deploy.yml
 * uploads — under `/blackjack-coach/`. The page script is `./boot.js`.
 * Helpers are copied for this file only.
 * `pickSuitRandom` is 0, so a rank click's auto-suit is spades.
 * The suit pad corrects the first king to hearts. Then K♠. SPLIT is clicked.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const BASE = "/blackjack-coach";
const SEATS = ["D", "7", "6", "5", "4", "3", "2", "1"] as const;
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
const SUITS = [
  { suit: "spades", symbol: "♠", count: "103" },
  { suit: "clubs", symbol: "♣", count: "104" },
  { suit: "hearts", symbol: "♥", count: "103" },
  { suit: "diamonds", symbol: "♦", count: "104" },
] as const;

const INFO_BEFORE = {
  p: "P: 0.48%",
  d: "D: 7.96",
  ra: "RA: -0.87",
  hilo: "Hi-Lo: -2 / -0.25",
  apc: "APC: -0.75",
  zen: "Zen: -0.50",
  omega: "Omega II: -0.50",
  ace: "Ace: 0.02",
};

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
async function openLive(origin: string): Promise<{ browser: Browser; page: Page; confirms: string[] }> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const confirms: string[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "pickSuitRandom", {
      configurable: true,
      enumerable: false,
      writable: false,
      value: 0,
    });
  });
  page.on("dialog", (dialog) => {
    confirms.push(dialog.message());
    if (dialog.message() !== "Start fresh 8-deck shoe?") {
      throw new Error(dialog.message());
    }
    return dialog.accept();
  });
  await page.goto(`${origin}${BASE}/`);
  await page.locator('#app[data-screen="felt_idle_no_events"]').waitFor();
  return { browser, page, confirms };
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

async function text(page: Page, selector: string): Promise<string> {
  return (await page.locator(selector).innerText()).trim();
}

async function assertFace(card: Locator, rank: string, symbol: string): Promise<void> {
  assert.equal((await card.locator(".corner.top-left").innerText()).trim(), rank);
  assert.equal((await card.locator(".corner.bottom-right").innerText()).trim(), rank);
  assert.equal((await card.locator(".suit.top-right").innerText()).trim(), symbol);
  assert.equal((await card.locator(".suit.bottom-left").innerText()).trim(), symbol);
  const loose = await card.evaluate((element) =>
    [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join("")
      .trim(),
  );
  assert.equal(loose, "");
}

async function infoBar(page: Page): Promise<Record<string, string>> {
  const bar = {
    p: await text(page, "#penetration"),
    d: await text(page, "#decksLeft"),
    ra: await text(page, "#ra"),
    hilo: await text(page, "#hiLo"),
    apc: await text(page, "#apcTC"),
    zen: await text(page, "#zenTC"),
    omega: await text(page, "#omegaIITC"),
    ace: await text(page, "#aceTC"),
  };
  assert.equal(/[+]/.test(Object.values(bar).join(" ")), false);
  return bar;
}

function rankLabel(page: Page, rank: string) {
  return page.locator(`#combinedChart .rank-label[data-chart-rank="${rank}"]`);
}

async function hoverSuit(page: Page, suit: string): Promise<string> {
  await page.locator(`#combinedChart .suit-slice[data-suit="${suit}"]`).hover();
  return (await page.locator("#combinedChart .d3-tooltip").innerText()).trim();
}

async function clickSeat(page: Page, seat: string): Promise<void> {
  await page.locator(`[data-seat="${seat}"] .seat-round`).click();
}

/** Hero ring is `.your-seat`. Double-click also lands the focus ring via click. */
async function assertHeroSelected(page: Page): Promise<void> {
  const seat = page.locator('[data-seat="1"] .seat-round');
  assert.equal(await seat.evaluate((element) => element.classList.contains("your-seat")), true);
  assert.equal(await seat.evaluate((element) => element.classList.contains("active")), true);
  const shadow = await seat.evaluate((element) => getComputedStyle(element).boxShadow);
  assert.match(shadow, /rgba?\(34,\s*197,\s*94/);
  assert.match(shadow, /rgb\(0,\s*255,\s*136\)/);
  assert.equal(await page.locator(".seat-round.your-seat").count(), 1);
}

async function rankCounts(page: Page): Promise<Record<string, string>> {
  const counts: Record<string, string> = {};
  for (const rank of RANKS) {
    counts[rank] = (await rankLabel(page, rank).textContent())?.trim() ?? "";
  }
  return counts;
}

async function suitTips(page: Page): Promise<Record<string, string>> {
  const tips: Record<string, string> = {};
  for (const suit of SUITS) {
    tips[suit.suit] = await hoverSuit(page, suit.suit);
  }
  return tips;
}

test("felt_next_hand: NEXT HAND clears split A/B and keeps the shoe", async () => {
  buildDist();
  const builtJs = readFileSync(join(dist, "boot.js"), "utf8");
  assert.equal(builtJs.includes("#nextHandBtn"), true);
  assert.equal(builtJs.includes("/commands/complete-hand"), true);
  assert.equal(builtJs.includes("es3"), false);

  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;
    assert.match(page.url(), /\/blackjack-coach\/?$/);
    assert.deepEqual(await readHistory(page), []);

    await page.locator('[data-seat="1"] .seat-round').dblclick();
    await assertHeroSelected(page);

    await page.getByRole("button", { name: "NEW SHOE" }).click();
    await page.locator('#app[data-screen="felt_new_shoe"]').waitFor();
    await assertHeroSelected(page);
    assert.deepEqual((await readHistory(page)).map((event) => event.type), ["shoe_started"]);
    assert.equal((await readHistory(page))[0]?.decks, 8);

    await clickSeat(page, "1");
    await page.locator('#cardsGrid button[data-rank="K"]').click();
    await page.locator('#hand-1 .mini[data-suit="spades"] .suit.top-right').waitFor();
    await page.locator('#suitGrid button[data-suit="hearts"]').click();
    await page.locator('#hand-1 .mini[data-suit="hearts"] .suit.top-right').waitFor();

    await clickSeat(page, "1");
    await page.locator('#cardsGrid button[data-rank="K"]').click();
    await page.locator('#hand-1 .mini[data-suit="spades"] .suit.top-right').waitFor();

    const split = page.locator("#splitBtn-1");
    assert.equal(await split.count(), 1);
    assert.equal(await split.isVisible(), true);
    assert.equal(await split.isEnabled(), true);
    assert.equal((await split.innerText()).trim(), "SPLIT");
    await split.click();
    await page.locator('#app[data-screen="felt_split"]').waitFor();
    await page.locator('#hand-1A .mini[data-suit="hearts"] .corner.top-left').waitFor();

    const dealt = await readHistory(page);
    assert.deepEqual(
      dealt.map((event) => event.type),
      [
        "shoe_started",
        "card_observed",
        "card_suit_set",
        "card_suit_set",
        "card_observed",
        "card_suit_set",
        "hand_split",
      ],
    );
    assert.equal(dealt[6]?.type, "hand_split");
    assert.equal(dealt[6]?.seat, "1");
    assert.equal(dealt.some((event) => event.type === "hand_completed"), false);

    const ace = page.locator("#hand-1A .mini");
    const bee = page.locator("#hand-1B .mini");
    assert.equal(await ace.count(), 1);
    await assertFace(ace, "K", "♥");
    assert.equal(await ace.getAttribute("data-suit"), "hearts");
    assert.equal(await bee.count(), 1);
    await assertFace(bee, "K", "♠");
    assert.equal(await bee.getAttribute("data-suit"), "spades");
    assert.equal((await page.locator("#split-1 .split-label").nth(0).innerText()).trim(), "A");
    assert.equal((await page.locator("#split-1 .split-label").nth(1).innerText()).trim(), "B");
    const totals = page.locator("#split-1 .hand-total");
    assert.equal(await totals.count(), 2);
    for (const index of [0, 1]) {
      const total = totals.nth(index);
      const label = page.locator("#split-1 .split-label").nth(index);
      assert.equal((await total.innerText()).trim(), "Total: 10");
      assert.equal(
        await total.evaluate((element) => getComputedStyle(element).color),
        "rgb(255, 212, 63)",
      );
      const totalBox = await total.boundingBox();
      const labelBox = await label.boundingBox();
      assert.ok(totalBox);
      assert.ok(labelBox);
      assert.ok(totalBox.y >= labelBox.y + labelBox.height - 1);
    }
    assert.equal(await page.locator("#hand-1").locator(".mini").count(), 0);
    assert.equal(await page.locator("#hand-1").isVisible(), false);
    assert.equal(await page.locator("#splitBtn-1").count(), 0);
    assert.equal(await page.getByRole("button", { name: "SPLIT" }).count(), 0);
    await assertHeroSelected(page);
    assert.deepEqual(
      await page.locator("[data-seat]").evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-seat")),
      ),
      [...SEATS],
    );

    const beforeInfo = await infoBar(page);
    assert.deepEqual(beforeInfo, INFO_BEFORE);
    const beforeRanks = await rankCounts(page);
    for (const rank of RANKS) {
      assert.equal(beforeRanks[rank], rank === "K" ? "30" : "32", rank);
    }
    const beforeSuits = await suitTips(page);
    for (const suit of SUITS) {
      assert.equal(beforeSuits[suit.suit], `${suit.symbol}: ${suit.count}`);
    }

    await clickSeat(page, "7");
    assert.equal(
      await page.locator('[data-seat="7"] .seat-round').evaluate((element) =>
        element.classList.contains("active"),
      ),
      true,
    );
    assert.equal(
      await page.locator('[data-seat="1"] .seat-round').evaluate((element) =>
        element.classList.contains("active"),
      ),
      false,
    );
    assert.equal(await page.locator(".seat-round.active").count(), 1);
    assert.deepEqual((await readHistory(page)).map((event) => event.type), dealt.map((event) => event.type));

    const next = page.getByRole("button", { name: "NEXT HAND" });
    assert.equal(await next.count(), 1);
    assert.equal(await next.isVisible(), true);
    assert.equal(await next.isEnabled(), true);
    const capturedInfo = await infoBar(page);
    const capturedRanks = await rankCounts(page);
    const capturedSuits = await suitTips(page);
    assert.deepEqual(capturedInfo, beforeInfo);
    assert.deepEqual(capturedRanks, beforeRanks);
    assert.deepEqual(capturedSuits, beforeSuits);

    await next.click();
    await page.locator("#hand-1A").waitFor({ state: "detached" });
    await page.locator("#hand-1").waitFor({ state: "visible" });

    assert.deepEqual(opened.confirms, ["Start fresh 8-deck shoe?"]);
    const cleared = await readHistory(page);
    assert.deepEqual(
      cleared.map((event) => event.type),
      [...dealt.map((event) => event.type), "hand_completed"],
    );
    assert.equal(cleared.filter((event) => event.type === "shoe_started").length, 1);
    assert.equal(cleared[0]?.decks, 8);
    const completed = cleared.at(-1);
    assert.ok(completed);
    assert.equal(completed.type, "hand_completed");
    assert.deepEqual(Object.keys(completed).sort(), ["position", "type"]);

    assert.deepEqual(
      await page.locator("[data-seat]").evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-seat")),
      ),
      [...SEATS],
    );
    assert.equal(await page.locator(".mini").count(), 0);
    assert.equal(await page.locator(".hand-total").count(), 0);
    assert.equal(await page.locator("#hand-1A").count(), 0);
    assert.equal(await page.locator("#hand-1B").count(), 0);
    assert.equal(await page.locator(".split-hand").count(), 0);
    assert.equal(await page.locator(".split-container").count(), 0);
    assert.equal(await page.locator("#split-1").count(), 0);
    assert.equal(await page.locator("#splitBtn-1").count(), 0);
    assert.equal(await page.getByRole("button", { name: "SPLIT" }).count(), 0);
    for (const seat of SEATS) {
      const hand = page.locator(`#hand-${seat}`);
      assert.equal(await hand.count(), 1);
      assert.equal(await hand.isVisible(), true);
      assert.equal((await hand.innerText()).trim(), "");
      assert.equal(await hand.evaluate((element) => getComputedStyle(element).display), "flex");
      assert.equal(
        await hand.evaluate((element) => (element as HTMLElement).style.display),
        "flex",
      );
    }
    await assertHeroSelected(page);
    assert.equal(await page.locator(".seat-round.active").count(), 1);
    assert.equal(
      await page.locator('[data-seat="7"] .seat-round').evaluate((element) =>
        element.classList.contains("active"),
      ),
      false,
    );
    assert.deepEqual(await infoBar(page), capturedInfo);
    assert.deepEqual(await rankCounts(page), capturedRanks);
    assert.deepEqual(await suitTips(page), capturedSuits);

    await next.click();
    const twice = await readHistory(page);
    assert.deepEqual(twice.slice(-2).map((event) => event.type), [
      "hand_completed",
      "hand_completed",
    ]);
    assert.equal(twice.filter((event) => event.type === "shoe_started").length, 1);
    assert.deepEqual(Object.keys(twice.at(-1) ?? {}).sort(), ["position", "type"]);
    assert.equal(await page.locator(".mini").count(), 0);
    assert.equal(await page.locator(".hand-total").count(), 0);
    assert.equal(await page.locator(".split-container").count(), 0);
    assert.equal(await page.getByRole("button", { name: "SPLIT" }).count(), 0);
    for (const seat of SEATS) {
      const hand = page.locator(`#hand-${seat}`);
      assert.equal(await hand.isVisible(), true);
      assert.equal((await hand.innerText()).trim(), "");
      assert.equal(await hand.evaluate((element) => getComputedStyle(element).display), "flex");
    }
    await assertHeroSelected(page);
    assert.deepEqual(await infoBar(page), capturedInfo);
    assert.deepEqual(await rankCounts(page), capturedRanks);
    assert.deepEqual(await suitTips(page), capturedSuits);
  } finally {
    await close(server, browser);
  }
});
