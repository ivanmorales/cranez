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

On a Mac with [Homebrew](https://brew.sh):

```
brew install ivanmorales/tap/cranez
cranez setup
```

`cranez setup` installs Zen if it's missing and opens it once so it creates its profile: click
**Open** if macOS asks, and allow the terminal to control Zen if asked, so Zen can quit by
itself. Then it installs the loader, scripts and prefs, and turns on the update watcher. If Zen
is open, it waits for you to quit it.

Two things only you can do, once per Mac:

- If macOS blocks writing into Zen.app, setup opens System Settings → Privacy & Security →
  App Management: turn on your terminal, reopen the terminal, run `cranez setup` again.
- Sign in to your Mozilla account in Zen, so your cranez prefs sync (setup reminds you).

Open Zen. The Browser Console (⌘⇧J) shows a `loaded` line for each script.

## Updating

Run `cranez setup` again any time: it pulls the latest scripts from GitHub and reinstalls them.
`brew upgrade cranez` is only needed when the `cranez` command itself changes, which is rare.

Zen updates replace the app and remove the loader from it. Zen keeps working; the scripts just
stop loading. The update watcher notices, re-adds the loader if macOS allows it, and otherwise
sends a notification; then run `cranez loader` and restart Zen.

## Prefs

Every script has optional prefs (in `about:config`), documented at the top of each file. Tuned
values travel between your Macs through your Mozilla account: setup turns on Firefox Sync for
every cranez pref (except `*.debug`, `devbar.visible` and `tabexpiry.run_now`, which are per-Mac).
Tune a pref on one Mac and it shows up on the others after the next sync.

`zen-prefs.js` only holds defaults for a brand-new Mac: setup adds each pref from it at most once
per profile, and only if the profile doesn't have it, so it never overwrites anything you've tuned. To change the
defaults, see Development.

## Commands

| | |
|---|---|
| `cranez setup` | everything; run again to update |
| `cranez status` | what's installed / out of date |
| `cranez loader` | re-add the loader after a Zen update |
| `cranez watch-on` / `watch-off` | background update helper |
| `cranez uninstall` | remove everything cranez added |
| `cranez --version` | version of the `cranez` command |

Overrides: `ZEN_APP=/path/to/Zen.app`, `ZEN_PROFILE=/path/to/profile`.

## Moving a Mac that already runs cranez from a clone

Firefox Sync only uploads a pref when it changes while Zen is running, so prefs that setup
writes don't sync by themselves. Once:

1. Sign in to your Mozilla account in Zen, on every Mac.
2. On every Mac: `brew install ivanmorales/tap/cranez`, then `cranez setup`. Setup keeps the
   prefs each Mac already has, moves the update watcher to its own copy, and says so.
3. On the Mac whose cranez prefs are tuned best, open Zen, change any cranez pref in
   about:config and change it back, then Settings → Sync → Sync Now. That uploads its values.
4. On each other Mac: open Zen, Sync Now.
5. Delete the old clones you don't develop in.

## Development

`cranez` keeps its own copy of this repo in `~/Library/Application Support/cranez/repo` and
resets it to `origin/main` on every setup; don't edit it. To work on cranez, use a clone:

```
CRANEZ_HOME=~/dev/tools/cranez cranez setup   # use the clone as-is (no fetch, no reset)
./cranez.sh install                             # or run the engine directly from the clone
```

To change the defaults in `zen-prefs.js`: in the clone, tune the prefs in about:config, quit Zen,
run `./cranez.sh capture`, then commit and push.

A new script pref syncs only if its header line follows the `" *   name  type ..."` format; the
installer test counts the synced prefs, so adding one is a deliberate change to that count.

### Releasing the `cranez` command

Only needed when `bin/cranez` changes:

1. Bump `CRANEZ_VERSION` in `bin/cranez`, commit, push.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. `curl -sL https://github.com/ivanmorales/cranez/archive/refs/tags/vX.Y.Z.tar.gz | shasum -a 256`
4. In [ivanmorales/homebrew-tap](https://github.com/ivanmorales/homebrew-tap), update `url` and
   `sha256` in `Formula/cranez.rb`, commit, push.

## Tests

```
bash tests/run.sh
```

Runs without Zen or macOS: syntax checks, shellcheck, a simulated 3-monitor desktop for
`pip-swipe`, a mixed-tab simulation for `tab-expiry`, and end-to-end runs of the installer,
`cranez.sh setup` and the `cranez` command on a fake Mac (stubbed `brew`, `open`, `osascript`,
`launchctl`, and a local repo standing in for GitHub). In-browser behaviour still needs a manual
check in Zen; see `CLAUDE.md`.

## Layout

```
bin/cranez                the command Homebrew installs (keeps a checkout, forwards to cranez.sh)
cranez.sh                 installer / engine
zen-prefs.js              defaults for a brand-new Mac
scripts/*.uc.js           the scripts
tests/                    tests (bash tests/run.sh)
vendor/fx-autoconfig/     pinned loader (MPL-2.0; version in COMMIT)
```
