// Simulates scripts/pip-swipe.uc.js outside Zen: a fake 3-monitor desktop, a fake clock,
// and scripted Magic Mouse swipes (touch phase + macOS momentum tail).
// Run: node tests/pip-swipe.test.js
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = fs.readFileSync(path.join(__dirname, "..", "scripts", "pip-swipe.uc.js"), "utf8");

const MENU_BAR = 25;
const WIN_W = 480;
const WIN_H = 270;
const MARGIN = 16;

// [1] 1512 wide, [2] 2560 wide and taller (sits 200px higher), [3] 1920 wide, left to right.
const SCREENS = [
  { x: 0, y: 0, w: 1512, h: 982 },
  { x: 1512, y: -200, w: 2560, h: 1440 },
  { x: 4072, y: 0, w: 1920, h: 1080 },
].map(r => ({
  r,
  GetRectDisplayPix(l, t, w, h) {
    l.value = r.x; t.value = r.y; w.value = r.w; h.value = r.h;
  },
  GetAvailRectDisplayPix(l, t, w, h) {
    l.value = r.x; t.value = r.y + MENU_BAR; w.value = r.w; h.value = r.h - MENU_BAR;
  },
}));

function setup() {
  const screenManager = {
    primaryScreen: SCREENS[0],
    screenForRect(x, y) {
      return SCREENS.find(s => x >= s.r.x && x < s.r.x + s.r.w && y >= s.r.y && y < s.r.y + s.r.h) || SCREENS[0];
    },
  };

  let now = 0;
  let timers = [];
  let rafs = [];
  let nextId = 1;
  const advance = ms => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 8);
      const due = timers.filter(t => t.at <= now);
      timers = timers.filter(t => t.at > now);
      due.forEach(t => t.fn());
      const frames = rafs;
      rafs = [];
      frames.forEach(r => r.fn(now));
    }
  };

  const offscreen = [];
  const visible = (x, y) =>
    SCREENS.some(s => x >= s.r.x && x < s.r.x + s.r.w && y >= s.r.y + MENU_BAR && y < s.r.y + s.r.h);
  const checkVisible = (x, y) => {
    for (const px of [x, x + WIN_W / 2, x + WIN_W - 1]) {
      for (const py of [y, y + WIN_H / 2, y + WIN_H - 1]) {
        if (!visible(px, py)) {
          offscreen.push([x, y]);
          return;
        }
      }
    }
  };

  let wheelHandler = null;
  const win = {
    devicePixelRatio: 2,
    desktopToDeviceScale: 2,
    screenX: 0,
    screenY: 0,
    outerWidth: WIN_W,
    outerHeight: WIN_H,
    windowState: 1,
    STATE_FULLSCREEN: 4,
    moveTo(x, y) {
      this.screenX = x;
      this.screenY = y;
      checkVisible(x, y);
    },
    addEventListener(type, fn) {
      if (type === "wheel") wheelHandler = fn;
    },
  };

  const logs = [];
  const sandbox = {
    window: win,
    Services: { prefs: { getBoolPref: (p, d) => (p === "pipswipe.debug" ? true : d), getIntPref: (p, d) => d } },
    Cc: { "@mozilla.org/gfx/screenmanager;1": { getService: () => screenManager } },
    Ci: { nsIScreenManager: {} },
    ChromeUtils: { importESModule() { throw new Error("no ctypes outside Zen"); } },
    WheelEvent: { DOM_DELTA_PIXEL: 0 },
    performance: { now: () => now },
    requestAnimationFrame: fn => { const id = nextId++; rafs.push({ id, fn }); return id; },
    cancelAnimationFrame: id => { rafs = rafs.filter(r => r.id !== id); },
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ id, at: now + ms, fn }); return id; },
    clearTimeout: id => { timers = timers.filter(t => t.id !== id); },
    console: { info() {}, error() {}, log: (...a) => logs.push(a) },
    globalThis: {},
  };
  new Function(...Object.keys(sandbox), SRC)(...Object.values(sandbox));

  const wheel = (deltaX, deltaY = 0) => {
    wheelHandler({ deltaMode: 0, deltaX, deltaY, preventDefault() {}, stopPropagation() {} });
    advance(8);
  };
  // Natural scrolling: finger LEFT => positive deltaX, finger UP => positive deltaY.
  const fling = (dx, dy, touch = 6) => {
    for (let i = 0; i < touch; i++) wheel(dx, dy);
    let fx = dx;
    let fy = dy;
    for (let i = 0; i < 40; i++) {
      fx *= 0.9;
      fy *= 0.9;
      wheel(fx, fy);
    }
    advance(600);
  };
  const release = () => {
    const r = logs.filter(a => String(a[1]).startsWith("release")).pop();
    return r && r[2].target;
  };

  return { win, wheel, fling, advance, offscreen, release, logs, place: (x, y) => { win.screenX = x; win.screenY = y; } };
}

