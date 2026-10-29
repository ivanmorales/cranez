// ==UserScript==
// @name           tab-expiry
// @description    Arc-style tab expiration: close tabs untouched for 12h unless pinned, an Essential, or bookmarked
// @cranez-name    Tab Expirererer
// @cranez-blurb   untouched for 12h? gone. Pinned, bookmarked & noisy tabs live
// @include        main
// ==/UserScript==

/*
 * How it works
 * - Every few minutes, each normal Zen window looks at all of its tabs (every workspace)
 *   and closes the ones you haven't opened for longer than the expiry time (12h default, like Arc).
 *   The clock is Firefox's own "last accessed" time, which survives restarts and resets
 *   every time you visit the tab.
 * - Never closed:
 *     pinned tabs and Essentials, tabs whose URL is bookmarked, the selected tab,
 *     anything currently visible (split view), tabs playing audio, tabs with an open
 *     Picture-in-Picture player, Glance / empty tabs, and pages that would ask
 *     "leave this page?" (unsaved input). Those are retried on the next pass.
 * - Bookmark matching ignores the #fragment. Set tabexpiry.bookmark_ignore_query to also
 *   ignore ?query, so a bookmark keeps every URL on that same page path alive.
 * - Closed tabs go to History > Recently Closed Tabs as usual, and each one is also
 *   appended to tab-expiry-archive.jsonl in your profile folder (title, URL, times).
 *
 * Prefs (about:config, all optional):
 *   tabexpiry.enabled                bool  default true
 *   tabexpiry.minutes                int   default 720    expiry time (720 = 12h, 1440 = 24h)
 *   tabexpiry.check_minutes          int   default 10     how often to check
 *   tabexpiry.keep_bookmarked        bool  default true
 *   tabexpiry.bookmark_ignore_query  bool  default false
 *   tabexpiry.archive                bool  default true   write tab-expiry-archive.jsonl
 *   tabexpiry.dry_run                bool  default false  only log what WOULD close
 *   tabexpiry.run_now                bool  set to true to run a check immediately (resets itself)
 *   tabexpiry.debug                  bool  default false  log why each tab was kept
 */

