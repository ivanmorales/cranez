# cranez: notes for Claude Code

Arc browser features rebuilt for Zen (Firefox-based) on macOS and Arch Linux, as fx-autoconfig
user scripts. Owner uses it daily on multiple Macs with 3 monitors and a Magic Mouse; Zen's top
toolbar is off. Also on a PearOS (Arch) box with zen-browser-bin.

## How it runs

- `vendor/fx-autoconfig/program/*` goes into `Zen.app/Contents/Resources` (wiped by every Zen
  update; `./cranez.sh loader` restores it). `vendor/fx-autoconfig/profile/chrome/utils` and
  `scripts/*.uc.js` go into `<profile>/chrome/`.
- Each `.uc.js` runs with chrome privileges in the window(s) its `@include` header names
  (`main` = every browser window; `pip-swipe` targets the PiP player window).
- `bin/cranez` (installed by the Homebrew tap `ivanmorales/homebrew-tap`) keeps a managed checkout
  in `~/Library/Application Support/cranez/repo`, resets it to `origin/main` on `cranez setup`,
  and forwards every command to that checkout's `cranez.sh` (with `CRANEZ_CLI_NAME=cranez`, so
  messages say `cranez <cmd>`). `CRANEZ_HOME=<clone>` uses a dev clone as-is. Keep `bin/cranez`
  thin: logic belongs in `cranez.sh`, which ships with `setup`, not with a brew release.
