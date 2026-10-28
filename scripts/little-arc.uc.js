// ==UserScript==
// @name           little-arc
// @description    Arc-style "Little Arc" for Zen: links from other apps open in a small window; Cmd+O promotes it (PoC)
// @cranez-name    Just the tip
// @cranez-blurb   links from other apps peek in a tiny window; ⌘O goes all in
// @include        main
// ==/UserScript==

/*
 * How it works
 * - In normal (main) windows, wraps browserDOMWindow.openURI. Links opened from other
 *   apps (Slack, terminal, `open -a Zen <url>`) arrive with the OPEN_EXTERNAL flag.
 *   Those are redirected into a new small, popup-style window (no tab strip).
 * - Popup-style windows are skipped by BrowserWindowTracker as "main" windows, so the
 *   next external link still goes through a real main window.
 * - In a little window: a floating "Open in Zen ⌘O" button, and Cmd+O, move the tab
 *   into the most recent main window (adoptTab keeps history) and close the little window.
 * - Links clicked inside Zen are untouched; only OS-external opens are rerouted.
 * - The little window opens in the container of the Zen space you're in (e.g. a Work
 *   space's container, so you're signed in), and ⌘O keeps it.
 *
 * Optional prefs (about:config):
 *   arclittle.enabled         bool  default true
 *   arclittle.width           int   default 560
 *   arclittle.height          int   default 760
 *   arclittle.escape_closes   bool  default false  Esc closes the little window
 *   arclittle.debug           bool  default false  log to Browser Console
 *
 * Placement: the little window opens centered on the monitor where the mouse cursor is
 * when the link arrives (i.e. where you just clicked). The cursor position comes from
 * macOS (NSEvent.mouseLocation via js-ctypes). If that fails, it falls back to the
 * monitor of the current Zen window. Little windows also no longer save their position,
 * so they can't drag the next little window (or a new normal window) to where you left them.
 *
 * Known limitations: if Zen isn't running, the first external link opens a normal
 * window (the OS launches Zen directly). Uses Firefox internals that can change.
 */

