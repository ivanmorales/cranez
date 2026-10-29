// ==UserScript==
// @name           arc-pip-on-blur
// @description    Arc-style auto Picture-in-Picture when the Zen window goes out of sight (PoC)
// @cranez-name    PiP on Blur
// @cranez-blurb   video out of sight (other Space, covered, minimized)? it tags along in PiP
// @include        main
// ==/UserScript==

/*
 * How it works
 * - Like Arc, PiP happens when you can no longer see the video, not when Zen merely
 *   loses focus: using an app on another monitor leaves the video in the browser.
 * - macOS tells Gecko when the window is fully hidden (another Space on that screen,
 *   covered by other windows, minimized): "occlusionstatechange" / "sizemodechange",
 *   read via window.isFullyOccluded and window.windowState.
 * - After a short delay, if the window is still hidden, asks Firefox's own
 *   PictureInPictureLauncher actor to "AutoToggle", the same message the native
 *   tab-switch auto-PiP sends. The content side only opens PiP if it finds a playing,
 *   PiP-eligible <video>.
 * - When the window is visible again, closes any player this script opened for the
 *   still-selected tab.
 * - Switching tabs or Zen spaces is Firefox's own tab-switch PiP (zen-prefs.js).
 * - If this Gecko has no occlusion API, falls back to the old trigger (focus left Zen
 *   for another app) and logs that once.
 *
 * Optional prefs (about:config, all optional):
 *   arcpip.enabled        bool  default true
 *   arcpip.delay_ms       int   default 300   wait before popping out (flicker guard)
 *   arcpip.require_audio  bool  default true  only fire if the tab is audibly playing
 *   arcpip.debug          bool  default false log to Browser Console
 *
 * Relies on Firefox internals (PictureInPicture.weakWinToBrowser / weakPipToWin /
 * isOriginatingBrowser). These are not a stable API and can change between releases.
 */

