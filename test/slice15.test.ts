import assert from "node:assert/strict";
import test from "node:test";
import { handleHttp, type HttpRequest, type HttpResponse } from "../src/http/handle.ts";
import { createNewShoeShell } from "../src/ui/new-shoe-shell.ts";
import { createInMemoryEventStore } from "../src/write/in-memory-store.ts";

/**
 * Slice 15 shell focus. UI only: arrows, Space and right-click append nothing.
 * Expectations are the felt_keyboard rulings (Kristoffer 2026-11-12 and
 * 2026-11-24), not the pre-slice dealing walk.
 */

function wired() {
  const store = createInMemoryEventStore();
  const calls: HttpRequest[] = [];
  const handle = (request: HttpRequest): HttpResponse => {
    calls.push(request);
    return handleHttp(store, request);
  };
  const shell = createNewShoeShell(handle, () => true);
  shell.pressNewShoe();
  return { shell, calls };
}

function rank(shell: ReturnType<typeof wired>["shell"], value: string): void {
  assert.equal(shell.pressRank(value).rejected, false);
  shell.advanceFocus();
}

test("GWT arrows wrap and a left arrow from A goes to B or the next seat", () => {
  const { shell, calls } = wired();
  const left = [shell.focusKey()];
  for (let step = 0; step < 8; step += 1) {
    shell.pressArrow("left");
    left.push(shell.focusKey());
  }
  assert.deepEqual(left, ["1", "2", "3", "4", "5", "6", "7", "D", "1"]);
  const right = [shell.focusKey()];
  for (let step = 0; step < 8; step += 1) {
    shell.pressArrow("right");
    right.push(shell.focusKey());
  }
  assert.deepEqual(right, ["1", "D", "7", "6", "5", "4", "3", "2", "1"]);

  shell.pressSeat("1");
  rank(shell, "9");
  shell.pressSeat("1");
  rank(shell, "9");
  assert.equal(shell.pressSplit("1").rejected, false);
  assert.equal(shell.focusKey(), "1A");
  shell.pressArrow("left");
  assert.equal(shell.focusKey(), "1B");
  shell.pressArrow("right");
  assert.equal(shell.focusKey(), "1A");
  shell.pressArrow("left");
  assert.equal(shell.pressWithdraw().rejected, false);
  shell.pressSeat("1");
  assert.equal(shell.focusKey(), "1A");
  shell.pressArrow("left");
  assert.equal(shell.focusKey(), "2");
  assert.equal(calls.some((call) => call.path.includes("disable")), false);
});

test("GWT auto-advance uses the due pile and skips a both-done split seat", () => {
  const { shell } = wired();
  shell.pressSeat("2");
  rank(shell, "8");
  shell.pressSeat("2");
  rank(shell, "8");
  assert.equal(shell.pressSplit("2").rejected, false);
  shell.pressSeat("1");
  rank(shell, "5");
  assert.equal(shell.focusKey(), "2A");

  rank(shell, "3");
  assert.equal(shell.focusKey(), "2B");
  shell.pressSeat("2");
  assert.equal(shell.focusKey(), "2A");
  rank(shell, "K");
  assert.equal(shell.focusKey(), "2B");

  shell.pressSeat("1");
  rank(shell, "4");
  assert.equal(shell.focusKey(), "2B");

  rank(shell, "3");
  shell.pressSeat("2");
  rank(shell, "K");
  shell.pressSeat("1");
  assert.equal(shell.pressWithdraw().rejected, false);
  assert.equal(shell.pressWithdraw().rejected, false);
  rank(shell, "2");
  assert.equal(shell.focusKey(), "3");
});

test("GWT 21 and bust advance, and Backspace returns only that focus", () => {
  const { shell } = wired();
  rank(shell, "K");
  shell.pressSeat("1");
  rank(shell, "6");
  shell.pressSeat("1");
  rank(shell, "9");
  assert.equal(shell.focusKey(), "2");
  assert.equal(shell.pressWithdraw().rejected, false);
  assert.equal(shell.focusKey(), "1");

  shell.pressSeat("3");
  rank(shell, "4");
  assert.equal(shell.focusKey(), "4");
  assert.equal(shell.pressWithdraw().rejected, false);
  assert.equal(shell.focusKey(), "4");
});

