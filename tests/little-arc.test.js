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
