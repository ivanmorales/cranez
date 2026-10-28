# cranez: notes for Claude Code

Arc browser features rebuilt for Zen (Firefox-based) on macOS, as fx-autoconfig user scripts.
Owner uses it daily on multiple Macs with 3 monitors and a Magic Mouse; Zen's top toolbar is off.

## How it runs

- `vendor/fx-autoconfig/program/*` goes into `Zen.app/Contents/Resources` (wiped by every Zen
  update; `./cranez.sh loader` restores it). `vendor/fx-autoconfig/profile/chrome/utils` and
  `scripts/*.uc.js` go into `<profile>/chrome/`.
- Each `.uc.js` runs with chrome privileges in the window(s) its `@include` header names
  (`main` = every browser window; `pip-swipe` targets the PiP player window).
- After changing a script on a Mac: copy it in (or `./cranez.sh install` with Zen quit), then
  `about:support` → Clear Startup Cache. Debug in the Browser Console (⌘⇧J).

## Conventions

- **Stable file names. Never add version suffixes** to file names (the owner asked for this).
  Each script has `const VERSION` and logs `[name] VERSION loaded` via `console.info` at
  startup; bump VERSION on any behaviour change so the owner can confirm what's running.
- One pref namespace per script, all optional with defaults, documented in the header comment:
  `arcpip.*`, `pipswipe.*`, `arclittle.*`, `tabexpiry.*`, `devbar.*`. Each has a `*.debug` pref
  that gates `console.log`.
- Fail safe: a script must never break the browser window. Guard Firefox/Zen internals with
  try/catch and log with the `[name]` prefix.
- `cranez.sh` runs on macOS's `/bin/bash` 3.2 and BSD tools: no associative arrays, `mapfile`,
  `${x,,}`, `sed -i`, `readlink -f`; POSIX awk only. Keep it shellcheck-clean.
- Don't edit `vendor/` except to deliberately update fx-autoconfig (then update `COMMIT`).
- Default to small, focused changes; the owner tests each change live in Zen.

## Tests

`bash tests/run.sh` (CI runs it too). Covers: syntax of all scripts, shellcheck, `pip-swipe`
gestures on a fake 3-monitor desktop (fling caps, monitor hops, corner snap, never off screen),
`tab-expiry` keep/close rules, and the installer end to end on a fake Mac layout.
Add a test case whenever you change behaviour those suites cover.

Not covered (verify manually in Zen): anything touching real Firefox internals, macOS cursor
calls (js-ctypes), App Management/launchd, real DevTools.

## Firefox/Zen internals each script depends on (first suspects after a Zen update)

- **arc-pip-on-blur**: `PictureInPicture` module (`isOriginatingBrowser`, `weakWinToBrowser`,
  `weakPipToWin`, `closeSinglePipWindow`), `PictureInPictureLauncher` actor message
  `PictureInPicture:AutoToggle` (sending it to a video already in PiP toggles it OFF, hence the
  guard), `ChromeUtils.nondeterministicGetWeakMapKeys`.
- **pip-swipe**: runs in `chrome://global/content/pictureinpicture/player.xhtml`;
  `nsIScreenManager`; js-ctypes → `NSEvent.mouseLocation`, `CGWarpMouseCursorPosition`.
  Firefox doesn't expose macOS momentum phase, so momentum is detected heuristically (steadily
  decaying deltas) and then swallowed.
- **little-arc**: `window.browserDOMWindow` (its `openURI` is read-only in current Gecko, so the
  whole object is replaced with a forwarding Proxy), `nsIBrowserDOMWindow.OPEN_EXTERNAL`,
  `BrowserWindowTracker.getTopWindow`, `gBrowser.adoptTab`, js-ctypes cursor position. Little
  windows are popup-style (`toolbar.visible == false`); placement is encoded in `window.name`.
- **tab-expiry**: `tab.lastAccessed`, Places DB (`moz_bookmarks` ⋈ `moz_places`),
  `SessionStore.getTabState` (unloaded tabs report about:blank), `browser.asyncPermitUnload`,
  Zen tab attributes `zen-essential`, `zen-glance-tab`, `zen-empty-tab`, `zen-workspace-id`.
- **dev-bar**: devtools loader → `gDevTools.showToolboxForTab / getToolboxForTab /
  closeToolboxForTab`, `toolbox.nodePicker`; reserved XUL `<key>` for ^D; positions a fixed bar
  over the selected `.browserStack` and pads it via `[devbar-pushed]`.

## Decisions already made (don't redo)

- Tab-switch PiP uses Firefox's native pref (in `zen-prefs.js`); `arc-pip-on-blur` only handles
  switching to another app.
- Copy-URL shortcut is Zen's built-in ⌘⇧C; dev-bar doesn't add one.
- dev-bar v1 was inserted into `.browserContainer`; Zen lays that out differently, so v2 uses a
  fixed-position bar measured to the page area plus padding on `.browserStack`.
- The "Little Zen" Sine mod that inspired little-arc no longer exists; this is our own version.
- Extensions can't do most of this (can't start PiP, move windows, catch external links, or open
  DevTools), which is why it's privileged scripts plus a loader.
