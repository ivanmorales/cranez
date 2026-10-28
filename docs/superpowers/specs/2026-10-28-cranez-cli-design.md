# cranez CLI: one-command Zen setup via Homebrew

Date: 2026-10-28. Status: draft for owner review.

## Intent

The owner runs cranez daily on several Macs. Today a new Mac means: install Zen by hand, open it
once and quit (to create a profile), clone this repo, run `./cranez.sh install`, maybe
`watch-on`. The goal is:

```
brew install ivanmorales/tap/cranez
cranez setup
```

and Zen ends up with every cranez feature working. Running `cranez setup` again on an
already-set-up Mac is how that Mac picks up the newest scripts.

The owner's other settings already travel through their Mozilla account (Firefox Sync); cranez
exists only for the functionality Zen lacks.

## Decided by the owner

- **Distribution: a Homebrew tap.** Repo `ivanmorales/homebrew-tap`, formula `cranez`.
  `ivanmorales/cranez` is public, so no auth is needed to install or pull.
- **`cranez setup` does everything**, including the two things done by hand today: installing
  Zen and creating its profile (no "open Zen once and quit" as a separate manual step).
- **Scripts come from the git repo:** `setup` pulls the latest from GitHub.
- **Tuned cranez prefs travel through Firefox Sync**, like the owner's other settings, not through
  git. No commit/push from any Mac; no git credentials needed.
- **Keep macOS's "downloaded from the internet" confirmation** on Zen's first launch. Setup does
  not strip the quarantine flag.
- **Existing Macs move over by hand once** (see Migration); no automatic adoption of old clones.

## Proposed and accepted by the owner (in a playback)

- `cranez setup` order: get latest repo → install Zen if missing → create profile → loader,
  scripts, prefs → update watcher on.
- If Zen is running, setup asks the owner to quit it and **waits** rather than failing.
- If macOS App Management blocks writing into Zen.app, setup says exactly which switch to turn
  on (and opens that Settings pane); re-running `cranez setup` picks up where it stopped.
- Existing commands carry over as `cranez status`, `cranez loader`, `cranez uninstall`,
  `cranez watch-on/off`.
- The `cranez` command is thin: almost every change ships via the repo (picked up by `setup`),
  so a new brew release is rarely needed.
- Out of scope: extensions, Zen mods, workspaces, Zen settings that aren't cranez prefs.

## Goals

1. Fresh Mac with only Homebrew → two commands → working cranez. The only clicks are the
   Gatekeeper "Open" on Zen's first launch, the App Management switch, and signing in to the
   Mozilla account.
2. `cranez setup` is idempotent and safe to run any time; re-running is the update path.
3. A pref tuned in about:config on one Mac shows up on the others via Sync.
4. A Zen update never silently leaves scripts off (watcher, as today).

## Non-goals

- Getting into homebrew-core.
- Linux/Windows.
- Managing Zen beyond what cranez already does.
- Auto-updating scripts in the background (updates happen when the owner runs `setup`).
- Syncing prefs through git.

## Anti-goals (failure even if it "works")

- Breaking or corrupting the Zen profile, or leaving Zen unable to start.
- Losing tuned prefs. In particular, `setup` must never overwrite a pref the Mac already has.
- Manual steps beyond the three clicks in Goal 1.
- Needing a brew release for every script change.
- Breaking the current dev flow: `./cranez.sh <cmd>` from a clone keeps working, and
  `bash tests/run.sh` stays the test entry point.

## Constraints

- Everything from CLAUDE.md still applies: macOS `/bin/bash` 3.2 + BSD tools, shellcheck-clean,
  no version suffixes in file names, don't edit `vendor/`, fail safe.