(() => {
  "use strict";

  const VERSION = "v2-out-of-sight";
  const PLAYER_TYPE = "Toolkit:PictureInPicture";
  const SUBFRAME_FALLBACK_MS = 400;

  const bool = (p, d) => Services.prefs.getBoolPref(p, d);
  const int = (p, d) => Services.prefs.getIntPref(p, d);
  const log = (...a) => bool("arcpip.debug", false) && console.log("[arc-pip]", ...a);

  function getPiP() {
    if (window.PictureInPicture) {
      return window.PictureInPicture;
    }
    for (const url of [
      "resource://gre/modules/PictureInPicture.sys.mjs",
      "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs",
    ]) {
      try {
        return ChromeUtils.importESModule(url).PictureInPicture;
      } catch (e) {}
    }
    console.error("[arc-pip] PictureInPicture module not found");
    return null;
  }

  let timer = null;
  // Set when we fire: which <browser> we asked to PiP, and which players already existed.
  let pending = null;

  function sendAutoToggle(bc) {
    try {
      bc?.currentWindowGlobal
        ?.getActor("PictureInPictureLauncher")
        .sendAsyncMessage("PictureInPicture:AutoToggle");
    } catch (e) {
      log("actor error", e);
    }
  }

  const hasOcclusion = typeof window.isFullyOccluded === "boolean";

  function isHidden() {
    if (!hasOcclusion) {
      // Fallback trigger: focus left Zen for another app.
      return !Services.focus.activeWindow;
    }
    return window.isFullyOccluded || window.windowState === window.STATE_MINIMIZED;
  }

  let hidden = false;

  // now: true/false from the fallback's deactivate/activate events; otherwise read it.
  function onVisibilityChange(now = isHidden()) {
    if (now === hidden) {
      return;
    }
    hidden = now;
    log(hidden ? "window out of sight" : "window visible again");
    if (hidden) {
      schedulePip();
    } else {
      onVisible();
    }
  }

  function schedulePip() {
    if (!bool("arcpip.enabled", true)) {
      return;
    }
    if (!bool("media.videocontrols.picture-in-picture.enabled", false)) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(maybePip, int("arcpip.delay_ms", 300));
  }

  function maybePip() {
    timer = null;

    // Visible again before the delay ran out (Space-switch flicker, quick ⌘Tab back).
    if (!isHidden()) {
      log("visible again, skipping");
      return;
    }

    const PiP = getPiP();
    if (!PiP) {
      return;
    }

    const tab = gBrowser.selectedTab;
    const browser = tab?.linkedBrowser;
    if (!browser?.browsingContext) {
      return;
    }
    if (bool("arcpip.require_audio", true) && !tab.hasAttribute("soundplaying")) {
      log("selected tab is not playing audio, skipping");
      return;
    }
    // Sending AutoToggle to a video that is already in PiP would toggle it OFF.
    if (PiP.isOriginatingBrowser(browser)) {
      log("tab already has a PiP player, skipping");
      return;
    }

    pending = {
      browser,
      before: new Set(Services.wm.getEnumerator(PLAYER_TYPE)),
    };

    // Top document first (YouTube etc.). Only try subframes (embedded players)
    // if nothing opened, so an iframe ad can't spawn a second player.
    const top = browser.browsingContext;
    sendAutoToggle(top);
    log("AutoToggle sent to top frame");

    setTimeout(() => {
      if (!pending || pending.browser !== browser || PiP.isOriginatingBrowser(browser)) {
        return;
      }
      const subframes = top.getAllBrowsingContextsInSubtree().filter(bc => bc !== top);
      subframes.forEach(sendAutoToggle);
      log(`AutoToggle sent to ${subframes.length} subframe(s)`);
    }, SUBFRAME_FALLBACK_MS);
  }

  function closePlayer(PiP, playerWin) {
    // Close through PictureInPicture so its bookkeeping (browserWeakMap etc.) stays correct.
    for (const actor of ChromeUtils.nondeterministicGetWeakMapKeys(PiP.weakPipToWin)) {
      if (PiP.weakPipToWin.get(actor) === playerWin) {
        PiP.closeSinglePipWindow({ reason: "Foregrounded", actorRef: actor });
        return;
      }
    }
    console.warn("[arc-pip] player actor not found, falling back to window.close()");
    playerWin.close();
  }

  function onVisible() {
    clearTimeout(timer);
    timer = null;
    if (!pending) {
      return;
    }
    const { browser, before } = pending;
    pending = null;

    // If the user came back on a different tab (e.g. via the player's
    // "back to tab" button), Firefox handles it natively.
    if (gBrowser.selectedBrowser !== browser) {
      return;
    }

    const PiP = getPiP();
    if (!PiP) {
      return;
    }
    for (const playerWin of Services.wm.getEnumerator(PLAYER_TYPE)) {
      if (before.has(playerWin) || playerWin.closed) {
        continue;
      }
      if (PiP.weakWinToBrowser.get(playerWin) === browser) {
        log("closing our player on return");
        closePlayer(PiP, playerWin);
      }
    }
  }

  function init() {
    console.info(`[arc-pip] ${VERSION} loaded`);
    // Without an occlusion API, "out of sight" falls back to "focus left Zen".
    const events = hasOcclusion
      ? ["occlusionstatechange", "sizemodechange"]
      : ["deactivate", "activate"];
    if (!hasOcclusion) {
      console.error("[arc-pip] window.isFullyOccluded not available; popping out on app switch instead");
    }
    // Fallback: deactivate starts the delay; maybePip re-reads focus once it runs out,
    // so a move to another Zen window (focus still inside Zen) is skipped.
    const handler = hasOcclusion
      ? () => onVisibilityChange()
      : e => onVisibilityChange(e.type === "deactivate");
    for (const type of events) {
      window.addEventListener(type, handler);
    }
    window.addEventListener(
      "unload",
      () => {
        clearTimeout(timer);
        pending = null;
        for (const type of events) {
          window.removeEventListener(type, handler);
        }
      },
      { once: true }
    );
    log("loaded in window");
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
