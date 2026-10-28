# cranez

Arc's best features, rebuilt for [Zen](https://zen-browser.app) on macOS.

| Script | What it does |
|---|---|
| `arc-pip-on-blur.uc.js` | A playing video pops into Picture-in-Picture when you switch to another app, and goes back when you return |
| `pip-swipe.uc.js` | Swipe the PiP window around with a Magic Mouse or trackpad: fling, snap to corners, hop to the next monitor, never off screen |
| `little-arc.uc.js` | Links opened from other apps (Slack, terminal…) open in a small window on the monitor you clicked from; ⌘O moves it into Zen |
| `tab-expiry.uc.js` | Closes tabs you haven't opened in 24h, unless they're pinned, an Essential, bookmarked, playing audio, or have unsaved input |
| `dev-bar.uc.js` | ^D toggles a bar with the tab's URL plus Copy, Console, Network and Inspect |

Tab-switch PiP is Firefox's own feature; `zen-prefs.js` turns it on. Copy URL (⌘⇧C) is built into Zen.

These are [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) user scripts: they run
inside Zen with full browser privileges, which is what lets them do things an extension can't.

## Install

1. Install Zen, open it once, quit it (⌘Q).
2. `./cranez.sh install`
3. If macOS blocks writing into Zen.app: System Settings → Privacy & Security → App Management →
   turn on your terminal, reopen the terminal, run `./cranez.sh loader`.

Open Zen. The Browser Console (⌘⇧J) shows a `loaded` line for each script.

## After a Zen update

Zen updates replace the app and remove the loader from it. Zen keeps working; the scripts just
stop loading until you run:

```
./cranez.sh loader
```

and restart Zen. Scripts and prefs live in your profile and survive updates.
`./cranez.sh watch-on` adds a background helper that notices updates and either restores the
loader or sends you a notification.

## Prefs

Every script has optional prefs (in `about:config`), documented at the top of each file.
`zen-prefs.js` holds the values `install` writes into Zen; they're applied once per install,
so later tweaks in `about:config` stick. To carry tuned values to another Mac:

```
./cranez.sh capture      # quit Zen first; saves arcpip.* arclittle.* pipswipe.* tabexpiry.* devbar.*
git commit -am "prefs"
# other Mac:
./cranez.sh install
```

## Commands

| | |
|---|---|
| `install` | loader + scripts + prefs (quit Zen first) |
| `loader` | re-add the loader after a Zen update |
| `status` | what's installed / out of date |
| `capture` | save tuned prefs into `zen-prefs.js` |
| `watch-on` / `watch-off` | background update helper |
| `uninstall` | remove everything cranez added |

Overrides: `ZEN_APP=/path/to/Zen.app`, `ZEN_PROFILE=/path/to/profile`.

## Tests

```
bash tests/run.sh
```

Runs without Zen or macOS: syntax checks, shellcheck, a simulated 3-monitor desktop for
`pip-swipe`, a mixed-tab simulation for `tab-expiry`, and an end-to-end run of the installer on a
fake Mac layout. In-browser behaviour still needs a manual check in Zen; see `CLAUDE.md`.

## Layout

```
cranez.sh                 installer
zen-prefs.js              prefs written on install
scripts/*.uc.js           the scripts
tests/                    tests (bash tests/run.sh)
vendor/fx-autoconfig/     pinned loader (MPL-2.0; version in COMMIT)
```
