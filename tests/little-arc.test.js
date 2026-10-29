// Simulates scripts/little-arc.uc.js in a main Zen window receiving links from other apps.
// Run: node tests/little-arc.test.js
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = fs.readFileSync(path.join(__dirname, "..", "scripts", "little-arc.uc.js"), "utf8");
const OPEN_EXTERNAL = 2;
const SYSTEM = { system: true };

// zen: what gZenWorkspaces looks like in this window (undefined = no Zen spaces API).
function setup(zen) {
  const opened = [];
  const normal = [];
  const errors = [];
  const orig = { openURI: (...a) => { normal.push(a); return "tab"; } };
  const screen = {
    GetRectDisplayPix: (l, t, w, h) => { l.value = 0; t.value = 0; w.value = 1920; h.value = 1080; },
    GetAvailRectDisplayPix: (l, t, w, h) => { l.value = 0; t.value = 25; w.value = 1920; h.value = 1055; },
  };
  const window = {
    name: "",
    browserDOMWindow: orig,
    gBrowserInit: { delayedStartupFinished: true },
    gZenWorkspaces: zen,
    screenX: 100, screenY: 100, outerWidth: 1200, outerHeight: 800,
    openDialog: (...a) => { opened.push(a); },
  };
  const sandbox = {
    window,
    Services: {
      prefs: { getBoolPref: (_k, d) => d, getIntPref: (_k, d) => d },
      obs: { addObserver() {}, removeObserver() {} },
      scriptSecurityManager: { getSystemPrincipal: () => SYSTEM },
    },
    ChromeUtils: {
      generateQI: () => () => {},
      importESModule: () => { throw new Error("no ctypes here"); },
    },
    Ci: { nsIBrowserDOMWindow: { OPEN_EXTERNAL } },
    Cc: { "@mozilla.org/gfx/screenmanager;1": { getService: () => ({ primaryScreen: screen, screenForRect: () => screen }) } },
    AppConstants: { BROWSER_CHROME_URL: "chrome://browser/content/browser.xhtml" },
    console: { info() {}, log() {}, error: (...a) => errors.push(a.join(" ")) },
  };
  new Function(...Object.keys(sandbox), SRC)(...Object.values(sandbox));
  assert.notStrictEqual(window.browserDOMWindow, orig, "intercept should be installed");

  const uri = spec => ({ spec, schemeIs: s => spec.startsWith(s + ":") });
  const click = (spec, flags = OPEN_EXTERNAL) => window.browserDOMWindow.openURI(uri(spec), null, 0, flags);
  // window.arguments of the little window = openDialog's arguments after url, name, features.
  const args = () => opened[opened.length - 1].slice(3);
  return { click, opened, normal, errors, args };
}

const space = containerTabId => ({ getCurrentSpaceContainerId: () => containerTabId });

// A little window as Firefox builds it: a popup, so tab-bar-visibility.js keeps vetoing a
// custom (drawn-into) title bar with CustomTitlebar.allowedBy("non-popup", false).
// titlebar: what CustomTitlebar looks like (null = missing).
function setupLittle(titlebar = "real") {
  const sheets = [];
  const errors = [];
  const added = [];
  const attrs = {};
  const root = {
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: k => { delete attrs[k]; },
    hasAttribute: k => k in attrs,
    appendChild: el => added.push(el),
  };
  const disallowed = {};
  const CustomTitlebar = titlebar === "real" ? {
    allowedBy(condition, allow) {
      if (allow) delete disallowed[condition]; else disallowed[condition] = null;
    },
  } : titlebar;
  const moves = [];
  const window = {
    name: "arc-little-0_25_560_760_1",
    screenX: 0, screenY: 25,
    gBrowserInit: { delayedStartupFinished: true },
    CustomTitlebar,
    windowUtils: { AUTHOR_SHEET: 2, loadSheetUsingURIString: uri => sheets.push(decodeURIComponent(uri)) },
    addEventListener() {},
    moveTo: (x, y) => { moves.push([x, y]); window.screenX = x; window.screenY = y; },
  };
  const document = {
    documentElement: root,
    body: null,
    createElementNS: () => {
      const on = {};
      const el = { style: {}, attrs: {}, captured: null };
      el.addEventListener = (type, fn) => { (on[type] ||= []).push(fn); };
      el.removeEventListener = (type, fn) => { on[type] = (on[type] || []).filter(f => f !== fn); };
      el.fire = (type, e = {}) => {
        const ev = { button: 0, pointerId: 1, preventDefault() {}, ...e };
        for (const fn of [...(on[type] || [])]) fn(ev);
      };
      el.setAttribute = (k, v) => { el.attrs[k] = v; };
      el.removeAttribute = k => { delete el.attrs[k]; };
      el.setPointerCapture = id => { el.captured = id; };
      el.releasePointerCapture = () => { el.captured = null; };
      return el;
    },
  };
  const sandbox = {
    window,
    document,
    Services: {
      prefs: { getBoolPref: (_k, d) => d, getIntPref: (_k, d) => d },
      obs: { addObserver() {}, removeObserver() {} },
    },
    console: { info() {}, log() {}, error: (...a) => errors.push(a.join(" ")) },
  };
  new Function(...Object.keys(sandbox), SRC)(...Object.values(sandbox));
  const strip = () => added.find(el => el.id === "little-arc-drag");
  return { CustomTitlebar, disallowed, sheets, added, errors, attrs, moves, strip };
}

