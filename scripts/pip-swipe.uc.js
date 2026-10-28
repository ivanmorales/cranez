// ==UserScript==
// @name           pip-swipe
// @description    Arc-style swipe-to-move for the Picture-in-Picture window: fling, corner snapping, screen hopping (PoC)
// @cranez-name    PiP Swiper
// @cranez-blurb   fling the PiP window anywhere: corners, monitors, never lost
// @include        chrome://global/content/pictureinpicture/player.xhtml
// ==/UserScript==

/*
 * How it works
 * - Runs inside the PiP player window only (see @include above).
 * - Magic Mouse / trackpad swipes arrive as pixel-precise "wheel" events. While your
 *   finger is down, each one moves the window, and the cursor moves with it so it stays
 *   over the player. Regular notched scroll wheels are ignored.
 * - Lifting your finger: macOS keeps sending "momentum" scroll events for a second or
 *   more, and Firefox doesn't mark them as momentum. The script spots them by their
 *   steady decay, takes over right away, and swallows the rest. That is what removes
 *   the multi-second wait before the snap.
 * - Fling rules:
 *     * A fling never leaves the monitor the window is on: the farthest it can go is
 *       that monitor's edge.
 *     * If the window is already at an edge and you fling toward that edge, it hops to
 *       the facing edge of the neighbouring monitor (if there is one).
 *     * Wherever it lands, it snaps to that monitor's nearest corner if close enough.
 *   Dragging with your finger still on the mouse can still carry it across monitors.
 * - The window never leaves the visible screen area (menu bar and Dock excluded), not even
 *   mid-swipe or mid-momentum. At an outer edge it stops and slides along the edge; where
 *   two monitors touch it can cross over.
 *
 * Optional prefs (about:config):
 *   pipswipe.enabled           bool  default true
 *   pipswipe.invert            bool  default false  true if macOS "Natural scrolling" is OFF
 *   pipswipe.cursor_follows    bool  default true   move the cursor with the window while dragging
 *   pipswipe.settle_ms         int   default 250    duration of the final fling/snap animation
 *   pipswipe.fling_ms          int   default 180    how far a fling carries (still capped at the edge)
 *   pipswipe.fling_min_speed   int   default 300    px/second needed to count as a fling
 *   pipswipe.snap_radius       int   default 160    px from a corner that triggers a snap
 *   pipswipe.margin            int   default 16     gap between window and screen edge
 *   pipswipe.edge_tolerance    int   default 24     how close to an edge counts as "at the edge"
 *   pipswipe.momentum_events   int   default 4      decaying events needed to detect finger lift
 *   pipswipe.end_ms            int   default 90     quiet time that ends a slow (no-fling) drag
 *   pipswipe.debug             bool  default false  log to Browser Console
 */