- Homebrew is assumed present (it's how cranez gets installed).
- Git is available (Homebrew requires the Command Line Tools, which include git).

## Shape (builder may refine)

**Two pieces:**

1. **`bin/cranez`** (new, in this repo, installed by the formula): a small bootstrap. It owns the
   managed checkout, implements `setup`, and forwards every other command to
   `<checkout>/cranez.sh`.
2. **`cranez.sh`** (existing): stays the engine. Gains what `setup` needs (waiting for Zen to
   quit, the prefs changes below, and message text saying `cranez <cmd>` instead of
   `./cranez.sh <cmd>` when run through the bootstrap).

**Managed checkout (my call):** `~/Library/Application Support/cranez/repo`, cloned over HTTPS
from `https://github.com/ivanmorales/cranez.git` on first `setup`. Nothing the owner authors
lives there, so `setup` brings it to `origin/main` exactly (fetch + hard reset) and never stops
on divergence. `CRANEZ_HOME=/path/to/clone` points the command at a dev clone instead. A dev
clone is used as-is: never fetched, reset or pulled. The update watcher's LaunchAgent points at
whichever checkout is in use.

**`cranez setup`, step by step:**

1. Checkout: clone if missing, else sync to `origin/main` (skip for `CRANEZ_HOME`).
2. Zen: if `/Applications/Zen.app` is missing, `brew install --cask` it (the builder confirms the
   current cask name, believed to be `zen`).
3. Profile: if Zen has no profile yet, open Zen normally (`open -a`) so macOS shows its one-time
   "Open" confirmation and Zen creates its own default profile. Wait for `profiles.ini` and the
   profile folder to appear, then quit Zen (AppleScript quit, not kill). Must not create a second
   profile when one already exists.
4. If Zen is running: print "Quit Zen (⌘Q) to continue…" and wait until it exits.
5. `cranez.sh install` (loader, scripts, prefs, startup cache).
6. On an App Management block: explain the switch, open the Settings pane, exit non-zero.
   Re-running `setup` resumes, since every step is idempotent.
7. `watch-on`.
8. Summary: Zen version, profile, scripts, watcher state, checkout commit, and a reminder to sign
   in to the Mozilla account in Zen if it isn't already (so cranez prefs sync).

**Prefs via Firefox Sync:**

- Firefox syncs a pref when `services.sync.prefs.sync.<name>` is `true`. Prefs outside Firefox's
  built-in list also need `services.sync.prefs.dangerously_allow_arbitrary` = `true`. The builder
  verifies both work in current Zen (manual check: tune a pref on one Mac, see it on another).
- `install` writes those control prefs for every syncable cranez pref, and the
  `allow_arbitrary` pref, on every run. They're cranez-owned, so overwriting them is fine.
- **Syncable set:** every pref documented in the script headers (`arcpip.*`, `pipswipe.*`,
  `arclittle.*`, `tabexpiry.*`, `devbar.*`), plus the PiP prefs `capture` already handles
  (`media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled` and
  `...enable-when-occluded.enabled`). Same exclusions as `capture` today: `*.debug`,
  `devbar.visible`, `tabexpiry.run_now`. A pref only syncs if its name is in the list, so adding
  a pref to a script means adding it to the list. The builder picks where the list lives (one
  file, or derived from headers), and a test checks every documented pref is either in the list
  or explicitly excluded.
- **`zen-prefs.js` becomes defaults only.** `apply_prefs` changes from "overwrite these" to "set
  only the ones this profile doesn't already have". So `setup` never clobbers a local or synced
  value, and a brand-new Mac still starts with sensible values before Sync signs in.
- **`capture`** stays a maintainer tool for updating those defaults from a dev clone
  (`./cranez.sh capture`, then commit by hand). Through the bootstrap, `cranez capture` doesn't
  commit or push. It says prefs sync through the Mozilla account and points at the dev-clone
  flow for changing defaults. (My call.)

**Formula:** installs `bin/cranez` from a tagged release tarball of `ivanmorales/cranez`
(`url` + `sha256`). No dependencies beyond macOS and Homebrew. `cranez --version` prints the
release version. A `test do` block runs `cranez --version`.

**Release process:** tag `vX.Y.Z` on cranez, then update the formula's `url`/`sha256` in the
tap. Documented in the README. Automation (a GitHub Action that bumps the tap) is optional and
left to the builder.

## Migration (existing Macs, by hand, once)

Documented in the README:

1. Sign in to the Mozilla account in Zen on every Mac, if not already.
2. On the Mac whose cranez prefs are tuned best: `brew install ivanmorales/tap/cranez`,
   `cranez setup`, restart Zen, and let it sync. This Mac uploads its values first.
3. On each other Mac: same commands. Setup won't overwrite its existing prefs, but Sync replaces
   them with the uploaded values.
4. Delete the old clone if nothing else uses it. `setup` repoints the watcher to the new
   checkout. If the old watcher pointed at a different folder, setup notes it in the summary.

The builder confirms how Sync resolves a first sync when two Macs already hold different values,
and writes the README steps to match.

## Tests

Extend `tests/` (and CI) with a `setup` suite on the existing fake-Mac layout, using stub
`brew`, stub `open`/`osascript`/Zen, and a local bare git repo as the "GitHub" remote:

- fresh Mac: clones, installs Zen via the stub, creates the profile, installs, watcher on
- re-run is idempotent and picks up a new commit on the remote
- a managed checkout with stray local changes is brought back to `origin/main`
- `CRANEZ_HOME` dev clone is used as-is (no fetch/reset)
- App Management block: clear message, non-zero exit, re-run completes
- prefs: existing values in `prefs.js` are never overwritten; missing defaults are added; sync
  control prefs and `allow_arbitrary` are written once each, not duplicated on re-run
- every documented script pref is in the syncable list or explicitly excluded

Update the existing installer suite where `apply_prefs` semantics change (e.g. "tab-switch PiP
pref set to true" now only holds when it was unset).

Not testable in CI (verify by hand on a real Mac): real `brew install` from the tap, Zen
first-run profile creation and the Gatekeeper prompt, App Management, launchd, Firefox Sync
actually carrying a cranez pref between Macs.

## Left to the builder

Exact file layout of the tap repo; how `bin/cranez` finds itself vs the checkout; wording of
messages; whether `setup` takes flags (e.g. `--no-watch`); README restructure; where the
syncable-pref list lives.
