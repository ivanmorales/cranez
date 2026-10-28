// ==UserScript==
// @name           dev-bar
// @description    Arc-style ^D developer bar: shows the tab's URL with copy, console, network and inspect buttons
// @cranez-name    ^Dev Bar
// @cranez-blurb   Ctrl+D: URL, Copy, Console, Network, Inspect. Nerd mode on
// @include        main
// ==/UserScript==

/*
 * Ctrl+D toggles a slim bar across the top of the page area (the top toolbar can stay off).
 * The page is pushed down to make room, so nothing is covered.
 *   - URL of the current tab (click it to copy)
 *   - Copy URL button
 *   - Console, Network: open DevTools on that panel; click again to close DevTools
 *   - Inspect: opens the Inspector with the element picker active
 * The bar follows you across tabs, workspaces and navigations. On/off state is shared by
 * all windows and survives restarts.
 * Copy URL keybind: Zen already has Cmd+Shift+C built in, so the script doesn't add one.
 *
 * Optional prefs (about:config):
 *   devbar.visible   bool    the on/off state (Ctrl+D flips it)
 *   devbar.color     string  bar background, any CSS color (default: darkened Zen accent)
 *   devbar.debug     bool    log to Browser Console
 */

(() => {
  "use strict";

  const VERSION = "v2";
  const XHTML = "http://www.w3.org/1999/xhtml";
  const SVG = "http://www.w3.org/2000/svg";

  const bool = (p, d) => Services.prefs.getBoolPref(p, d);
  const str = (p, d) => Services.prefs.getStringPref(p, d);
  const log = (...a) => bool("devbar.debug", false) && console.log("[dev-bar]", ...a);

  // ---------------------------------------------------------------------------
  // Icons (inline SVG so nothing depends on internal icon paths)
  // ---------------------------------------------------------------------------

  const ICONS = {
    lock: [
      ["rect", { x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.5 }],
      ["path", { d: "M5.5 7V5a2.5 2.5 0 0 1 5 0v2" }],
    ],
    unlock: [
      ["rect", { x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.5 }],
      ["path", { d: "M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" }],
    ],
    info: [
      ["circle", { cx: 8, cy: 8, r: 6 }],
      ["path", { d: "M8 7.5v3.5" }],
      ["path", { d: "M8 5.2v.01" }],
    ],
    link: [
      ["path", { d: "M6.6 9.4l2.8-2.8" }],
      ["path", { d: "M7.2 4.6l.8-.8a2.6 2.6 0 0 1 3.7 3.7l-.8.8" }],
      ["path", { d: "M8.8 11.4l-.8.8a2.6 2.6 0 0 1-3.7-3.7l.8-.8" }],
    ],
    console: [
      ["rect", { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }],
      ["path", { d: "M4.5 6.2 6.8 8l-2.3 1.8" }],
      ["path", { d: "M8.3 10.2h3.2" }],
    ],
    network: [
      ["circle", { cx: 8, cy: 8, r: 6 }],
      ["path", { d: "M2 8h12" }],
      ["path", { d: "M8 2c1.7 1.7 2.6 3.7 2.6 6S9.7 12.3 8 14C6.3 12.3 5.4 10.3 5.4 8S6.3 3.7 8 2z" }],
    ],
    inspect: [
      ["circle", { cx: 8, cy: 8, r: 4.5 }],
      ["path", { d: "M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" }],
      ["circle", { cx: 8, cy: 8, r: 0.9, fill: "currentColor" }],
    ],
  };

  function icon(name) {
    const svg = document.createElementNS(SVG, "svg");
    for (const [k, v] of Object.entries({
      viewBox: "0 0 16 16",
      width: 16,
      height: 16,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.4,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    })) {
      svg.setAttribute(k, String(v));
    }
    for (const [tag, attrs] of ICONS[name]) {
      const el = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, String(v));
      }
      svg.appendChild(el);
    }
    return svg;
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const CSS = `
    #devbar {
      position: fixed;
      z-index: 5;
      display: flex;
      align-items: center;
      gap: 4px;
      height: 32px;
      padding: 0 8px 0 12px;
      box-sizing: border-box;
      background: var(--devbar-bg, color-mix(in srgb, var(--zen-primary-color, #3a46c9) 70%, black));
      color: #fff;
      font: 12px/1 ui-monospace, "SF Mono", Menlo, monospace;
      -moz-window-dragging: no-drag;
      user-select: none;
    }
    #devbar[hidden] { display: none !important; }
    /* Make room for the bar: the page area keeps its size, the page starts 32px lower. */
    [devbar-pushed] {
      padding-top: 32px !important;
      box-sizing: border-box !important;
    }
    /* Video / page fullscreen: get out of the way. */
    :root[inDOMFullscreen] #devbar { display: none !important; }
    :root[inDOMFullscreen] [devbar-pushed] { padding-top: 0 !important; }
    #devbar .devbar-lock { display: grid; place-items: center; opacity: 0.85; }
    #devbar .devbar-url {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
      padding: 5px 6px;
      border-radius: 6px;
    }
    #devbar .devbar-url:hover { background: rgba(255, 255, 255, 0.12); }
    #devbar button {
      appearance: none;
      border: 0;
      margin: 0;
      padding: 0;
      background: transparent;
      color: inherit;
      width: 28px;
      height: 24px;
      border-radius: 6px;
      display: grid;
      place-items: center;
      opacity: 0.85;
      cursor: pointer;
    }
    #devbar button:hover { background: rgba(255, 255, 255, 0.15); opacity: 1; }
    #devbar button:active { background: rgba(255, 255, 255, 0.25); }
    #devbar .devbar-sep { width: 1px; height: 16px; background: currentColor; opacity: 0.25; margin: 0 4px; }
  `;

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper);

  let devtoolsRef = null;
  function gDevTools() {
    if (!devtoolsRef) {
      const { require } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");
      devtoolsRef = require("devtools/client/framework/devtools").gDevTools;
    }
    return devtoolsRef;
  }

  // Open DevTools on a panel; if it's already open on that panel, close DevTools.
  async function toggleTool(toolId) {
    try {
      const tab = gBrowser.selectedTab;
      const dt = gDevTools();
      const toolbox = dt.getToolboxForTab(tab);
      if (toolbox && toolbox.currentToolId === toolId) {
        await dt.closeToolboxForTab(tab);
        return;
      }
      await dt.showToolboxForTab(tab, { toolId });
    } catch (e) {
      console.error(`[dev-bar] could not open ${toolId}`, e);
    }
  }

  async function inspectElement() {
    try {
      const toolbox = await gDevTools().showToolboxForTab(gBrowser.selectedTab, { toolId: "inspector" });
      const picker = toolbox.nodePicker;
      if (picker?.isPicking) {
        return;
      }
      if (typeof picker?.start === "function") {
        await picker.start();
      } else if (typeof picker?.togglePicker === "function") {
        await picker.togglePicker();
      }
    } catch (e) {
      console.error("[dev-bar] could not start the element picker", e);
    }
  }

  // ---------------------------------------------------------------------------
  // The bar
  // ---------------------------------------------------------------------------

  let bar = null;
  let urlEl = null;
  let lockEl = null;
  let flashTimer = 0;

  function button(name, title, onClick) {
    const b = document.createElementNS(XHTML, "button");
    b.title = title;
    b.appendChild(icon(name));
    b.addEventListener("click", e => {
      e.preventDefault();
      onClick();
    });
    return b;
  }

  function sep() {
    const s = document.createElementNS(XHTML, "span");
    s.className = "devbar-sep";
    return s;
  }

  function buildBar() {
    window.windowUtils.loadSheetUsingURIString(
      "data:text/css;charset=utf-8," + encodeURIComponent(CSS),
      window.windowUtils.AUTHOR_SHEET
    );

    bar = document.createElementNS(XHTML, "div");
    bar.id = "devbar";
    bar.setAttribute("role", "toolbar");

    lockEl = document.createElementNS(XHTML, "span");
    lockEl.className = "devbar-lock";

    urlEl = document.createElementNS(XHTML, "span");
    urlEl.className = "devbar-url";
    urlEl.addEventListener("click", copyURL);

    bar.append(
      lockEl,
      urlEl,
      button("link", "Copy URL (\u2318\u21e7C)", copyURL),
      sep(),
      button("console", "Console", () => toggleTool("webconsole")),
      button("network", "Network", () => toggleTool("netmonitor")),
      button("inspect", "Inspect element", inspectElement)
    );
    applyColor();
    log("bar built");
  }

  function applyColor() {
    if (!bar) {
      return;
    }
    const color = str("devbar.color", "");
    if (color) {
      bar.style.setProperty("--devbar-bg", color);
    } else {
      bar.style.removeProperty("--devbar-bg");
    }
  }

  // The bar lives outside Zen's layout (position: fixed) and is lined up with the
  // selected tab's page area each time that area moves or resizes. The page itself is
  // pushed down by padding on its .browserStack, so nothing is covered.
  let pushedStack = null;
  let observed = null;
  const resizeObserver = new ResizeObserver(() => position());

  function pageArea() {
    const browser = gBrowser.selectedBrowser;
    return browser.closest?.(".browserStack") ?? browser.parentNode ?? browser;
  }

  function release() {
    pushedStack?.removeAttribute("devbar-pushed");
    pushedStack = null;
    if (observed) {
      resizeObserver.unobserve(observed);
      observed = null;
    }
  }

  function place() {
    if (!bar) {
      return;
    }
    if (!bar.isConnected) {
      (document.body ?? document.documentElement).appendChild(bar);
    }
    const area = pageArea();
    if (pushedStack !== area) {
      pushedStack?.removeAttribute("devbar-pushed");
      area.setAttribute("devbar-pushed", "true");
      pushedStack = area;
    }
    if (observed !== area) {
      if (observed) {
        resizeObserver.unobserve(observed);
      }
      resizeObserver.observe(area);
      observed = area;
    }
    position();
  }

  // Match the page area's rounded top corners (Zen rounds the content area).
  function cornerRadius(area) {
    const candidates = [gBrowser.selectedBrowser];
    for (let el = area, i = 0; el && i < 4; el = el.parentElement, i++) {
      candidates.push(el);
    }
    for (const el of candidates) {
      const r = getComputedStyle(el).borderTopLeftRadius;
      if (r && r !== "0px") {
        return r;
      }
    }
    return "0px";
  }

  function position() {
    if (!bar || bar.hidden || !pushedStack) {
      return;
    }
    const r = pushedStack.getBoundingClientRect();
    bar.style.left = `${r.left}px`;
    bar.style.top = `${r.top}px`;
    bar.style.width = `${r.width}px`;
    const radius = cornerRadius(pushedStack);
    bar.style.borderRadius = `${radius} ${radius} 0 0`;
    log("positioned", { left: r.left, top: r.top, width: r.width, radius });
  }

  function update() {
    if (!bar || bar.hidden) {
      return;
    }
    clearTimeout(flashTimer);
    const uri = gBrowser.currentURI;
    let shown = "";
    try {
      shown = uri.displaySpec;
    } catch (e) {
      shown = uri?.spec ?? "";
    }
    urlEl.textContent = shown;
    urlEl.title = `${shown}\nClick to copy`;
    const scheme = uri?.scheme;
    lockEl.replaceChildren(icon(scheme === "https" ? "lock" : scheme === "http" ? "unlock" : "info"));
  }

  function copyURL() {
    const spec = gBrowser.currentURI?.spec;
    if (!spec) {
      return;
    }
    clipboard.copyString(spec);
    if (urlEl && bar && !bar.hidden) {
      urlEl.textContent = "\u2713 Copied";
      clearTimeout(flashTimer);
      flashTimer = setTimeout(update, 900);
    }
    log("copied", spec);
  }

  function applyVisibility() {
    const visible = bool("devbar.visible", false);
    if (visible && !bar) {
      buildBar();
    }
    if (!bar) {
      return;
    }
    bar.hidden = !visible;
    if (visible) {
      place();
      update();
    } else {
      release();
    }
  }

  // ---------------------------------------------------------------------------
  // Ctrl+D
  // ---------------------------------------------------------------------------

  let lastToggle = 0;
  function toggle() {
    const now = performance.now();
    if (now - lastToggle < 250) {
      return; // the <key> and the keydown fallback can both fire for one press
    }
    lastToggle = now;
    Services.prefs.setBoolPref("devbar.visible", !bool("devbar.visible", false));
  }

  function addShortcut() {
    // A reserved <key> is handled before the page sees the keystroke.
    const keyset = document.createXULElement("keyset");
    keyset.id = "devbar-keyset";
    const key = document.createXULElement("key");
    key.id = "devbar-toggle-key";
    key.setAttribute("key", "D");
    key.setAttribute("modifiers", "control");
    key.setAttribute("reserved", "true");
    key.addEventListener("command", toggle);
    keyset.appendChild(key);
    const main = document.getElementById("mainKeyset");
    (main?.parentNode ?? document.documentElement).insertBefore(keyset, main ?? null);

    // Fallback in case the <key> doesn't register.
    window.addEventListener(
      "keydown",
      e => {
        if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "d") {
          e.preventDefault();
          e.stopPropagation();
          toggle();
        }
      },
      true
    );
  }

  // ---------------------------------------------------------------------------

  const prefObserver = {
    observe(_s, _t, pref) {
      if (pref === "devbar.color") {
        applyColor();
      } else {
        applyVisibility();
      }
    },
  };

  const progressListener = {
    onLocationChange(webProgress) {
      if (!webProgress || webProgress.isTopLevel) {
        update();
      }
    },
  };

  function onTabSelect() {
    if (bar && !bar.hidden) {
      place();
      update();
    }
  }

  function onWindowResize() {
    position();
  }

  function init() {
    console.info(`[dev-bar] ${VERSION} loaded`);
    addShortcut();
    gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);
    gBrowser.addProgressListener(progressListener);
    window.addEventListener("resize", onWindowResize);
    Services.prefs.addObserver("devbar.visible", prefObserver);
    Services.prefs.addObserver("devbar.color", prefObserver);
    window.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver("devbar.visible", prefObserver);
        Services.prefs.removeObserver("devbar.color", prefObserver);
        gBrowser.removeProgressListener(progressListener);
        gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
        window.removeEventListener("resize", onWindowResize);
        resizeObserver.disconnect();
        clearTimeout(flashTimer);
      },
      { once: true }
    );
    applyVisibility();
  }

  if (window.gBrowserInit?.delayedStartupFinished) {
    init();
  } else {
    const onStartup = subject => {
      if (subject !== window) {
        return;
      }
      Services.obs.removeObserver(onStartup, "browser-delayed-startup-finished");
      init();
    };
    Services.obs.addObserver(onStartup, "browser-delayed-startup-finished");
  }
})();