(() => {
  "use strict";

  const VERSION = "v3";
  const bool = (p, d) => Services.prefs.getBoolPref(p, d);
  const int = (p, d) => Services.prefs.getIntPref(p, d);
  const log = (...a) => bool("pipswipe.debug", false) && console.log("[pip-swipe]", ...a);

  console.info(`[pip-swipe] ${VERSION} loaded in PiP player`);

  // ---------------------------------------------------------------------------
  // Geometry. Everything is in Gecko desktop pixels (macOS points):
  // origin at the top-left of the primary display, y pointing down.
  // ---------------------------------------------------------------------------

  const screenManager = Cc["@mozilla.org/gfx/screenmanager;1"].getService(Ci.nsIScreenManager);

  function rectOf(screen, method = "GetAvailRectDisplayPix") {
    const l = {},
      t = {},
      w = {},
      h = {};
    screen[method](l, t, w, h);
    return { x: l.value, y: t.value, w: w.value, h: h.value };
  }

  const contains = (r, p) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
  const clamp = (v, lo, hi) => (hi < lo ? lo : Math.min(hi, Math.max(lo, v)));
  const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

  const scale = () => window.devicePixelRatio / window.desktopToDeviceScale;

  function windowPos() {
    const s = scale();
    return { x: window.screenX * s, y: window.screenY * s };
  }

  function windowSize() {
    const s = scale();
    return { w: window.outerWidth * s, h: window.outerHeight * s };
  }

  function moveWindow(x, y) {
    const s = scale();
    window.moveTo(Math.round(x / s), Math.round(y / s));
  }

  // The screen containing point p, or null if p is on no screen.
  function screenAt(p) {
    const screen = screenManager.screenForRect(Math.round(p.x), Math.round(p.y), 1, 1);
    return contains(rectOf(screen, "GetRectDisplayPix"), p) ? screen : null;
  }

  // Allowed top-left range for the window on a screen (avail rect minus margin).
  function boundsOn(screen) {
    const { w, h } = windowSize();
    const r = rectOf(screen);
    const m = int("pipswipe.margin", 16);
    return { minX: r.x + m, maxX: r.x + r.w - w - m, minY: r.y + m, maxY: r.y + r.h - h - m };
  }

  // Is this point inside the visible area (avail rect) of any monitor?
  function pointVisible(x, y) {
    const screen = screenManager.screenForRect(Math.floor(x), Math.floor(y), 1, 1);
    return contains(rectOf(screen), { x, y });
  }

  // Is the whole window visible with its top-left at (x, y)? Checks corners, edge
  // midpoints and centre, so a window straddling two touching monitors is fine but one
  // hanging past an outer edge, into a gap, or under the menu bar is not.
  function rectVisible(x, y) {
    const { w, h } = windowSize();
    const xs = [x, x + w / 2, x + w - 1];
    const ys = [y, y + h / 2, y + h - 1];
    return xs.every(px => ys.every(py => pointVisible(px, py)));
  }

  // Largest t in [0, 1] for which ok(t) holds, assuming ok(0) holds.
  function furthest(ok) {
    if (ok(1)) {
      return 1;
    }
    let lo = 0,
      hi = 1;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  // Move by (dx, dy) as far as possible without any part of the window leaving the
  // visible area. Blocked on one axis, it keeps sliding along the other.
  function constrainMove(from, dx, dy) {
    const full = { x: from.x + dx, y: from.y + dy };
    if (rectVisible(full.x, full.y)) {
      return full;
    }
    const x = from.x + dx * furthest(t => rectVisible(from.x + dx * t, from.y));
    const y = from.y + dy * furthest(t => rectVisible(x, from.y + dy * t));
    return { x, y };
  }

  // Pull the window fully onto the monitor under its centre (or the primary one).
  function bringOnScreen(p) {
    const { w, h } = windowSize();
    const screen = screenAt({ x: p.x + w / 2, y: p.y + h / 2 }) ?? screenManager.primaryScreen;
    const b = boundsOn(screen);
    return { x: clamp(p.x, b.minX, b.maxX), y: clamp(p.y, b.minY, b.maxY) };
  }

  // The monitor directly beyond one edge of `screen`, probing along that edge.
  function neighbour(screen, dir, near) {
    const r = rectOf(screen, "GetRectDisplayPix");
    const along = dir === "left" || dir === "right"
      ? [near.y, r.y + r.h / 2, r.y + r.h / 4, r.y + (3 * r.h) / 4, r.y + 8, r.y + r.h - 8]
      : [near.x, r.x + r.w / 2, r.x + r.w / 4, r.x + (3 * r.w) / 4, r.x + 8, r.x + r.w - 8];
    for (const a of along) {
      const p =
        dir === "left" ? { x: r.x - 2, y: a } :
        dir === "right" ? { x: r.x + r.w + 1, y: a } :
        dir === "up" ? { x: a, y: r.y - 2 } :
        { x: a, y: r.y + r.h + 1 };
      const s = screenAt(p);
      if (s && !sameRect(rectOf(s, "GetRectDisplayPix"), r)) {
        return s;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // macOS cursor: read with NSEvent.mouseLocation, move with CGWarpMouseCursorPosition
  // ---------------------------------------------------------------------------

  let mac = null;

  function macCursor() {
    if (mac !== null) {
      return mac;
    }
    try {
      const ctypes =
        globalThis.ctypes ?? ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs").ctypes;
      const Point = new ctypes.StructType("Point", [{ x: ctypes.double }, { y: ctypes.double }]);

      const objc = ctypes.open("/usr/lib/libobjc.A.dylib");
      const id = ctypes.voidptr_t;
      const getClass = objc.declare("objc_getClass", ctypes.default_abi, id, ctypes.char.ptr);
      const getSel = objc.declare("sel_registerName", ctypes.default_abi, id, ctypes.char.ptr);
      const msgSendPoint = objc.declare("objc_msgSend", ctypes.default_abi, Point, id, id);
      const NSEvent = getClass("NSEvent");
      const mouseLocation = getSel("mouseLocation");

      const cg = ctypes.open("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
      const warp = cg.declare("CGWarpMouseCursorPosition", ctypes.default_abi, ctypes.int32_t, Point);

      mac = {
        getCursor() {
          const p = msgSendPoint(NSEvent, mouseLocation);
          const primary = rectOf(screenManager.primaryScreen, "GetRectDisplayPix");
          return { x: p.x, y: primary.h - p.y };
        },
        warpCursor(x, y) {
          const pt = new Point();
          pt.x = x;
          pt.y = y;
          warp(pt);
        },
      };
    } catch (e) {
      console.error("[pip-swipe] cursor control unavailable; window will move without the cursor", e);
      mac = false;
    }
    return mac;
  }

  // ---------------------------------------------------------------------------
  // Gesture state machine:  idle -> drag -> (release) -> coast -> idle
  //   drag:  finger on the mouse, window follows it
  //   coast: finger lifted; our animation runs and macOS momentum events are swallowed
  // ---------------------------------------------------------------------------

  let mode = "idle";
  let pos = null; // window top-left while dragging
  let startPos = null; // where the drag began
  let pending = { dx: 0, dy: 0 };
  let samples = []; // { t, dx, dy } for release velocity
  let mags = []; // recent per-event movement sizes, for momentum detection
  let coastLastMag = 0;
  let frame = 0;
  let quietTimer = 0;
  let anim = 0;

  function cancelAnimation() {
    if (anim) {
      cancelAnimationFrame(anim);
      anim = 0;
    }
  }

  function startDrag() {
    cancelAnimation();
    mode = "drag";
    pos = windowPos();
    if (!rectVisible(pos.x, pos.y)) {
      pos = bringOnScreen(pos);
      moveWindow(pos.x, pos.y);
      log("window was partly off-screen; moved it back", pos);
    }
    startPos = { ...pos };
    pending = { dx: 0, dy: 0 };
    samples = [];
    mags = [];
    log("drag start at", pos);
  }

  function flush() {
    frame = 0;
    if (!pos || (!pending.dx && !pending.dy)) {
      return;
    }
    const { dx, dy } = pending;
    pending = { dx: 0, dy: 0 };
    const next = constrainMove(pos, dx, dy);
    const moved = { x: next.x - pos.x, y: next.y - pos.y };
    pos = next;
    if (!moved.x && !moved.y) {
      return; // pinned against an edge
    }
    moveWindow(pos.x, pos.y);

    // Cursor follows only by what the window actually moved, so it stops at edges too.
    if (bool("pipswipe.cursor_follows", true)) {
      const m = macCursor();
      if (m) {
        const c = m.getCursor();
        m.warpCursor(c.x + moved.x, c.y + moved.y);
      }
    }
  }

  // Momentum events shrink steadily, event after event. A finger on the mouse doesn't.
  function looksLikeMomentum() {
    const n = int("pipswipe.momentum_events", 4);
    if (mags.length < n + 1) {
      return false;
    }
    const run = mags.slice(-(n + 1));
    if (run[0] < 3) {
      return false; // too slow to be a fling
    }
    for (let i = 1; i < run.length; i++) {
      const ratio = run[i] / run[i - 1];
      if (!(ratio < 1 && ratio >= 0.6)) {
        return false;
      }
    }
    return true;
  }

  function releaseVelocity() {
    if (!samples.length) {
      return { x: 0, y: 0 };
    }
    const last = samples[samples.length - 1].t;
    const recent = samples.filter(sm => last - sm.t <= 60);
    const span = Math.max(16, last - recent[0].t);
    const sx = recent.reduce((a, sm) => a + sm.dx, 0);
    const sy = recent.reduce((a, sm) => a + sm.dy, 0);
    return { x: sx / span, y: sy / span }; // px per ms
  }

  function restingPlace(released, v) {
    const { w, h } = windowSize();
    const centerOf = p => ({ x: p.x + w / 2, y: p.y + h / 2 });
    const c = centerOf(released);

    const screen =
      screenAt(c) ?? screenAt(centerOf(startPos ?? released)) ?? screenManager.primaryScreen;
    let box = boundsOn(screen);
    let target;
    let hop = null;

    const speed = Math.hypot(v.x, v.y) * 1000; // px per second
    if (speed >= int("pipswipe.fling_min_speed", 300)) {
      const reach = int("pipswipe.fling_ms", 180);
      const horizontal = Math.abs(v.x) >= Math.abs(v.y);
      const dir = horizontal ? (v.x < 0 ? "left" : "right") : v.y < 0 ? "up" : "down";
      const tol = int("pipswipe.edge_tolerance", 24);
      const atEdge = {
        left: released.x <= box.minX + tol,
        right: released.x >= box.maxX - tol,
        up: released.y <= box.minY + tol,
        down: released.y >= box.maxY - tol,
      }[dir];

      const next = atEdge ? neighbour(screen, dir, c) : null;
      if (next) {
        // Already at this monitor's edge: hop to the facing edge of the next monitor.
        box = boundsOn(next);
        hop = dir;
        const projX = clamp(released.x + v.x * reach, box.minX, box.maxX);
        const projY = clamp(released.y + v.y * reach, box.minY, box.maxY);
        target =
          dir === "left" ? { x: box.maxX, y: projY } :
          dir === "right" ? { x: box.minX, y: projY } :
          dir === "up" ? { x: projX, y: box.maxY } :
          { x: projX, y: box.minY };
      } else {
        // Normal fling: projected, but never past this monitor's edges.
        target = {
          x: clamp(released.x + v.x * reach, box.minX, box.maxX),
          y: clamp(released.y + v.y * reach, box.minY, box.maxY),
        };
      }
    } else {
      // Slow release: just keep it fully on the monitor it's on.
      target = { x: clamp(released.x, box.minX, box.maxX), y: clamp(released.y, box.minY, box.maxY) };
    }

    // Corner snap on whichever monitor we ended up on.
    const radius = int("pipswipe.snap_radius", 160);
    let best = null;
    for (const [cx, cy] of [
      [box.minX, box.minY],
      [box.maxX, box.minY],
      [box.minX, box.maxY],
      [box.maxX, box.maxY],
    ]) {
      const d = Math.hypot(target.x - cx, target.y - cy);
      if (d <= radius && (!best || d < best.d)) {
        best = { d, x: cx, y: cy };
      }
    }
    if (best) {
      target = { x: best.x, y: best.y };
    }
    return { ...target, snapped: !!best, hop, speed: Math.round(speed) };
  }

  function animateTo(from, to) {
    if (!rectVisible(to.x, to.y)) {
      to = bringOnScreen(to); // safety net; restingPlace should already guarantee this
    }
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < 1) {
      return;
    }
    const duration = Math.max(1, int("pipswipe.settle_ms", 250));
    const t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / duration);
      const e = 1 - Math.pow(1 - k, 3); // ease-out cubic
      moveWindow(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
      anim = k < 1 ? requestAnimationFrame(step) : 0;
    };
    anim = requestAnimationFrame(step);
  }

  function release(reason) {
    if (frame) {
      cancelAnimationFrame(frame);
      flush();
    }
    if (!pos) {
      mode = "idle";
      return;
    }
    const released = pos;
    const v = releaseVelocity();
    const target = restingPlace(released, v);
    log(`release (${reason})`, { released, velocity: v, target });

    mode = reason === "momentum" ? "coast" : "idle";
    coastLastMag = mags.length ? mags[mags.length - 1] : 0;
    pos = null;
    startPos = null;
    samples = [];
    mags = [];
    animateTo(released, target);
  }

  function onQuiet() {
    quietTimer = 0;
    if (mode === "drag") {
      release("quiet");
    }
    mode = "idle";
  }

  function onWheel(e) {
    if (!bool("pipswipe.enabled", true)) {
      return;
    }
    if (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
      return; // notched wheel mice: leave alone
    }
    if (window.windowState === window.STATE_FULLSCREEN) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    // With natural scrolling, the window moves opposite to the scroll delta.
    const sign = bool("pipswipe.invert", false) ? 1 : -1;
    const s = scale();
    const dx = sign * e.deltaX * s;
    const dy = sign * e.deltaY * s;
    const mag = Math.hypot(dx, dy);

    clearTimeout(quietTimer);
    quietTimer = setTimeout(onQuiet, int("pipswipe.end_ms", 90));

    if (mode === "coast") {
      // Still decaying: leftover macOS momentum. Swallow it.
      if (mag <= coastLastMag * 1.02 + 0.5) {
        coastLastMag = mag;
        return;
      }
      // Growing again: the finger is back on the mouse. Start a new drag.
      log("new swipe during coast");
      startDrag();
    } else if (mode === "idle") {
      startDrag();
    }

    pending.dx += dx;
    pending.dy += dy;
    const now = performance.now();
    samples.push({ t: now, dx, dy });
    samples = samples.filter(sm => now - sm.t <= 120);
    mags.push(mag);
    if (mags.length > 12) {
      mags.shift();
    }

    if (looksLikeMomentum()) {
      release("momentum");
      return;
    }
    if (!frame) {
      frame = requestAnimationFrame(flush);
    }
  }

  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener(
    "unload",
    () => {
      clearTimeout(quietTimer);
      cancelAnimation();
      if (frame) {
        cancelAnimationFrame(frame);
      }
    },
    { once: true }
  );
})();