test("GWT Space and right-click toggle without events, and a disabled click walks left", () => {
  const { shell, calls } = wired();
  const before = calls.length;
  shell.pressSpace();
  assert.equal(shell.focusKey(), "2");
  assert.match(shell.html(), /data-seat="1"><div class="seat-round disabled/);
  shell.pressToggleSeat("D");
  assert.equal(/data-seat="D"><div class="seat-round[^"]*disabled/.test(shell.html()), false);
  shell.pressToggleSeat("2");
  assert.equal(shell.focusKey(), "2");
  assert.match(shell.html(), /data-seat="2"><div class="seat-round disabled active/);
  shell.pressSpace();
  assert.equal(shell.focusKey(), "2");
  assert.equal(shell.html().includes('data-seat="2"><div class="seat-round disabled'), false);

  shell.pressToggleSeat("4");
  shell.pressToggleSeat("5");
  shell.pressSeat("4");
  assert.equal(shell.focusKey(), "6");
  shell.pressToggleSeat("7");
  shell.pressSeat("7");
  assert.equal(shell.focusKey(), "D");
  // Seat 1 is still off, so ArrowLeft from the dealer skips it.
  shell.pressArrow("left");
  assert.equal(shell.focusKey(), "2");
  shell.pressSeat("6");
  shell.pressArrow("left");
  assert.equal(shell.focusKey(), "D");
  shell.pressSeat("2");
  shell.pressArrow("right");
  assert.notEqual(shell.focusKey(), "4");
  assert.equal(calls.length, before);

  shell.pressNextHand();
  assert.equal(shell.html().includes("seat-round disabled"), false);
  shell.pressToggleSeat("3");
  assert.match(shell.html(), /data-seat="3"><div class="seat-round disabled/);
  shell.pressNewShoe();
  assert.equal(shell.html().includes("seat-round disabled"), false);
});

test("GWT an arrow enters a split seat on the nearest pile, with the empty and done exceptions", () => {
  const { shell } = wired();
  shell.pressSeat("2");
  rank(shell, "8");
  shell.pressSeat("2");
  rank(shell, "8");
  assert.equal(shell.pressSplit("2").rejected, false);
  shell.pressSeat("1");
  shell.pressArrow("left");
  assert.equal(shell.focusKey(), "2A");
  shell.pressSeat("3");
  shell.pressArrow("right");
  assert.equal(shell.focusKey(), "2B");

  shell.pressSeat("2");
  assert.equal(shell.focusKey(), "2A");
  assert.equal(shell.pressWithdraw().rejected, false);
  shell.pressSeat("3");
  shell.pressArrow("right");
  assert.equal(shell.focusKey(), "2B");
  shell.pressSeat("1");
  shell.pressArrow("left");
  assert.equal(shell.focusKey(), "2B");

  shell.pressSeat("3");
  shell.pressArrow("right");
  rank(shell, "K");
  shell.pressSeat("3");
  shell.pressArrow("right");
  rank(shell, "3");
  shell.pressSeat("1");
  shell.pressArrow("left");
  assert.equal(shell.focusKey(), "2A");
  shell.pressSeat("3");
  shell.pressArrow("right");
  assert.equal(shell.focusKey(), "2B");
});

test("GWT the dealing round skips disabled seats and the dealer after the last active seat", () => {
  const { shell } = wired();
  shell.pressToggleSeat("7");
  shell.pressToggleSeat("3");
  const path = [shell.focusKey()];
  for (let step = 0; step < 11; step += 1) {
    rank(shell, "5");
    path.push(shell.focusKey());
  }
  assert.deepEqual(path, ["1", "2", "4", "5", "6", "D", "1", "2", "4", "5", "6", "1"]);
  const html = shell.html();
  for (const seat of ["3", "7"]) {
    assert.equal(html.includes(`id="hand-${seat}">`), true);
    assert.equal((html.split(`id="hand-${seat}"`)[1] ?? "").startsWith("></div>"), true);
  }
  assert.equal((html.match(/id="hand-D"/g) ?? []).length, 1);
});