const cases = [
  ["link opens in the container of the space you're in (Work)", () => {
    const t = setup(space(2));
    t.click("https://jira.example.com/browse/X-1");
    assert.strictEqual(t.opened.length, 1);
    const a = t.args();
    assert.strictEqual(a[0], "https://jira.example.com/browse/X-1");
    assert.strictEqual(a[5], 2, "window.arguments[5] is the userContextId");
    assert.strictEqual(a[8], SYSTEM, "a triggering principal is required once arguments carry a container");
  }],
  ["space without a container opens with no container", () => {
    const t = setup(space(0));
    t.click("https://example.com/");
    assert.strictEqual(t.args()[5], 0);
  }],
  ["no Zen spaces API: still opens a little window, no container", () => {
    const t = setup(undefined);
    t.click("https://example.com/");
    assert.strictEqual(t.opened.length, 1);
    assert.strictEqual(t.args()[5], 0);
  }],
  ["spaces API throwing never blocks the link", () => {
    const t = setup({ getCurrentSpaceContainerId: () => { throw new Error("boom"); } });
    t.click("https://example.com/");
    assert.strictEqual(t.opened.length, 1);
    assert.strictEqual(t.args()[5], 0);
    assert.ok(t.errors.some(e => e.includes("[little-arc]")), "logs with the [little-arc] prefix");
  }],
  ["little window: no system title bar, even after Firefox re-applies its popup rule", () => {
    const t = setupLittle();
    t.CustomTitlebar.allowedBy("non-popup", false);
    assert.ok(!("non-popup" in t.disallowed), "the popup veto must not stick in a little window");
    t.CustomTitlebar.allowedBy("pref", false);
    assert.ok("pref" in t.disallowed, "other reasons (e.g. the user's titlebar pref) still apply");
  }],
  ["little window: Zen's URL bar row is hidden", () => {
    const t = setupLittle();
    const css = t.sheets.join("\n");
    assert.match(css, /:root\[little-arc\][^{]*#zen-appcontent-navbar-wrapper[^{]*\{[^}]*(display:\s*none|visibility:\s*collapse)/);
    assert.strictEqual(t.attrs["little-arc"], "true");
  }],
  ["little window: dragging the top strip moves the window with the pointer", () => {
    const t = setupLittle();
    const strip = t.strip();
    assert.ok(strip, "drag strip added");
    strip.fire("pointerdown", { screenX: 100, screenY: 30 });
    assert.strictEqual(strip.captured, 1, "captures the pointer so fast drags don't slip off");
    assert.strictEqual(strip.attrs.dragging, "true");
    strip.fire("pointermove", { screenX: 150, screenY: 80 });
    strip.fire("pointermove", { screenX: 160, screenY: 70 });
    assert.deepStrictEqual(t.moves, [[50, 75], [60, 65]]);
    strip.fire("pointerup", { screenX: 160, screenY: 70 });
    strip.fire("lostpointercapture");
    strip.fire("pointermove", { screenX: 400, screenY: 400 });
    assert.strictEqual(t.moves.length, 2, "stops following after release");
    assert.ok(!("dragging" in strip.attrs));
  }],
  ["little window: right-click on the strip doesn't drag", () => {
    const t = setupLittle();
    const strip = t.strip();
    strip.fire("pointerdown", { button: 2, screenX: 100, screenY: 30 });
    strip.fire("pointermove", { screenX: 150, screenY: 80 });
    assert.strictEqual(t.moves.length, 0);
  }],
  ["little window: strip is invisible until hovered, then highlights with a hand cursor", () => {
    const css = setupLittle().sheets.join("\n");
    const rule = sel => (css.match(new RegExp(sel.replace(/[[\]]/g, "\\$&") + "\\s*\\{([^}]*)\\}")) || [])[1] || "";
    assert.match(rule("#little-arc-drag"), /background(-color)?:\s*transparent/);
    assert.match(rule("#little-arc-drag"), /cursor:\s*grab\b/);
    assert.match(rule("#little-arc-drag:hover"), /background(-color)?:\s*rgba\(/);
    assert.match(rule("#little-arc-drag[dragging]"), /cursor:\s*grabbing/);
    assert.doesNotMatch(rule("#little-arc-drag"), /-moz-window-dragging:\s*drag/, "native drag would swallow the pointer events");
  }],
  ["little window without CustomTitlebar still works (keeps the title bar)", () => {
    const t = setupLittle(null);
    assert.ok(t.added.some(el => el.id === "little-arc-promote"), "promote button still added");
    assert.ok(t.errors.some(e => e.includes("[little-arc]")), "logs why the title bar stays");
  }],
  ["links clicked inside Zen are untouched", () => {
    const t = setup(space(2));
    t.click("https://example.com/", 0);
    assert.strictEqual(t.opened.length, 0);
    assert.strictEqual(t.normal.length, 1);
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
console.log(`little-arc: ${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
