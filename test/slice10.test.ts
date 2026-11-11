import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { mountNewShoePage } from "../src/pages/new-shoe-page.ts";
import {
  SHOE_DECKS,
  projectCountsInfoBar,
} from "../src/read/counts-info-bar.ts";
import { projectRemainingComposition } from "../src/read/remaining-composition.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const SEATS = ["D", "7", "6", "5", "4", "3", "2", "1"];

/** Parked chrome. Rank and suit pads stay on the live page. */
const PARKS =
  /RoR|Wong|21\+3|Perfect Pair|sidebet|SPLIT|SURRENDER|compDep|heatSim|useKelly|Expert/i;

function readRoot(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
}

function click(node: unknown): void {
  if (
    !node ||
    typeof node !== "object" ||
    !("click" in node) ||
    typeof node.click !== "function"
  ) {
    assert.fail("expected a clickable element");
  }
  node.click();
}

function assertEmptyShoe(html: string) {
  assert.deepEqual(
    [...html.matchAll(/data-seat="([^"]+)"/g)].map((match) => match[1]),
    SEATS,
  );
  assert.match(
    html,
    /<section class="seat" data-seat="1"><div class="seat-round active your-seat">1<\/div><div class="hand" id="hand-1"><\/div><\/section>/,
  );
  for (const seat of SEATS) {
    if (seat === "1") continue;
    assert.match(
      html,
      new RegExp(
        `<section class="seat" data-seat="${seat}"><div class="seat-round">${seat}</div><div class="hand" id="hand-${seat}"><\\/div><\\/section>`,
      ),
    );
  }
  assert.equal(html.match(/active/g)?.length, 1);
  assert.equal(html.match(/your-seat/g)?.length, 1);
  assert.equal(html.includes("mini"), false);
  assert.equal(html.includes("Total:"), false);
  assert.match(html, /class="table-container"/);
  assert.match(html, /class="table" id="table"/);
  assert.match(html, /id="infoBar"/);
  assert.match(html, /id="combinedChart"/);

  const counts = projectCountsInfoBar([{ type: "shoe_started", decks: SHOE_DECKS }]);
  assert.equal(counts.acesLeft, 32);
  assert.equal(counts.decksLeft, 8);
  assert.equal(counts.ra.numeric, counts.acesLeft / (32 * counts.decksLeft) - 1);
  assert.equal(counts.ra.numeric, -0.875);
  assert.notEqual(counts.ra.numeric, counts.acesLeft / (4 * counts.decksLeft) - 1);

  const ra = html.match(/<span id="ra"[^>]*>[^<]*<\/span>/)?.[0];
  assert.ok(ra);
  assert.match(ra, /class="negative"/);
  assert.match(ra, /#ef4444/);
  assert.match(ra, /data-value="-0\.88"/);
  assert.match(ra, />RA: -0\.88</);
  for (const text of [
    counts.penetration,
    counts.decks_left,
    counts.hilo_display,
    counts.apc_tc,
    counts.zen_tc,
    counts.omega_ii_tc,
    counts.ace_tc,
    "P: 0.00%",
    "D: 8.00",
    "Hi-Lo: 0 / 0.00",
  ]) {
    assert.equal(html.includes(text), true, text);
  }

  const json = html.match(
    /<script type="application\/json" id="combinedChart-data">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(json);
  const donut = JSON.parse(json);
  const remaining = projectRemainingComposition([
    { type: "shoe_started", decks: SHOE_DECKS },
  ]);
  assert.deepEqual(donut, remaining);
  assert.deepEqual(
    remaining.remaining_by_rank.map((slice) => slice.count),
    Array(13).fill(32),
  );
  assert.deepEqual(
    remaining.remaining_by_suit.map((slice) => slice.count),
    [104, 104, 104, 104],
  );
  assert.equal(remaining.remaining_by_rank_suit.length, 52);
  assert.equal(
    remaining.remaining_by_rank_suit.every((cell) => cell.count === 8),
    true,
  );
  assert.equal(remaining.chart_host.id, "#combinedChart");
  assert.equal(PARKS.test(html), false);
}

test("repo-root index.html is the Pages entry and does not paint parked chrome", () => {
  const html = readRoot("index.html");
  assert.match(html, /<div id="app"><\/div>/);
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /src="\.\/boot\.js"/);
  assert.equal(html.includes('src="/'), false);
  assert.equal(html.includes('href="/'), false);
  assert.equal(html.includes("sortable"), false);
  assert.equal(PARKS.test(html), false);
  assert.equal(html.includes("shuffleBtn"), false);

  const css = readRoot("styles.css");
  assert.match(css, /\.topbar\b/);
  assert.match(css, /\.btn\b/);
  assert.match(css, /\.shuffle\b/);
  assert.match(css, /#infoBar\b/);
  assert.match(css, /#combinedChart\b/);
  assert.match(css, /\.seat-round\b/);
  assert.equal(PARKS.test(css), false);

  const deploy = readRoot(".github/workflows/deploy.yml");
  assert.match(deploy, /actions\/upload-pages-artifact@v3/);
  assert.match(deploy, /actions\/deploy-pages@v4/);
  assert.match(deploy, /branches: \["main"\]/);
  assert.match(deploy, /npm run build/);
  assert.match(deploy, /path: dist\b/);
  assert.equal(deploy.includes("path: '.'"), false);
  assert.equal(deploy.includes('path: "."'), false);

  const page = readRoot("src/pages/new-shoe-page.ts");
  assert.match(page, /createNewShoeShell\(/);
  assert.match(page, /handleHttp\(/);
  assert.match(page, /createInMemoryEventStore\(/);
  for (const banned of [
    "startShoe(",
    "projectFeltTable",
    "projectCountsInfoBar",
    "projectRemainingComposition",
    "runningAce",
    "COUNT_MAPS",
    "node:http",
    "createServer",
    "fetch(",
    "/commands/",
    "/views/",
    "Start fresh",
    "NEW_SHOE_CONFIRM",
  ]) {
    assert.equal(page.includes(banned), false, banned);
  }

  const boot = readRoot("src/pages/boot.ts");
  assert.match(boot, /mountNewShoePage\(\s*document/);
  assert.match(boot, /window\.confirm/);
  assert.equal(boot.includes("startShoe"), false);
  assert.equal(boot.includes("fetch("), false);
});

test("GWT click #shuffleBtn confirms, then paints the three empty-shoe views", () => {
  const { document } = parseHTML(readRoot("index.html"));
  const seen: string[] = [];
  mountNewShoePage(document, (message) => {
    seen.push(message);
    return true;
  });

  const idle = document.querySelector("#app")?.innerHTML ?? "";
  assert.match(
    idle,
    /<div class="topbar"><button class="btn shuffle" id="shuffleBtn" type="button">NEW SHOE<\/button><button class="btn next-hand" id="nextHandBtn" type="button">NEXT HAND<\/button><\/div>/,
  );
  assert.equal(idle.includes("-0.875"), false);
  assert.match(idle, />RA: -0\.88</);
  assert.match(idle, /data-tip="A: 32"/);
  assert.match(idle, /id="combinedChart-data"/);
  assert.equal(
    idle.match(/class="rank-label"[^>]*>32<\/text>/g)?.length,
    13,
  );
  assert.match(idle, /data-seat="2"/);
  assert.equal(document.querySelector("#table") !== null, true);
  assert.equal(document.querySelector("#infoBar") !== null, true);
  assert.equal(document.querySelector("#combinedChart") !== null, true);
  assert.equal(document.querySelector("#combinedChart-data") !== null, true);
  assert.equal(document.querySelector("#cardsGrid") !== null, true);
  assert.equal(document.querySelectorAll("#cardsGrid button").length, 13);
  assert.equal(document.querySelector("#suitGrid") !== null, true);
  assert.equal(document.querySelectorAll("#suitGrid button").length, 4);
  assert.equal(PARKS.test(idle), false);
  assert.deepEqual(seen, []);

  const button = document.querySelector("#shuffleBtn");
  click(button);

  assert.deepEqual(seen, ["Start fresh 8-deck shoe?"]);
  const html = document.querySelector("#app")?.innerHTML ?? "";
  assertEmptyShoe(html);
  assert.match(
    html,
    /<div class="topbar"><button class="btn shuffle" id="shuffleBtn" type="button">NEW SHOE<\/button><button class="btn next-hand" id="nextHandBtn" type="button">NEXT HAND<\/button><\/div>/,
  );
});

test("cancelled NEW SHOE does not paint the empty shoe", () => {
  const { document } = parseHTML(readRoot("index.html"));
  const seen: string[] = [];
  mountNewShoePage(document, (message) => {
    seen.push(message);
    return false;
  });
  const before = document.querySelector("#app")?.innerHTML ?? "";
  click(document.querySelector("#shuffleBtn"));
  assert.deepEqual(seen, ["Start fresh 8-deck shoe?"]);
  const html = document.querySelector("#app")?.innerHTML ?? "";
  assert.equal(html, before);
  assert.match(html, />RA: -0\.88</);
  assert.match(html, /id="shuffleBtn"/);
});

test("a second NEW SHOE still goes through confirm and repaints the empty shoe", () => {
  const { document } = parseHTML(readRoot("index.html"));
  const seen: string[] = [];
  mountNewShoePage(document, (message) => {
    seen.push(message);
    return true;
  });
  click(document.querySelector("#shuffleBtn"));
  click(document.querySelector("#shuffleBtn"));
  assert.deepEqual(seen, [
    "Start fresh 8-deck shoe?",
    "Start fresh 8-deck shoe?",
  ]);
  assertEmptyShoe(document.querySelector("#app")?.innerHTML ?? "");
});

test("built dist is the Pages artifact and the bundle drives the same NEW SHOE shell", () => {
  execFileSync(process.execPath, ["scripts/build-pages.mjs"], {
    cwd: root,
    stdio: "inherit",
  });

  const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
  assert.equal(html, readRoot("index.html"));
  assert.equal(
    readFileSync(new URL("../dist/styles.css", import.meta.url), "utf8"),
    readRoot("styles.css"),
  );

  const code = readFileSync(new URL("../dist/boot.js", import.meta.url), "utf8");
  assert.equal(code.includes("/commands/start-shoe"), true);
  assert.equal(code.includes("/views/felt"), true);
  assert.equal(code.includes("/views/counts"), true);
  assert.equal(code.includes("/views/remaining"), true);
  assert.equal(code.includes("Start fresh 8-deck shoe?"), true);
  assert.equal(code.includes("node:http"), false);
  assert.equal(code.includes("createServer"), false);

  const { document, window } = parseHTML(html);
  const seen: string[] = [];
  window.confirm = (message?: string) => {
    seen.push(String(message));
    return true;
  };
  vm.runInContext(code, vm.createContext(window));
  click(document.querySelector("#shuffleBtn"));
  assert.deepEqual(seen, ["Start fresh 8-deck shoe?"]);
  assertEmptyShoe(document.querySelector("#app")?.innerHTML ?? "");
  assert.equal(document.querySelector("#cardsGrid") !== null, true);
  assert.equal(document.querySelectorAll("#cardsGrid button").length, 13);
  assert.equal(document.querySelector("#suitGrid") !== null, true);
  assert.equal(document.querySelectorAll("#suitGrid button").length, 4);
});