- Arch Linux: `cranez.sh setup` run from a git clone builds `packaging/arch/PKGBUILD` (source =
  that clone's working tree, not GitHub; build dirs in a temp folder so the repo stays clean)
  and installs `cranez-git` with pacman. The package owns the loader in Zen's folder
  (`/opt/zen-browser-bin`, found by `cranez.sh app-dir`), so Zen upgrades keep it: no watcher.
  `/usr/bin/cranez` runs `/usr/share/cranez/cranez.sh`; `cranez update` pulls the clone recorded
  in `/usr/share/cranez/.source` and re-runs setup. `CRANEZ_OS=Linux` fakes Linux in tests.
- Prefs: `zen-prefs.js` is defaults only (`install` never overwrites an existing pref); tuned
  values travel via Firefox Sync, which `install` turns on for every pref documented in the
  script headers (minus `*.debug`, `devbar.visible`, `tabexpiry.run_now`).
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
  `${x,,}`, `sed -i`, `readlink -f`; POSIX awk only. Keep it shellcheck-clean. Write `${VAR}…`,
  not `$VAR…`: bash 3.2 reads the ellipsis bytes as part of the variable name. Platform splits
  go through `$OS` (Darwin/Linux).
- Don't edit `vendor/` except to deliberately update fx-autoconfig (then update `COMMIT`).
- Default to small, focused changes; the owner tests each change live in Zen.

## Tests

`bash tests/run.sh` (CI runs it too). Covers: syntax of all scripts, shellcheck,
`arc-pip-on-blur` popping out only when the window is out of sight, `pip-swipe` gestures on a
fake 3-monitor desktop (fling caps, monitor hops, corner snap, never off screen), `tab-expiry`
keep/close rules, `little-arc` (external links in the current space's container, chromeless
little window, drag strip, Linux variants), the installer end to end on a fake Mac layout,
`tests/linux.test.sh` on a fake Arch box (setup builds/installs the package via stubbed
`makepkg`/`pacman`/`sudo` that run the real `package()`, update, uninstall), and `cranez.sh
setup` + `bin/cranez` on a shared fake Mac (`tests/fake-mac.sh`: stubbed `brew`, `open`,
`osascript`, `launchctl`, an App-Management-blocking `cp`, a local bare repo as GitHub).
Add a test case whenever you change behaviour those suites cover.

Not covered (verify manually in Zen): anything touching real Firefox internals, macOS cursor
calls (js-ctypes), App Management/launchd, real DevTools, Zen's first-run profile creation and
the Gatekeeper prompt, Firefox Sync carrying cranez prefs, a real `brew install` from the tap,
and on Linux: a real makepkg/pacman, libX11 cursor calls, `beginWindowMove`, Wayland vs X11.

## Firefox/Zen internals each script depends on (first suspects after a Zen update)

- **arc-pip-on-blur**: `PictureInPicture` module (`isOriginatingBrowser`, `weakWinToBrowser`,
  `weakPipToWin`, `closeSinglePipWindow`), `PictureInPictureLauncher` actor message
  `PictureInPicture:AutoToggle` (sending it to a video already in PiP toggles it OFF, hence the
  guard), `ChromeUtils.nondeterministicGetWeakMapKeys`, macOS occlusion via
  `window.isFullyOccluded` + `occlusionstatechange` and `windowState` + `sizemodechange`
  (falls back to `deactivate`/`activate` if `isFullyOccluded` is missing).
- **pip-swipe**: runs in `chrome://global/content/pictureinpicture/player.xhtml`;
  `nsIScreenManager`; js-ctypes → `NSEvent.mouseLocation`, `CGWarpMouseCursorPosition`; Linux:
  `libX11.so.6` `XQueryPointer`/`XWarpPointer` (root window, device px ÷ `desktopToDeviceScale`),
  `Services.appinfo.OS`, `nsIGfxInfo.windowProtocol` (off on "wayland": `moveTo` can't work).
  Firefox doesn't expose macOS momentum phase, so momentum is detected heuristically (steadily
  decaying deltas) and then swallowed.
- **little-arc**: `window.browserDOMWindow` (its `openURI` is read-only in current Gecko, so the
  whole object is replaced with a forwarding Proxy), `nsIBrowserDOMWindow.OPEN_EXTERNAL`,
  `gZenWorkspaces.getCurrentSpaceContainerId()` plus `window.arguments[5]` (userContextId) and
  `[8]` (triggeringPrincipal) as `browser-init.js` reads them for the little window's container,
  `CustomTitlebar.allowedBy("non-popup", …)` (from `tab-bar-visibility.js`; little windows ignore
  that veto to drop the macOS title bar), Zen's `#zen-appcontent-navbar-wrapper` (URL bar row),
  `BrowserWindowTracker.getTopWindow`, `gBrowser.adoptTab`, js-ctypes cursor position (Linux:
  libX11; none on Wayland), Linux drag strip → `window.beginWindowMove(mousedown)`. Little
  windows are popup-style (`toolbar.visible == false`); placement is encoded in `window.name`.
- **tab-expiry**: `tab.lastAccessed`, Places DB (`moz_bookmarks` ⋈ `moz_places`),
  `SessionStore.getTabState` (unloaded tabs report about:blank), `browser.asyncPermitUnload`,
  Zen tab attributes `zen-essential`, `zen-glance-tab`, `zen-empty-tab`, `zen-workspace-id`.
- **dev-bar**: devtools loader → `gDevTools.showToolboxForTab / getToolboxForTab /
  closeToolboxForTab`, `toolbox.nodePicker`; reserved XUL `<key>` for ^D; positions a fixed bar
  over the selected `.browserStack` and pads it via `[devbar-pushed]`.
- **cranez.sh setup / prefs sync**: Homebrew cask `zen`, bundle id `app.zen-browser.zen`
  (AppleScript quit after first-run profile creation), `profiles.ini` `[Install…] Default=`,
  Firefox Sync prefs `services.sync.prefs.sync.<name>` and
  `services.sync.prefs.dangerously_allow_arbitrary`, `<profile>/signedInUser.json` (signed in).

## Decisions already made (don't redo)

- Tab-switch PiP uses Firefox's native pref (in `zen-prefs.js`); `arc-pip-on-blur` only handles
  the window going out of sight (like Arc: not on focusing an app on another monitor).
- Copy-URL shortcut is Zen's built-in ⌘⇧C; dev-bar doesn't add one.
- dev-bar v1 was inserted into `.browserContainer`; Zen lays that out differently, so v2 uses a
  fixed-position bar measured to the page area plus padding on `.browserStack`.
- The "Little Zen" Sine mod that inspired little-arc no longer exists; this is our own version.
- Distribution is a Homebrew tap; tuned prefs travel via Firefox Sync, not git (no capture/push
  from user Macs); Zen's quarantine flag is never stripped (the owner clicks Gatekeeper's Open).
- Extensions can't do most of this (can't start PiP, move windows, catch external links, or open
  DevTools), which is why it's privileged scripts plus a loader.
