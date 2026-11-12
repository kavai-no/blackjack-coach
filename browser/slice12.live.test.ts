import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page } from "playwright";

/**
 * Live Pages entry for slice 12. Serves `dist/` — the directory deploy.yml
 * uploads — under `/blackjack-coach/`. The page script is `./boot.js`.
 * Helpers are copied for this file only.
 * `pickSuitRandom` is 0, so a rank click's auto-suit is spades.
 * The suit pad corrects the first king to hearts. Then K♠.
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

async function assertClearOf(part: Locator, cover: Locator): Promise<void> {
  const partBox = await part.boundingBox();
  const coverBox = await cover.boundingBox();
  assert.ok(partBox);
  assert.ok(coverBox);
  assert.ok(partBox.y + partBox.height <= coverBox.y + 1);
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

test("felt_split: click #splitBtn-1 after K♥ + K♠, then mid-shoe NEW SHOE", async () => {
  buildDist();
  const builtJs = readFileSync(join(dist, "boot.js"), "utf8");
  assert.equal(builtJs.includes("#splitBtn-1"), true);
  assert.equal(builtJs.includes("/commands/split-hand"), true);
  assert.equal(builtJs.includes("es3"), false);

  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;

    await page.locator('[data-seat="1"] .seat-round').dblclick();
    await assertHeroSelected(page);
    assert.deepEqual(await readHistory(page), []);
    assert.equal(await page.locator("#splitBtn-1").count(), 0);

    await page.getByRole("button", { name: "NEW SHOE" }).click();
    await page.locator('#app[data-screen="felt_new_shoe"]').waitFor();
    await assertHeroSelected(page);
    assert.deepEqual((await readHistory(page)).map((event) => event.type), ["shoe_started"]);

    await clickSeat(page, "1");
    await page.locator('#cardsGrid button[data-rank="K"]').click();
    await page.locator('#hand-1 .mini[data-suit="spades"] .suit.top-right').waitFor();
    await page.locator('#suitGrid button[data-suit="hearts"]').click();
    await page.locator('#hand-1 .mini[data-suit="hearts"] .suit.top-right').waitFor();

    await clickSeat(page, "1");
    await page.locator('#cardsGrid button[data-rank="K"]').click();
    await page.locator('#hand-1 .mini[data-suit="spades"] .suit.top-right').waitFor();
    assert.equal(await text(page, '[data-seat="1"] .hand-total'), "Total: 20");
    assert.equal(
      await page.locator('[data-seat="1"] .hand-total').evaluate((element) => getComputedStyle(element).color),
      "rgb(34, 197, 94)",
    );
    assert.equal(await page.locator('[data-seat="1"] .hand-total').count(), 1);
    const cards = page.locator("#hand-1 .mini");
    assert.equal(await cards.count(), 2);
    await assertFace(cards.nth(0), "K", "♥");
    assert.equal(await cards.nth(0).getAttribute("data-suit"), "hearts");
    await assertFace(cards.nth(1), "K", "♠");
    assert.equal(await cards.nth(1).getAttribute("data-suit"), "spades");
    assert.equal(
      await cards.nth(0).evaluate((element) => getComputedStyle(element).color),
      "rgb(220, 38, 38)",
    );
    assert.equal(
      await cards.nth(1).evaluate((element) => getComputedStyle(element).color),
      "rgb(0, 0, 0)",
    );
    assert.equal(await cards.nth(0).locator(".corner.top-left").isVisible(), true);
    assert.equal(await cards.nth(0).locator(".suit.top-right").isVisible(), true);
    await assertClearOf(cards.nth(0).locator(".corner.top-left"), cards.nth(1));
    await assertClearOf(cards.nth(0).locator(".suit.top-right"), cards.nth(1));

    const split = page.locator("#splitBtn-1");
    assert.equal(await split.count(), 1);
    assert.equal(await split.isVisible(), true);
    assert.equal(await split.isEnabled(), true);
    assert.equal((await split.innerText()).trim(), "SPLIT");
    assert.equal(
      await split.evaluate((element) => getComputedStyle(element).backgroundColor),
      "rgb(234, 88, 12)",
    );
    assert.equal(await page.locator(".split-btn").count(), 1);
    assert.equal(await page.locator("#splitBtn-2").count(), 0);
    const before = await infoBar(page);
    assert.deepEqual(before, {
      p: "P: 0.48%",
      d: "D: 7.96",
      ra: "RA: -0.87",
      hilo: "Hi-Lo: -2 / -0.25",
      apc: "APC: -0.75",
      zen: "Zen: -0.50",
      omega: "Omega II: -0.50",
      ace: "Ace: 0.02",
    });
    assert.equal((await rankLabel(page, "K").textContent())?.trim(), "30");

    await split.click();
    await page.locator('#app[data-screen="felt_split"]').waitFor();
    await page.locator('#hand-1A .mini[data-suit="hearts"] .corner.top-left').waitFor();

    const history = await readHistory(page);
    assert.deepEqual(
      history.map((event) => event.type),
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
    assert.equal(history[1]?.rank, "K");
    assert.equal(history[1]?.seat, "1");
    assert.equal(history[2]?.suit, "spades");
    assert.equal(history[3]?.suit, "hearts");
    assert.equal(history[3]?.seat, "1");
    assert.equal(history[4]?.rank, "K");
    assert.equal(history[4]?.seat, "1");
    assert.equal(history[5]?.suit, "spades");
    assert.equal(history[6]?.type, "hand_split");
    assert.equal(history[6]?.seat, "1");
    assert.equal(history[6] !== undefined && "rank" in history[6], false);
    assert.equal(history[6] !== undefined && "suit" in history[6], false);

    const ace = page.locator("#hand-1A .mini");
    const bee = page.locator("#hand-1B .mini");
    assert.equal(await ace.count(), 1);
    await assertFace(ace, "K", "♥");
    assert.equal(await ace.getAttribute("data-rank"), "K");
    assert.equal(await ace.getAttribute("data-suit"), "hearts");
    assert.equal(await bee.count(), 1);
    await assertFace(bee, "K", "♠");
    assert.equal(await bee.getAttribute("data-rank"), "K");
    assert.equal(await bee.getAttribute("data-suit"), "spades");
    assert.equal((await page.locator("#split-1 .split-label").nth(0).innerText()).trim(), "A");
    assert.equal((await page.locator("#split-1 .split-label").nth(1).innerText()).trim(), "B");
    const totals = page.locator("#split-1 .hand-total");
    assert.equal(await totals.count(), 2);
    for (const index of [0, 1]) {
      assert.equal((await totals.nth(index).innerText()).trim(), "Total: 10");
      assert.equal(
        await totals.nth(index).evaluate((element) => getComputedStyle(element).color),
        "rgb(255, 212, 63)",
      );
    }
    const base = page.locator("#hand-1");
    assert.equal(await base.locator(".mini").count(), 0);
    assert.equal(await base.isVisible(), false);
    assert.equal(await page.locator("#splitBtn-1").count(), 0);
    assert.equal(await page.getByRole("button", { name: "SPLIT" }).count(), 0);
    const pileA = page.locator("#split-1 .split-hand:nth-child(1)");
    const pileB = page.locator("#split-1 .split-hand:nth-child(2)");
    assert.equal(await pileA.evaluate((element) => element.classList.contains("active")), true);
    assert.equal(await pileB.evaluate((element) => element.classList.contains("active")), false);
    assert.equal(await page.locator(".split-hand.active").count(), 1);
    assert.equal(
      await pileA.evaluate((element) => getComputedStyle(element).borderTopColor),
      "rgb(34, 197, 94)",
    );
    assert.notEqual(
      await pileA.evaluate((element) => getComputedStyle(element).boxShadow),
      "none",
    );
    assert.equal(
      await pileB.evaluate((element) => getComputedStyle(element).borderTopColor),
      "rgba(0, 0, 0, 0)",
    );
    assert.equal(
      await ace.evaluate((element) => getComputedStyle(element).color),
      "rgb(220, 38, 38)",
    );
    assert.equal(
      await bee.evaluate((element) => getComputedStyle(element).color),
      "rgb(0, 0, 0)",
    );
    assert.deepEqual(await infoBar(page), before);
    for (const rank of RANKS) {
      assert.equal(
        (await rankLabel(page, rank).textContent())?.trim(),
        rank === "K" ? "30" : "32",
        rank,
      );
    }
    assert.equal(await hoverSuit(page, "spades"), "♠: 103");
    assert.equal(await hoverSuit(page, "clubs"), "♣: 104");
    assert.equal(await hoverSuit(page, "hearts"), "♥: 103");
    assert.equal(await hoverSuit(page, "diamonds"), "♦: 104");
    await assertHeroSelected(page);

    await page.locator('#cardsGrid button[data-rank="5"]').click();
    await page.locator('#hand-1A .mini[data-rank="5"][data-suit="spades"]').waitFor();
    const piled = page.locator("#hand-1A .mini");
    assert.equal(await piled.count(), 2);
    await assertFace(piled.nth(0), "K", "♥");
    assert.equal(await piled.nth(0).getAttribute("data-suit"), "hearts");
    await assertFace(piled.nth(1), "5", "♠");
    assert.equal(await piled.nth(1).getAttribute("data-rank"), "5");
    assert.equal(await piled.nth(1).getAttribute("data-suit"), "spades");
    assert.equal(
      await piled.nth(0).evaluate((element) => getComputedStyle(element).color),
      "rgb(220, 38, 38)",
    );
    assert.equal(
      await piled.nth(1).evaluate((element) => getComputedStyle(element).color),
      "rgb(0, 0, 0)",
    );
    assert.equal(await piled.nth(0).locator(".corner.top-left").isVisible(), true);
    assert.equal(await piled.nth(0).locator(".suit.top-right").isVisible(), true);
    await assertClearOf(piled.nth(0).locator(".corner.top-left"), piled.nth(1));
    await assertClearOf(piled.nth(0).locator(".suit.top-right"), piled.nth(1));
    const pileTotals = page.locator("#split-1 .hand-total");
    assert.equal((await pileTotals.nth(0).innerText()).trim(), "Total: 15");
    assert.equal(
      await pileTotals.nth(0).evaluate((element) => getComputedStyle(element).color),
      "rgb(255, 212, 63)",
    );
    assert.equal((await pileTotals.nth(1).innerText()).trim(), "Total: 10");
    await assertFace(page.locator("#hand-1B .mini"), "K", "♠");
    assert.equal(await page.locator("#hand-1B .mini").count(), 1);
    assert.equal(await base.locator(".mini").count(), 0);
    assert.equal(await base.isVisible(), false);
    assert.equal(await pileA.evaluate((element) => element.classList.contains("active")), false);
    assert.equal(await page.locator(".split-hand.active").count(), 0);
    assert.equal(
      await page.locator('[data-seat="1"] .seat-round').evaluate((element) =>
        element.classList.contains("active"),
      ),
      false,
    );
    assert.equal(
      await page.locator('[data-seat="2"] .seat-round').evaluate((element) =>
        element.classList.contains("active"),
      ),
      true,
    );
    assert.equal(await page.locator(".seat-round.active").count(), 1);
    assert.equal(
      await page.locator('[data-seat="1"] .seat-round').evaluate((element) =>
        element.classList.contains("your-seat"),
      ),
      true,
    );

    const dealt = await readHistory(page);
    assert.deepEqual(dealt.slice(-2).map((event) => event.type), [
      "card_observed",
      "card_suit_set",
    ]);
    assert.equal(dealt.at(-2)?.seat, "1A");
    assert.equal(dealt.at(-2)?.rank, "5");
    assert.equal(dealt.at(-1)?.seat, "1A");
    assert.equal(dealt.at(-1)?.suit, "spades");
    assert.deepEqual(await infoBar(page), {
      p: "P: 0.72%",
      d: "D: 7.94",
      ra: "RA: -0.87",
      hilo: "Hi-Lo: -1 / -0.13",
      apc: "APC: -0.38",
      zen: "Zen: -0.25",
      omega: "Omega II: -0.25",
      ace: "Ace: 0.03",
    });
    for (const rank of RANKS) {
      const count = rank === "K" ? "30" : rank === "5" ? "31" : "32";
      assert.equal((await rankLabel(page, rank).textContent())?.trim(), count, rank);
    }
    assert.equal(await hoverSuit(page, "spades"), "♠: 102");
    assert.equal(await hoverSuit(page, "clubs"), "♣: 104");
    assert.equal(await hoverSuit(page, "hearts"), "♥: 103");
    assert.equal(await hoverSuit(page, "diamonds"), "♦: 104");

    const seats = await page.locator("[data-seat]").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-seat")),
    );
    assert.deepEqual(seats, ["D", "7", "6", "5", "4", "3", "2", "1"]);
    for (const seat of ["D", "7", "6", "5", "4", "3", "2"]) {
      assert.equal((await page.locator(`#hand-${seat}`).innerText()).trim(), "");
    }

    await clickSeat(page, "2");
    const seat2 = page.locator('[data-seat="2"] .seat-round');
    assert.equal(await seat2.evaluate((element) => element.classList.contains("active")), true);
    assert.equal(await seat2.evaluate((element) => element.classList.contains("your-seat")), false);
    assert.match(
      await seat2.evaluate((element) => getComputedStyle(element).boxShadow),
      /rgb\(0,\s*255,\s*136\)/,
    );
    assert.equal((await page.locator("#hand-2").innerText()).trim(), "");

    await page.getByRole("button", { name: "NEW SHOE" }).click();
    await page.locator('#app[data-screen="felt_new_shoe"]').waitFor();
    assert.deepEqual(opened.confirms, [
      "Start fresh 8-deck shoe?",
      "Start fresh 8-deck shoe?",
    ]);

    const reset = await readHistory(page);
    assert.deepEqual(
      reset.map((event) => event.type),
      [
        "shoe_started",
        "card_observed",
        "card_suit_set",
        "card_suit_set",
        "card_observed",
        "card_suit_set",
        "hand_split",
        "card_observed",
        "card_suit_set",
        "hand_completed",
        "shoe_started",
      ],
    );
    assert.equal(reset.at(-1)?.decks, 8);

    assert.deepEqual(
      await page.locator("[data-seat]").evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-seat")),
      ),
      ["D", "7", "6", "5", "4", "3", "2", "1"],
    );
    for (const seat of ["D", "7", "6", "5", "4", "3", "2", "1"]) {
      const hand = page.locator(`#hand-${seat}`);
      assert.equal(await hand.count(), 1);
      assert.equal(await hand.isVisible(), true);
      assert.equal((await hand.innerText()).trim(), "");
    }
    assert.equal(await page.locator(".hand-total").count(), 0);
    assert.equal(await page.locator(".split-container").count(), 0);
    assert.equal(await page.locator(".split-hand").count(), 0);
    assert.equal(await page.locator(".split-hand.active").count(), 0);
    assert.equal(await page.locator(".mini").count(), 0);
    assert.equal(await page.locator("#splitBtn-1").count(), 0);
    assert.equal(await page.getByRole("button", { name: "SPLIT" }).count(), 0);
    await assertHeroSelected(page);
    assert.equal(await page.locator(".seat-round.active").count(), 1);
    assert.equal(
      await page.locator('[data-seat="2"] .seat-round').evaluate((element) =>
        element.classList.contains("active"),
      ),
      false,
    );

    assert.deepEqual(await infoBar(page), {
      p: "P: 0.00%",
      d: "D: 8.00",
      ra: "RA: -0.88",
      hilo: "Hi-Lo: 0 / 0.00",
      apc: "APC: 0.00",
      zen: "Zen: 0.00",
      omega: "Omega II: 0.00",
      ace: "Ace: 0.00",
    });
    const ra = page.locator("#ra");
    assert.equal(await ra.getAttribute("class"), "negative");
    assert.equal(await ra.getAttribute("data-value"), "-0.88");
    assert.equal(
      await ra.evaluate((element) => getComputedStyle(element).color),
      "rgb(239, 68, 68)",
    );
    for (const rank of RANKS) {
      assert.equal((await rankLabel(page, rank).textContent())?.trim(), "32", rank);
    }
    for (const suit of SUITS) {
      assert.equal(await hoverSuit(page, suit.suit), `${suit.symbol}: 104`);
    }
  } finally {
    await close(server, browser);
  }
});

test("felt_split: SPLIT stays hidden for 10+K", async () => {
  buildDist();
  const { server, origin } = await startServer();
  let browser: Browser | undefined;
  try {
    const opened = await openLive(origin);
    browser = opened.browser;
    const page = opened.page;

    await page.locator('[data-seat="1"] .seat-round').dblclick();
    await assertHeroSelected(page);
    await page.getByRole("button", { name: "NEW SHOE" }).click();
    await page.locator('#app[data-screen="felt_new_shoe"]').waitFor();

    await clickSeat(page, "1");
    await page.locator('#cardsGrid button[data-rank="10"]').click();
    await page.locator('#hand-1 .mini[data-rank="10"] .corner.top-left').waitFor();
    assert.equal(
      (await page.locator('#hand-1 .mini[data-rank="10"] .corner.top-left').innerText()).trim(),
      "T",
    );
    await clickSeat(page, "1");
    await page.locator('#cardsGrid button[data-rank="K"]').click();
    await page.locator('#hand-1 .mini[data-rank="K"] .suit.top-right').waitFor();

    assert.equal(await text(page, '[data-seat="1"] .hand-total'), "Total: 20");
    assert.equal(
      await page.locator('[data-seat="1"] .hand-total').evaluate((element) => getComputedStyle(element).color),
      "rgb(34, 197, 94)",
    );
    const cards = page.locator("#hand-1 .mini");
    assert.equal(await cards.count(), 2);
    assert.equal(await cards.nth(0).getAttribute("data-rank"), "10");
    assert.equal(await cards.nth(1).getAttribute("data-rank"), "K");
    assert.equal(await page.locator("#splitBtn-1").count(), 0);
    assert.equal(await page.locator(".split-btn").count(), 0);
    assert.equal(await page.getByRole("button", { name: "SPLIT" }).count(), 0);
    assert.equal(await page.locator("#split-1").count(), 0);
    assert.equal(
      (await readHistory(page)).some((event) => event.type === "hand_split"),
      false,
    );
    assert.deepEqual(
      (await readHistory(page)).map((event) => event.type),
      ["shoe_started", "card_observed", "card_suit_set", "card_observed", "card_suit_set"],
    );
  } finally {
    await close(server, browser);
  }
});
