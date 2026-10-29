// Simulates scripts/tab-expiry.uc.js outside Zen against a mix of tab types.
// Run: node tests/tab-expiry.test.js
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = fs.readFileSync(path.join(__dirname, "..", "scripts", "tab-expiry.uc.js"), "utf8");
const HOUR = 3_600_000;
const NOW = Date.now();

const BOOKMARKS = [
  "https://mail.google.com/mail/u/0/#inbox",
  "https://github.com/advision/contentforge/pulls",
];

function tab(label, url, idleHours, o = {}) {
  const attrs = new Set(o.attrs || []);
  return {
    label,
    _url: url,
    closing: false,
    isConnected: true,
    selected: !!o.selected,
    pinned: !!o.pinned,
    lastAccessed: o.selected ? Infinity : NOW - idleHours * HOUR,
    linkedPanel: o.pending ? "" : "panel",
    linkedBrowser: {
      currentURI: { spec: o.pending ? "about:blank" : url },
      docShellIsActive: !!o.visible,
      asyncPermitUnload: async () => ({ permitUnload: !o.unsaved }),
    },
    hasAttribute: a => attrs.has(a) || (a === "pending" && !!o.pending),
    getAttribute: a => (a === "zen-workspace-id" ? "ws-1" : null),
  };
}

function setup(prefs) {
  const tabs = [
    tab("selected", "https://example.com/a", 0, { selected: true }),
    tab("old", "https://example.com/old", 30),
    tab("fresh", "https://example.com/fresh", 2),
    tab("yesterday-evening", "https://example.com/evening", 13),
    tab("late-last-night", "https://example.com/night", 11),
    tab("pinned", "https://example.com/pinned", 99, { pinned: true }),
    tab("essential", "https://example.com/ess", 99, { attrs: ["zen-essential"] }),
    tab("bookmarked-diff-hash", "https://mail.google.com/mail/u/0/#label/x", 50),
    tab("bookmarked-path-with-query", "https://github.com/advision/contentforge/pulls?q=is%3Aopen", 50),
    tab("audio", "https://example.com/music", 50, { attrs: ["soundplaying"] }),
    tab("split-view", "https://example.com/split", 50, { visible: true }),
    tab("unsaved", "https://example.com/form", 50, { unsaved: true }),
    tab("pending", "https://example.com/pending", 50, { pending: true }),
    tab("glance", "https://example.com/glance", 50, { attrs: ["zen-glance-tab"] }),
  ];
  const removed = [];
  const info = [];
  const archived = [];
  let observer = null;

  const p = { ...prefs };
  const sandbox = {
    window: {
      toolbar: { visible: true },
      closed: false,
      gBrowserInit: { delayedStartupFinished: true },
      PlacesUtils: {
        promiseDBConnection: async () => ({
          executeCached: async () => BOOKMARKS.map(u => ({ getResultByName: () => u })),
        }),
      },
      PictureInPicture: { isOriginatingBrowser: () => false },
      addEventListener() {},
    },
    gBrowser: { tabs, removeTab: t => { removed.push(t.label); t.closing = true; } },
    SessionStore: { getTabState: t => JSON.stringify({ entries: [{ url: t._url }], index: 1 }) },
    Services: {
      prefs: {
        getBoolPref: (k, d) => (k in p ? p[k] : d),
        getIntPref: (k, d) => (k in p ? p[k] : d),
        setBoolPref: (k, v) => { p[k] = v; },
        addObserver: (_k, o) => { observer = o; },
        removeObserver() {},
      },
      obs: { addObserver() {}, removeObserver() {} },
    },
    ChromeUtils: {},
    PathUtils: { join: (...a) => a.join("/"), profileDir: "/profile" },
    IOUtils: { writeUTF8: async (_p, s) => { archived.push(s); } },
    setTimeout: (fn, ms) => (ms === 0 ? Promise.resolve().then(fn) : 1),
    clearTimeout() {},
    console: { info: (...a) => info.push(a.join(" ")), error() {}, log() {} },
    URL,
  };
  new Function(...Object.keys(sandbox), SRC)(...Object.values(sandbox));

  const runNow = async () => {
    p["tabexpiry.run_now"] = true;
    observer.observe();
    await new Promise(r => setTimeout(r, 30));
  };
  return { runNow, removed, info, archived };
}

const KEPT_ALWAYS = ["selected", "fresh", "late-last-night", "pinned", "essential", "bookmarked-diff-hash", "audio", "split-view", "unsaved", "glance"];

const cases = [
  ["dry run lists expired tabs and closes nothing", async () => {
    const t = setup({ "tabexpiry.dry_run": true });
    await t.runNow();
    assert.deepStrictEqual(t.removed, []);
    const listed = t.info.filter(l => l.includes("DRY RUN would close"));
    assert.strictEqual(listed.length, 4, listed.join("\n"));
    assert.ok(!listed.some(l => l.includes("unsaved")), "dry run should skip pages with unsaved input");
  }],
  ["real run closes only old, unbookmarked, unprotected tabs", async () => {
    const t = setup({});
    await t.runNow();
    assert.deepStrictEqual(t.removed.sort(), ["bookmarked-path-with-query", "old", "pending", "yesterday-evening"].sort());
    for (const k of KEPT_ALWAYS) assert.ok(!t.removed.includes(k), `${k} should be kept`);
    assert.strictEqual(t.archived.join("").trim().split("\n").length, 4);
  }],
  ["bookmark_ignore_query keeps the same page with a different ?query", async () => {
    const t = setup({ "tabexpiry.bookmark_ignore_query": true });
    await t.runNow();
    assert.deepStrictEqual(t.removed.sort(), ["old", "pending", "yesterday-evening"]);
  }],
  ["default expiry is 12h like Arc: yesterday's tabs go, last night's stay", async () => {
    const t = setup({});
    await t.runNow();
    assert.ok(t.removed.includes("yesterday-evening"), "13h idle closes by default");
    assert.ok(!t.removed.includes("late-last-night"), "11h idle is kept by default");
  }],
  ["tabexpiry.minutes still overrides the default", async () => {
    const t = setup({ "tabexpiry.minutes": 1440 });
    await t.runNow();
    assert.ok(!t.removed.includes("yesterday-evening"), "13h idle is kept with a 24h setting");
    assert.ok(t.removed.includes("old"));
  }],
  ["keep_bookmarked=false closes bookmarked tabs too", async () => {
    const t = setup({ "tabexpiry.keep_bookmarked": false });
    await t.runNow();
    assert.ok(t.removed.includes("bookmarked-diff-hash"));
  }],
  ["archive can be turned off", async () => {
    const t = setup({ "tabexpiry.archive": false });
    await t.runNow();
    assert.strictEqual(t.archived.length, 0);
    assert.ok(t.removed.length > 0);
  }],
];

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`  ok    ${name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${name}\n        ${e.message}`);
    }
  }
  console.log(`tab-expiry: ${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