const s1 = SCREENS[0].r;
const s2 = SCREENS[1].r;
const s3 = SCREENS[2].r;
const leftEdge = s => s.x + MARGIN;
const rightEdge = s => s.x + s.w - WIN_W - MARGIN;
const topEdge = s => s.y + MENU_BAR + MARGIN;
const bottomEdge = s => s.y + s.h - WIN_H - MARGIN;

const cases = [
  ["fling left mid-screen stops at the left edge, no hop", t => {
    t.place(700, 400);
    t.fling(22, 0);
    assert.deepStrictEqual([t.win.screenX, t.win.screenY], [leftEdge(s1), 400]);
    assert.strictEqual(t.release().hop, null);
  }],
  ["fling left from screen 2's left edge hops to screen 1's right edge", t => {
    t.place(s2.x + MARGIN, 300);
    t.fling(22, 0);
    assert.deepStrictEqual([t.win.screenX, t.win.screenY], [rightEdge(s1), 300]);
    assert.strictEqual(t.release().hop, "left");
  }],
  ["fling left at the outer left edge stays put", t => {
    t.place(leftEdge(s1), 400);
    t.fling(22, 0);
    assert.deepStrictEqual([t.win.screenX, t.win.screenY], [leftEdge(s1), 400]);
  }],
  ["hard fling across screen 3 is capped at screen 3's left edge", t => {
    t.place(5000, 400);
    t.fling(40, 0);
    assert.deepStrictEqual([t.win.screenX, t.win.screenY], [leftEdge(s3), 400]);
  }],
  ["slow drag then stop stays where dropped", t => {
    t.place(700, 400);
    for (let i = 0; i < 10; i++) t.wheel(2);
    t.advance(300);
    assert.ok(Math.abs(t.win.screenX - 680) <= 2, `x=${t.win.screenX}`);
    assert.strictEqual(t.win.screenY, 400);
  }],
  ["fling near the bottom-left corner snaps into it", t => {
    t.place(300, 650);
    t.fling(22, 0);
    assert.deepStrictEqual([t.win.screenX, t.win.screenY], [leftEdge(s1), bottomEdge(s1)]);
    assert.strictEqual(t.release().snapped, true);
  }],
  ["a new swipe during the fling takes over", t => {
    t.place(700, 400);
    for (let i = 0; i < 6; i++) t.wheel(22);
    let d = 22;
    for (let i = 0; i < 8; i++) { d *= 0.9; t.wheel(d); }
    t.fling(-30, 0);
    assert.deepStrictEqual([t.win.screenX, t.win.screenY], [rightEdge(s1), 400]);
    assert.ok(t.logs.some(a => a[1] === "new swipe during coast"));
  }],
  ["long push with no recognisable momentum is pinned at the edge", t => {
    t.place(700, 400);
    for (let i = 0; i < 80; i++) t.wheel(25);
    t.advance(400);
    assert.deepStrictEqual([t.win.screenX, t.win.screenY], [leftEdge(s1), 400]);
  }],
  ["fling up stops below the menu bar", t => {
    t.place(700, 400);
    t.fling(0, 30);
    assert.deepStrictEqual([t.win.screenX, t.win.screenY], [700, topEdge(s1)]);
  }],
  ["slow drag right crosses from screen 1 onto screen 2", t => {
    t.place(900, 400);
    for (let i = 0; i < 60; i++) t.wheel(-12);
    t.advance(400);
    const cx = t.win.screenX + WIN_W / 2;
    assert.ok(cx >= s2.x && cx < s2.x + s2.w, `centre x=${cx} not on screen 2`);
  }],
  ["fling right off the outer edge of screen 3 stays on screen 3", t => {
    t.place(5000, 400);
    t.fling(-40, 0);
    assert.deepStrictEqual([t.win.screenX, t.win.screenY], [rightEdge(s3), 400]);
  }],
];

let failed = 0;
for (const [name, fn] of cases) {
  const t = setup();
  try {
    fn(t);
    assert.strictEqual(t.offscreen.length, 0, `${t.offscreen.length} frame(s) off the visible screen`);
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
console.log(`pip-swipe: ${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