(() => {
  "use strict";

  const VERSION = "v2-12h";
  const bool = (p, d) => Services.prefs.getBoolPref(p, d);
  const int = (p, d) => Services.prefs.getIntPref(p, d);
  const log = (...a) => bool("tabexpiry.debug", false) && console.log("[tab-expiry]", ...a);

  const STARTUP_DELAY_MS = 60_000; // let session restore settle before the first pass

  // ---------------------------------------------------------------------------
  // Bookmarks
  // ---------------------------------------------------------------------------

  function places() {
    return (
      window.PlacesUtils ?? ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs").PlacesUtils
    );
  }

  function withoutHash(url) {
    try {
      const u = new URL(url);
      u.hash = "";
      return u.href;
    } catch (e) {
      return url;
    }
  }

  function pageKey(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname.replace(/\/+$/, "");
    } catch (e) {
      return null;
    }
  }

  async function loadBookmarks() {
    const db = await places().promiseDBConnection();
    const rows = await db.executeCached(
      `SELECT DISTINCT h.url AS url
         FROM moz_bookmarks b
         JOIN moz_places h ON h.id = b.fk
        WHERE b.type = 1`
    );
    const exact = new Set();
    const pages = new Set();
    for (const row of rows) {
      const url = row.getResultByName("url");
      exact.add(withoutHash(url));
      const key = pageKey(url);
      if (key) {
        pages.add(key);
      }
    }
    return { exact, pages };
  }

  function isBookmarked(url, bm) {
    if (bm.exact.has(withoutHash(url))) {
      return true;
    }
    return bool("tabexpiry.bookmark_ignore_query", false) && bm.pages.has(pageKey(url));
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  // Unloaded / not-yet-restored tabs report about:blank; ask SessionStore instead.
  function tabURL(tab) {
    let url = "";
    try {
      url = tab.linkedBrowser?.currentURI?.spec ?? "";
    } catch (e) {}
    if (!url || url === "about:blank") {
      try {
        const state = JSON.parse(SessionStore.getTabState(tab));
        const entry = state.entries?.[(state.index ?? state.entries.length) - 1];
        url = entry?.url || url;
      } catch (e) {}
    }
    return url;
  }

  function keepReason(tab, now, ttl, bm) {
    if (tab.closing) {
      return "closing";
    }
    if (tab.selected) {
      return "selected";
    }
    if (tab.pinned) {
      return "pinned";
    }
    if (tab.hasAttribute("zen-essential")) {
      return "essential";
    }
    if (tab.hasAttribute("zen-glance-tab") || tab.hasAttribute("zen-empty-tab")) {
      return "zen special tab";
    }
    if (tab.hasAttribute("soundplaying")) {
      return "playing audio";
    }
    try {
      if (tab.linkedBrowser?.docShellIsActive) {
        return "visible";
      }
    } catch (e) {}
    try {
      if (window.PictureInPicture?.isOriginatingBrowser(tab.linkedBrowser)) {
        return "has PiP player";
      }
    } catch (e) {}

    const last = tab.lastAccessed;
    if (!Number.isFinite(last) || last <= 0) {
      return "no last-accessed time";
    }
    if (now - last < ttl) {
      return "fresh";
    }
    if (bm && isBookmarked(tabURL(tab), bm)) {
      return "bookmarked";
    }
    return null;
  }

  // false if the page would show a "leave this page?" prompt (unsaved input).
  async function closesQuietly(tab) {
    const browser = tab.linkedBrowser;
    if (!tab.linkedPanel || tab.hasAttribute("pending") || !browser) {
      return true; // never loaded in this session: nothing to lose
    }
    if (typeof browser.asyncPermitUnload !== "function") {
      return true;
    }
    try {
      const result = await Promise.race([
        browser.asyncPermitUnload("dontUnload"),
        new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 2000)),
      ]);
      return !result?.timedOut && result?.permitUnload !== false;
    } catch (e) {
      log("permit-unload check failed; keeping tab for now", e);
      return false;
    }
  }

  async function archive(entries) {
    if (!entries.length || !bool("tabexpiry.archive", true)) {
      return;
    }
    try {
      const path = PathUtils.join(PathUtils.profileDir, "tab-expiry-archive.jsonl");
      const lines = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
      await IOUtils.writeUTF8(path, lines, { mode: "appendOrCreate" });
    } catch (e) {
      console.error("[tab-expiry] could not write archive", e);
    }
  }

  // ---------------------------------------------------------------------------
  // The pass
  // ---------------------------------------------------------------------------

  let sweeping = false;

  async function sweep(trigger) {
    if (sweeping || window.closed || !bool("tabexpiry.enabled", true)) {
      return;
    }
    sweeping = true;
    try {
      const ttl = Math.max(1, int("tabexpiry.minutes", 720)) * 60_000;
      const dry = bool("tabexpiry.dry_run", false);
      const now = Date.now();

      let bm = null;
      if (bool("tabexpiry.keep_bookmarked", true)) {
        try {
          bm = await loadBookmarks();
        } catch (e) {
          // If bookmarks can't be read, close nothing rather than risk closing bookmarked tabs.
          console.error("[tab-expiry] could not read bookmarks; skipping this pass", e);
          return;
        }
      }

      const expired = [];
      for (const tab of [...gBrowser.tabs]) {
        const reason = keepReason(tab, now, ttl, bm);
        if (reason) {
          if (reason !== "fresh") {
            log(`keep (${reason}):`, tab.label);
          }
          continue;
        }
        expired.push(tab);
      }

      const closed = [];
      let wouldClose = 0;
      for (const tab of expired) {
        const url = tabURL(tab);
        const idleHours = ((now - tab.lastAccessed) / 3_600_000).toFixed(1);

        if (!(await closesQuietly(tab))) {
          log("keep (page has unsaved changes):", tab.label);
          continue;
        }
        if (dry) {
          console.info(`[tab-expiry] DRY RUN would close (idle ${idleHours}h): ${tab.label} — ${url}`);
          wouldClose++;
          continue;
        }
        // Re-check after the await: the user may have switched to it meanwhile.
        if (tab.closing || tab.selected || !tab.isConnected) {
          continue;
        }
        closed.push({
          title: tab.label,
          url,
          lastAccessed: new Date(tab.lastAccessed).toISOString(),
          closedAt: new Date().toISOString(),
          workspace: tab.getAttribute("zen-workspace-id") || null,
        });
        gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
      }

      await archive(closed);
      if (closed.length || wouldClose) {
        console.info(
          `[tab-expiry] ${dry ? "dry run: " + wouldClose + " would close" : closed.length + " closed"}` +
            ` (${trigger}, expiry ${ttl / 60_000} min)`
        );
      } else {
        log(`nothing expired (${trigger})`);
      }
    } finally {
      sweeping = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  let timer = 0;

  function interval() {
    const check = Math.max(1, int("tabexpiry.check_minutes", 10));
    const expiry = Math.max(1, int("tabexpiry.minutes", 720));
    // With short test expiries, check often enough to notice them.
    return Math.max(1, Math.min(check, Math.ceil(expiry / 4))) * 60_000;
  }

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await sweep("timer");
      } catch (e) {
        console.error("[tab-expiry] pass failed", e);
      } finally {
        if (!window.closed) {
          schedule(interval());
        }
      }
    }, delay);
  }

  const runNowObserver = {
    observe() {
      if (!bool("tabexpiry.run_now", false)) {
        return;
      }
      sweep("run_now").catch(e => console.error("[tab-expiry] pass failed", e));
      // Reset on the next tick so every open window sees the "true" and runs its own pass.
      setTimeout(() => Services.prefs.setBoolPref("tabexpiry.run_now", false), 0);
    },
  };

  function init() {
    // Skip popup-style windows (including little-arc windows).
    if (!window.toolbar.visible) {
      return;
    }
    console.info(`[tab-expiry] ${VERSION} loaded`);
    Services.prefs.addObserver("tabexpiry.run_now", runNowObserver);
    window.addEventListener(
      "unload",
      () => {
        clearTimeout(timer);
        Services.prefs.removeObserver("tabexpiry.run_now", runNowObserver);
      },
      { once: true }
    );
    schedule(Math.min(STARTUP_DELAY_MS, interval()));
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