(() => {
  "use strict";

  const VERSION = "v4-space-container";
  const NAME_PREFIX = "arc-little-";
  const XHTML_NS = "http://www.w3.org/1999/xhtml";

  const bool = (p, d) => Services.prefs.getBoolPref(p, d);
  const int = (p, d) => Services.prefs.getIntPref(p, d);
  const log = (...a) => bool("arclittle.debug", false) && console.log("[little-arc]", ...a);

  const isLittle = () => (window.name || "").startsWith(NAME_PREFIX);

  function tracker() {
    return (
      window.BrowserWindowTracker ??
      ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs")
        .BrowserWindowTracker
    );
  }

  // ---------------------------------------------------------------------------
  // Placement: which monitor, and where on it
  // ---------------------------------------------------------------------------

  function screenManager() {
    return Cc["@mozilla.org/gfx/screenmanager;1"].getService(Ci.nsIScreenManager);
  }

  function rectOf(screen, method) {
    const l = {},
      t = {},
      w = {},
      h = {};
    screen[method](l, t, w, h);
    return [l.value, t.value, w.value, h.value];
  }

  let mouseLocation = null;

  // Cursor position in Gecko desktop coordinates (origin top-left of the primary
  // display, y down). macOS reports it with origin bottom-left, y up, so we flip it.
  function getCursorPoint() {
    try {
      if (!mouseLocation) {
        const ctypes =
          globalThis.ctypes ??
          ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs").ctypes;
        const objc = ctypes.open("/usr/lib/libobjc.A.dylib");
        const id = ctypes.voidptr_t;
        const getClass = objc.declare("objc_getClass", ctypes.default_abi, id, ctypes.char.ptr);
        const getSel = objc.declare("sel_registerName", ctypes.default_abi, id, ctypes.char.ptr);
        const NSPoint = new ctypes.StructType("NSPoint", [{ x: ctypes.double }, { y: ctypes.double }]);
        const msgSendPoint = objc.declare("objc_msgSend", ctypes.default_abi, NSPoint, id, id);
        const cls = getClass("NSEvent");
        const sel = getSel("mouseLocation");
        mouseLocation = () => msgSendPoint(cls, sel);
      }
      const p = mouseLocation();
      const [, , , primaryHeight] = rectOf(screenManager().primaryScreen, "GetRectDisplayPix");
      return { x: p.x, y: primaryHeight - p.y };
    } catch (e) {
      console.error("[little-arc] could not read cursor position; using current window's monitor", e);
      return null;
    }
  }

  function computePlacement() {
    const wantW = int("arclittle.width", 560);
    const wantH = int("arclittle.height", 760);
    const sm = screenManager();

    const cursor = getCursorPoint();
    const screen = cursor
      ? sm.screenForRect(Math.round(cursor.x), Math.round(cursor.y), 1, 1)
      : sm.screenForRect(window.screenX, window.screenY, window.outerWidth, window.outerHeight);

    const [sl, st, sw, sh] = rectOf(screen, "GetAvailRectDisplayPix");
    const width = Math.min(wantW, sw);
    const height = Math.min(wantH, sh);
    const left = Math.round(sl + (sw - width) / 2);
    const top = Math.round(st + (sh - height) / 2);

    log("cursor", cursor, "-> monitor", { sl, st, sw, sh }, "-> window", { left, top, width, height });
    return { left, top, width, height };
  }

  // The placement is carried in the window name so the little window can re-apply it.
  function encodeName({ left, top, width, height }) {
    return `${NAME_PREFIX}${left}_${top}_${width}_${height}_${Date.now()}`;
  }

  function decodeName() {
    const parts = (window.name || "").slice(NAME_PREFIX.length).split("_").map(Number);
    if (parts.length < 4 || parts.slice(0, 4).some(n => !Number.isFinite(n))) {
      return null;
    }
    const [left, top, width, height] = parts;
    return { left, top, width, height };
  }

  // Container (userContextId) of the space this window is showing; 0 = no container.
  function spaceContainerId() {
    try {
      return window.gZenWorkspaces?.getCurrentSpaceContainerId?.() ?? 0;
    } catch (e) {
      console.error("[little-arc] could not read the space's container; opening without one", e);
      return 0;
    }
  }

  function openLittle(spec) {
    const place = computePlacement();
    const userContextId = spaceContainerId();
    // No "all" in the features => popup-style window: no tab strip, toolbar.visible
    // is false, and BrowserWindowTracker won't pick it as a main window.
    // Explicit left/top/width/height also tell Gecko to ignore any saved position.
    const features =
      `chrome,dialog=no,resizable=yes,` +
      `left=${place.left},top=${place.top},width=${place.width},height=${place.height}`;
    // window.arguments as browser-init.js reads them: [0] uri ... [5] userContextId,
    // [8] triggeringPrincipal (required once there are 3+ arguments).
    log("opening in container", userContextId);
    window.openDialog(
      AppConstants.BROWSER_CHROME_URL,
      encodeName(place),
      features,
      spec,
      null,
      null,
      null,
      false,
      userContextId,
      null,
      null,
      Services.scriptSecurityManager.getSystemPrincipal()
    );
  }

  // ---------------------------------------------------------------------------
  // Main windows: intercept links coming from other apps
  // ---------------------------------------------------------------------------

  function interceptedOpenURI(orig, args) {
    const [uri, , , flags] = args;
    try {
      const external = flags & Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL;
      const web = uri && (uri.schemeIs("https") || uri.schemeIs("http"));
      if (bool("arclittle.enabled", true) && external && web) {
        log("external link -> little window:", uri.spec);
        openLittle(uri.spec);
        return null;
      }
    } catch (e) {
      console.error("[little-arc] intercept failed, falling back to normal open", e);
    }
    return orig.openURI(...args);
  }

  function patchOpenURI() {
    if (window.__littleArcPatched) {
      return;
    }
    const orig = window.browserDOMWindow;
    if (!orig) {
      console.error("[little-arc] browserDOMWindow not available");
      return;
    }

    // In current Gecko, openURI on the existing object is read-only, so instead of
    // patching the method we put a forwarding proxy in front of the whole object.
    // Only openURI is changed; every other member goes straight to the original.
    const qi = ChromeUtils.generateQI(["nsIBrowserDOMWindow"]);
    const proxy = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "openURI") {
            return (...args) => interceptedOpenURI(orig, args);
          }
          if (prop === "QueryInterface") {
            return qi;
          }
          const value = orig[prop];
          return typeof value === "function" ? value.bind(orig) : value;
        },
        has(_target, prop) {
          return prop === "QueryInterface" || prop in orig;
        },
      }
    );

    let installed = false;
    try {
      window.browserDOMWindow = proxy;
      installed = window.browserDOMWindow === proxy;
    } catch (e) {
      log("plain assignment failed, trying defineProperty", e);
    }
    if (!installed) {
      try {
        Object.defineProperty(window, "browserDOMWindow", {
          value: proxy,
          writable: true,
          configurable: true,
        });
        installed = window.browserDOMWindow === proxy;
      } catch (e) {
        console.error("[little-arc] could not replace browserDOMWindow", e);
      }
    }

    window.__littleArcPatched = installed;
    if (installed) {
      log("external-link intercept installed in main window");
    } else {
      console.error("[little-arc] intercept NOT installed; external links will open normally");
    }
  }

  // ---------------------------------------------------------------------------
  // Little windows: promote to main window
  // ---------------------------------------------------------------------------

  // Stop this little window from saving its position/size, and drop any saved
  // values it was created with, so only our placement applies.
  function disablePersistence() {
    const root = document.documentElement;
    root.removeAttribute("persist");
    for (const attr of ["screenX", "screenY", "width", "height", "sizemode"]) {
      root.removeAttribute(attr);
    }
  }

  function enforcePlacement(stage) {
    const place = decodeName();
    if (!place) {
      return;
    }
    const off = Math.abs(window.screenX - place.left) > 2 || Math.abs(window.screenY - place.top) > 2;
    if (off) {
      log(`moving little window (${stage})`, { from: [window.screenX, window.screenY], to: place });
      window.moveTo(place.left, place.top);
    }
  }

  let promoting = false;

  function promote() {
    if (promoting || window.closed) {
      return;
    }
    promoting = true;

    const tab = gBrowser.selectedTab;
    const isPrivate = PrivateBrowsingUtils.isWindowPrivate(window);
    const main = tracker().getTopWindow({ private: isPrivate, allowPopups: false });

    if (!main || main === window) {
      log("no main window found; opening a normal window instead");
      window.openDialog(
        AppConstants.BROWSER_CHROME_URL,
        "_blank",
        "chrome,all,dialog=no",
        gBrowser.currentURI.spec
      );
      window.close();
      return;
    }

    let adopted = null;
    try {
      adopted = main.gBrowser.adoptTab(tab, { selectTab: true });
    } catch (e) {
      console.error("[little-arc] adoptTab threw", e);
    }
    if (!adopted) {
      promoting = false;
      console.error("[little-arc] adoptTab failed; little window left open");
      return;
    }

    log("promoted to main window:", adopted.linkedBrowser?.currentURI?.spec);
    main.focus();
    // Moving the last tab out normally closes this window; make sure it does.
    setTimeout(() => {
      if (!window.closed) {
        window.close();
      }
    }, 0);
  }

  function addPromoteButton() {
    const css = `
      #little-arc-promote {
        position: fixed;
        right: 12px;
        bottom: 12px;
        z-index: 2147483647;
        -moz-window-dragging: no-drag;
        padding: 5px 12px;
        border: 0;
        border-radius: 999px;
        background: rgba(20, 20, 20, 0.78);
        color: #fff;
        font: menu;
        font-size: 12px;
        cursor: pointer;
        opacity: 0.85;
      }
      #little-arc-promote:hover { opacity: 1; }
    `;
    window.windowUtils.loadSheetUsingURIString(
      "data:text/css;charset=utf-8," + encodeURIComponent(css),
      window.windowUtils.AUTHOR_SHEET
    );

    const btn = document.createElementNS(XHTML_NS, "button");
    btn.id = "little-arc-promote";
    btn.textContent = "Open in Zen  \u2318O";
    btn.addEventListener("click", promote);
    (document.body ?? document.documentElement).appendChild(btn);
  }

  function bindKeys() {
    // Cmd+O is "Open File" by default. Swallow that command in this window only.
    window.addEventListener(
      "command",
      e => {
        if (e.target?.id === "Browser:OpenFile") {
          e.stopPropagation();
          e.preventDefault();
          promote();
        }
      },
      true
    );

    // Fallback in case Zen remapped or removed the Open File shortcut.
    window.addEventListener(
      "keydown",
      e => {
        const plainCmd = e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey;
        if (plainCmd && e.key.toLowerCase() === "o") {
          e.preventDefault();
          promote();
        } else if (e.key === "Escape" && bool("arclittle.escape_closes", false)) {
          window.close();
        }
      },
      true
    );
  }

  // ---------------------------------------------------------------------------

  function init() {
    console.info(`[little-arc] ${VERSION} loaded (${isLittle() ? "little" : "main"} window)`);
    if (isLittle()) {
      enforcePlacement("delayed-startup");
      document.documentElement.setAttribute("little-arc", "true");
      addPromoteButton();
      bindKeys();
      log("little window ready");
    } else {
      patchOpenURI();
    }
  }

  // As early as possible in a little window: no saved geometry, our placement only.
  if (isLittle()) {
    disablePersistence();
    enforcePlacement("early");
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
