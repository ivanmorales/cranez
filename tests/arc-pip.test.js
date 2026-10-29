// Simulates scripts/arc-pip-on-blur.uc.js in a Zen window playing a video.
// Run: node tests/arc-pip.test.js
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = fs.readFileSync(path.join(__dirname, "..", "scripts", "arc-pip-on-blur.uc.js"), "utf8");

// occlusion: false = this Zen has no occlusion API (window.isFullyOccluded missing).
function setup({ sound = true, occlusion = true } = {}) {
  const on = {};
  const timers = new Map();
  let nextTimer = 1;
  const toggles = [];
  const closed = [];
  const errors = [];
  const players = [];

  const PiP = {
    weakWinToBrowser: new WeakMap(),
    weakPipToWin: new WeakMap(),
    isOriginatingBrowser: b => players.some(w => !w.closed && PiP.weakWinToBrowser.get(w) === b),
    closeSinglePipWindow: ({ actorRef }) => {
      const w = PiP.weakPipToWin.get(actorRef);
      w.closed = true;
      closed.push(w);
    },
  };
  const frame = name => ({
    name,
    currentWindowGlobal: { getActor: () => ({ sendAsyncMessage: msg => toggles.push([name, msg]) }) },
  });
  const top = frame("top");
  top.getAllBrowsingContextsInSubtree = () => [top];
  const browser = { browsingContext: top };
  const attrs = new Set(sound ? ["soundplaying"] : []);
  const tab = { linkedBrowser: browser, hasAttribute: a => attrs.has(a) };

  const window = {
    STATE_MINIMIZED: 2,
    STATE_NORMAL: 3,
    windowState: 3,
    gBrowserInit: { delayedStartupFinished: true },
    PictureInPicture: PiP,
    addEventListener: (type, fn) => { (on[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { on[type] = (on[type] || []).filter(f => f !== fn); },
  };
  if (occlusion) window.isFullyOccluded = false;
  const prefs = { "media.videocontrols.picture-in-picture.enabled": true };
  const sandbox = {
    window,
    gBrowser: { selectedTab: tab, get selectedBrowser() { return this.selectedTab.linkedBrowser; } },
    Services: {
      prefs: {
        getBoolPref: (k, d) => (k in prefs ? prefs[k] : d),
        getIntPref: (_k, d) => d,
      },
      obs: { addObserver() {}, removeObserver() {} },
      focus: { activeWindow: null },
      wm: { getEnumerator: () => players.filter(w => !w.closed) },
    },
    ChromeUtils: { nondeterministicGetWeakMapKeys: () => players.map(w => w.actor) },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => { timers.delete(id); },
    console: { info() {}, log() {}, warn() {}, error: (...a) => errors.push(a.join(" ")) },
  };
  new Function(...Object.keys(sandbox), SRC)(...Object.values(sandbox));

  const fire = type => (on[type] || []).slice().forEach(fn => fn({ type }));
  const runTimers = () => {
    for (let i = 0; i < 5 && timers.size; i++) {
      const due = [...timers.entries()];
      timers.clear();
      due.forEach(([, t]) => t.fn());
    }
  };
  const hide = () => { window.isFullyOccluded = true; fire("occlusionstatechange"); };
  const show = () => { window.isFullyOccluded = false; fire("occlusionstatechange"); };
  // What Firefox does when the AutoToggle message finds a video: a player window opens.
  const openPlayer = () => {
    const actor = {};
    const w = { closed: false, actor };
    PiP.weakWinToBrowser.set(w, browser);
    PiP.weakPipToWin.set(actor, w);
    players.push(w);
    return w;
  };
  return { window, sandbox, fire, runTimers, hide, show, openPlayer, toggles, closed, errors, tab };
}

const cases = [
  ["focusing an app on another screen leaves the video in the browser", () => {
    const t = setup();
    t.fire("deactivate");
    t.runTimers();
    assert.deepStrictEqual(t.toggles, []);
  }],
  ["Zen hidden (another macOS Space, or covered) pops the video out", () => {
    const t = setup();
    t.fire("deactivate");
    t.hide();
    t.runTimers();
    assert.deepStrictEqual(t.toggles[0], ["top", "PictureInPicture:AutoToggle"]);
  }],
  ["hidden while Zen still has focus (e.g. Space switch via keyboard) still pops out", () => {
    const t = setup();
    t.sandbox.Services.focus.activeWindow = t.window;
    t.hide();
    t.runTimers();
    assert.strictEqual(t.toggles.length, 1);
  }],
  ["hidden and back within the delay does nothing (flicker guard)", () => {
    const t = setup();
    t.hide();
    t.show();
    t.runTimers();
    assert.deepStrictEqual(t.toggles, []);
  }],
  ["minimizing pops the video out", () => {
    const t = setup();
    t.window.windowState = t.window.STATE_MINIMIZED;
    t.fire("sizemodechange");
    t.runTimers();
    assert.strictEqual(t.toggles.length, 1);
  }],
  ["coming back to the same tab closes the player we opened", () => {
    const t = setup();
    t.hide();
    t.runTimers();
    const player = t.openPlayer();
    t.show();
    assert.deepStrictEqual(t.closed, [player]);
  }],
  ["a player the user opened before stays open on return", () => {
    const t = setup();
    const theirs = t.openPlayer();
    t.hide();
    t.runTimers();
    assert.deepStrictEqual(t.toggles, [], "never toggles a video already in PiP (that would close it)");
    t.show();
    assert.deepStrictEqual(t.closed, []);
    assert.ok(!theirs.closed);
  }],
  ["silent tab doesn't pop out (arcpip.require_audio)", () => {
    const t = setup({ sound: false });
    t.hide();
    t.runTimers();
    assert.deepStrictEqual(t.toggles, []);
  }],
  ["repeated hidden events send one toggle", () => {
    const t = setup();
    t.hide();
    t.hide();
    t.runTimers();
    t.fire("occlusionstatechange");
    t.runTimers();
    assert.strictEqual(t.toggles.length, 1);
  }],
  ["no occlusion API: falls back to popping out on app switch, and says so", () => {
    const t = setup({ occlusion: false });
    t.fire("deactivate");
    t.runTimers();
    assert.strictEqual(t.toggles.length, 1);
    assert.ok(t.errors.some(e => e.includes("[arc-pip]")), "logs the fallback with the [arc-pip] prefix");
  }],
  ["no occlusion API: focus moving to another Zen window doesn't pop out", () => {
    const t = setup({ occlusion: false });
    t.fire("deactivate");
    t.sandbox.Services.focus.activeWindow = {};
    t.runTimers();
    assert.deepStrictEqual(t.toggles, []);
  }],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
console.log(`arc-pip: ${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
