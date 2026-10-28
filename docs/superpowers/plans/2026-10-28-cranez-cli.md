# cranez CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `brew install ivanmorales/tap/cranez && cranez setup` takes a Mac with only Homebrew to a Zen with every cranez feature working. Tuned cranez prefs travel through Firefox Sync.

**Architecture:** `bin/cranez` is a thin bootstrap installed by Homebrew. It keeps a cranez-owned git checkout in sync with `origin/main` and forwards every command to that checkout's `cranez.sh`. `cranez.sh` stays the engine and gains a `setup` command (install Zen, create profile, wait for quit, install, watcher, summary). It also changes how prefs are applied: `zen-prefs.js` defaults only fill gaps, and Sync control prefs get written. Because the logic lives in the repo, most changes ship without a brew release.

**Tech Stack:** bash 3.2 + BSD tools, git, Homebrew tap (Ruby formula), launchd, Firefox Sync prefs engine.

**Spec:** `docs/superpowers/specs/2026-10-28-cranez-cli-design.md`

## Global Constraints

- macOS `/bin/bash` 3.2 + BSD tools: no associative arrays, `mapfile`, `${x,,}`, `sed -i`, `readlink -f`; POSIX awk only. Shellcheck-clean (`bin/cranez` included).
- Stable file names, never version suffixes. Don't edit `vendor/`. Fail safe: never break Zen or the profile.
- `./cranez.sh <cmd>` from a clone keeps working; `bash tests/run.sh` stays the single test entry point (CI runs it on ubuntu-latest, so every macOS tool a test touches is stubbed).
- Tap repo `ivanmorales/homebrew-tap`, formula `cranez`; source repo `https://github.com/ivanmorales/cranez.git` (public, HTTPS, no auth).
- Managed checkout: `~/Library/Application Support/cranez/repo`. `CRANEZ_HOME` = dev clone, used as-is (never fetched/reset).
- Zen cask: `zen` (confirmed: `brew info --cask zen`). Bundle id `app.zen-browser.zen`. App path default `/Applications/Zen.app` (`ZEN_APP` override).
- Never strip the quarantine flag; the owner clicks Gatekeeper's "Open" once.
- `setup` never overwrites a pref the profile already has. Only cranez-owned `services.sync.*` control prefs are rewritten.
- Syncable prefs: every pref documented in script headers (`arcpip.*`, `arclittle.*`, `pipswipe.*`, `tabexpiry.*`, `devbar.*`), excluding `*.debug`, `devbar.visible`, `tabexpiry.run_now`, plus `media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled` and `media.videocontrols.picture-in-picture.enable-when-occluded.enabled`. Today that is 28 names.
- First release version: `0.1.0` (tag `v0.1.0`).

## Review Focus

1. **Re-running `setup` with no network:** it should warn and carry on with the existing checkout, not abort. Test in Task 3.
2. **The owner never clicks Gatekeeper's "Open" (no profile appears):** setup should time out with a clear "open Zen once, then rerun" message, a non-zero exit, and Zen not killed. Test in Task 2.
3. **`prefs.js` without a trailing newline:** appended prefs must start on their own line, or Zen silently drops prefs. Test in Task 1.
4. **Running `cranez status` (or any command) before the first `setup`:** it should say "run cranez setup first", not show a bash error. Test in Task 3.
5. **Zen missing and Homebrew not on `PATH`:** setup should say it needs Homebrew or a Zen.app, not show "brew: command not found". Test in Task 2.

---

### Task 1: Prefs become defaults-only and turn on Sync

**Files:**
- Modify: `cranez.sh` (`apply_prefs`, new `syncable_prefs`, capture header text, `notify` text)
- Modify: `zen-prefs.js` (header comment)
- Test: `tests/installer.test.sh`

**Interfaces:**
- Produces: `syncable_prefs` prints one pref name per line, sorted and unique, derived at run time from header lines matching `^ \*   (arcpip|arclittle|pipswipe|tabexpiry|devbar)\.[a-z_]+ ` in `$KIT/scripts/*.uc.js`, minus exclusions, plus the two PiP prefs.
- Produces: `apply_prefs` (same name and call site in `cmd_install`). New behaviour:
  - Appends only the `zen-prefs.js` lines whose name is absent from `prefs.js`.
  - Then drops and re-appends `user_pref("services.sync.prefs.sync.<name>", true);` for every syncable name, plus `user_pref("services.sync.prefs.dangerously_allow_arbitrary", true);`.
  - Makes sure `prefs.js` ends in a newline before appending.
  - Prints `Applied N new default pref(s)` and `Sync on for M cranez pref(s)`.

- [ ] **Step 1: Manual gate. The owner verifies Sync carries an arbitrary pref in Zen.**
  1. On Mac A, signed in to the Mozilla account, add in about:config: `services.sync.prefs.dangerously_allow_arbitrary` = true, `services.sync.prefs.sync.pipswipe.settle_ms` = true, and `pipswipe.settle_ms` = 251.
  2. Sync Now.
  3. On Mac B, set the same two `services.sync.*` prefs, then Sync Now.

  Expected: `pipswipe.settle_ms` = 251 on Mac B. If it doesn't arrive, **stop and go back to the owner**; the spec's prefs design depends on this.

- [ ] **Step 2: Write the failing checks in `tests/installer.test.sh`**

  Before the first `./cranez.sh install`, after `cd "$KIT"`:
  ```bash
  printf '%s\n' 'user_pref("arcpip.delay_ms", 300);' 'user_pref("pipswipe.settle_ms", 250);' >>zen-prefs.js
  ```
  Replace the check `tab-switch PiP pref set to true` with these after the first install:
  ```bash
  check "existing tab-switch PiP pref kept" grep -q 'enable-when-switching-tabs.enabled", false' "$P/prefs.js"
  check "missing default added" grep -q 'arcpip.delay_ms", 300' "$P/prefs.js"
  check "existing value not overwritten by default" test "$(count '("pipswipe.settle_ms"' "$P/prefs.js")" -eq 1
  check "existing value kept" grep -q 'pipswipe.settle_ms", 180' "$P/prefs.js"
  check "sync allowed for arbitrary prefs" grep -q 'services.sync.prefs.dangerously_allow_arbitrary", true' "$P/prefs.js"
  check "sync on for pipswipe.settle_ms" grep -q 'services.sync.prefs.sync.pipswipe.settle_ms", true' "$P/prefs.js"
  check "sync on for tab-switch PiP" grep -q 'services.sync.prefs.sync.media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled", true' "$P/prefs.js"
  check "sync on for one pref per script" grep -q 'sync.arcpip.require_audio"' "$P/prefs.js" &&
    grep -q 'sync.arclittle.escape_closes"' "$P/prefs.js" && grep -q 'sync.devbar.color"' "$P/prefs.js" &&
    grep -q 'sync.tabexpiry.bookmark_ignore_query"' "$P/prefs.js"
  check "debug/visible/run_now not synced" test "$(grep -cE 'sync\.prefs\.sync\..*(\.debug|devbar\.visible|run_now)"' "$P/prefs.js")" -eq 0
  # 28 = every documented script pref minus exclusions, plus 2 PiP prefs. Adding a pref to a
  # script header changes this on purpose: decide whether it syncs.
  check "28 prefs synced" test "$(count 'services.sync.prefs.sync\.' "$P/prefs.js")" -eq 28
  ```
  The sync control line also contains the pref name, so the two existing "present once" checks must count `'("media.videocontrols.picture-in-picture.enable-when-switching-tabs'`, with the leading `("`, instead of `enable-when-switching-tabs`.

  The `&&` chain under one `check` won't work, because `check` runs `"$@"`. Wrap it in a function `syncs_one_per_script() { ...; }` and `check "..." syncs_one_per_script`.

  After the existing second `./cranez.sh install` (the re-install check):
  ```bash
  check "re-install: sync control pref once" test "$(count 'sync.pipswipe.settle_ms"' "$P/prefs.js")" -eq 1
  check "re-install: allow_arbitrary once" test "$(count dangerously_allow_arbitrary "$P/prefs.js")" -eq 1
  printf '%s' "$(cat "$P/prefs.js")" >"$T/nonl" && mv "$T/nonl" "$P/prefs.js"   # drop final newline
  ./cranez.sh install >/dev/null 2>&1
  check "prefs.js without final newline stays one pref per line" test "$(grep -c ');user_pref' "$P/prefs.js")" -eq 0
  ```

- [ ] **Step 3: Run to verify they fail**

  Run: `bash tests/installer.test.sh`
  Expected: FAIL on `existing tab-switch PiP pref kept`, `existing value kept`, and every `sync` check.

- [ ] **Step 4: Implement `syncable_prefs` and the new `apply_prefs` in `cranez.sh`.** Use awk to look up names, keeping the existing `awk -F'"'` drop-set idiom. Update the header comment that `capture` writes (and the one in `zen-prefs.js`) to say: defaults for a brand-new Mac, only set when missing, tuned values travel through the Mozilla account, edit from a dev clone with `./cranez.sh capture` and commit. Change the `notify` text `Run: cranez.sh loader` to `Run: cranez loader`.

- [ ] **Step 5: Run to verify they pass**

  Run: `bash tests/run.sh`
  Expected: `ALL PASSED`

- [ ] **Step 6: Commit**
  ```bash
  git add cranez.sh zen-prefs.js tests/installer.test.sh
  git commit -m "Prefs: fill only missing defaults, sync cranez prefs via Firefox Sync"
  ```

---

### Task 2: `cranez.sh setup`

**Files:**
- Modify: `cranez.sh` (new functions and `setup` dispatch, header/usage lines, `$ME` in messages, `copy_loader` calls `cp`/`mkdir` by name, `cmd_watch_on` notes a moved watcher)
- Create: `tests/fake-mac.sh` (shared fixture, sourced)
- Create: `tests/setup.test.sh`
- Modify: `tests/run.sh` (add `step "setup"; bash tests/setup.test.sh || status=1`)

**Interfaces:**
- Consumes: `apply_prefs` (Task 1), existing `find_profile`, `zen_running`, `cmd_install`, `cmd_watch_on`, `cmd_status`.
- Produces in `cranez.sh`:
  - `ME="${CRANEZ_CLI_NAME:-$0}"`: every user-facing "run: $0 x" becomes `$ME x`. `usage` still reads `$0`.
  - `has_profile`: returns 0 if `( find_profile ) >/dev/null 2>&1` succeeds.
  - `ensure_zen`:
    - If `$APP` exists, do nothing.
    - Else, if `brew` isn't on `PATH`, die `Zen isn't installed and Homebrew isn't on PATH. Install Homebrew (https://brew.sh) or Zen, then run $ME setup again.`
    - Else `brew install --cask zen`, then die if `$APP` still doesn't exist.
  - `ensure_profile`:
    - If `has_profile`, do nothing.
    - Else `open "$APP"`, print `Opening Zen once to create its profile. If macOS asks, click Open.`, and poll `has_profile` every second for up to `${CRANEZ_PROFILE_TIMEOUT:-300}` seconds.
    - On timeout, die `Zen didn't create a profile in ${t}s. Open Zen once, quit it, then run $ME setup again.` Don't kill Zen.
    - On success, `osascript -e 'tell application id "app.zen-browser.zen" to quit' || true`.
  - `wait_for_quit`: if `zen_running`, print `Quit Zen (⌘Q) to continue…` once, then `sleep 1` until it isn't.
  - `cmd_setup`: `ensure_zen` → `ensure_profile` → `wait_for_quit` → `SETUP=1 cmd_install` → `cmd_watch_on` → summary. The summary is `cmd_status`, then `cranez checkout: <git -C "$KIT" rev-parse --short HEAD, or ?>`. If `$PROFILE/signedInUser.json` is missing, add `Sign in to your Mozilla account in Zen so cranez prefs sync.`
  - `install_loader`, when rc is 2 and `SETUP=1`: also run `open "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles" || true`, and tell the owner to rerun `$ME setup` instead of `$ME loader`.
  - `cmd_watch_on`: before rewriting the plist, read the old `.../cranez.sh` path from it. If it differs from `$KIT/cranez.sh`, warn `Watcher moved from <old dir> to <KIT>; the old folder isn't used by the watcher any more.`
  - New macOS tool calls go by bare name (`open`, `osascript`, `brew`, `launchctl`, `cp`, `mkdir`) so tests can stub them on `PATH`. The existing `/usr/bin/osascript` in `notify` and `/usr/bin/pgrep` stay as they are.
- Produces `tests/fake-mac.sh` (sourced; defines, doesn't run tests):
  - `T` is a temp dir with an EXIT trap. It exports `HOME=$T/home`, `ZEN_APP=$T/Applications/Zen.app`, `ZEN_DATA=$HOME/Library/Application Support/zen` and `CRANEZ_PROFILE_TIMEOUT=3`.
  - `PATH="$T/stubs:$PATH"`.
  - `ROOT` is the repo root.
  - Helpers:
    - `check` and `count`, the same as in `installer.test.sh`.
    - `make_zen_app` creates `Contents/{Resources,MacOS}`.
    - `make_profile` writes a `profiles.ini` with an `[Install…] Default=Profiles/abc123.Default (release)` section, plus that folder with an empty `prefs.js`, and sets `P`.
    - `make_kit` copies `$ROOT` to `$T/kit` without `.git` and sets `KIT`.
  - Stubs, written as executable scripts in `$T/stubs`, each appending its args to `$T/<name>.log`:
    - `brew`: on `install --cask zen`, runs `make_zen_app`'s mkdir directly.
    - `open`: when given `$ZEN_APP` and `$T/no-profile-on-open` is absent, creates the profile like `make_profile`.
    - `osascript` and `launchctl`: exit 0.
    - `cp`: if `$T/block-app` exists and any arg contains `/Contents/Resources`, prints `cp: …: Operation not permitted` to stderr and exits 1. Otherwise it execs `/bin/cp "$@"`.

- [ ] **Step 1: Write `tests/fake-mac.sh` and the failing `tests/setup.test.sh`.** The scenarios run in order on one fake Mac, each with `./cranez.sh setup >"$T/outN" 2>&1; rc=$?` from `$KIT`:
  ```bash
  # A. fresh Mac: no Zen.app, no profile
  check "fresh: setup exits 0" test $rc -eq 0
  check "fresh: brew installed the zen cask" grep -q 'install --cask zen' "$T/brew.log"
  check "fresh: Zen opened to create its profile" grep -qF "$ZEN_APP" "$T/open.log"
  check "fresh: Zen asked to quit afterwards" grep -q 'app.zen-browser.zen' "$T/osascript.log"
  check "fresh: scripts installed" cmp -s scripts/pip-swipe.uc.js "$P/chrome/JS/pip-swipe.uc.js"
  check "fresh: loader in Zen.app" test -f "$ZEN_APP/Contents/Resources/config.js"
  check "fresh: watcher bootstrapped" grep -q bootstrap "$T/launchctl.log"
  check "fresh: sign-in reminder" grep -q 'Mozilla account' "$T/out1"
  # B. re-run, signed in
  touch "$P/signedInUser.json"
  check "re-run: exits 0" test $rc -eq 0
  check "re-run: brew not called again" test "$(count 'install' "$T/brew.log")" -eq 1
  check "re-run: Zen not opened again" test "$(count "$ZEN_APP" "$T/open.log")" -eq 1
  check "re-run: no sign-in reminder when signed in" test "$(count 'Mozilla account' "$T/out2")" -eq 0
  # C. Zen running: fake process at $ZEN_APP/Contents/MacOS/zen (bash script: sleep 3), started in background
  check "running: setup waited for quit" grep -q 'Quit Zen' "$T/out3"
  check "running: then completed" test $rc -eq 0
  # D. App Management block: touch block-app, rm Resources/config.js
  check "blocked: exits non-zero" test $rc -ne 0
  check "blocked: explains App Management" grep -q 'App Management' "$T/out4"
  check "blocked: opened Settings pane" grep -q 'Privacy_AppBundles' "$T/open.log"
  check "blocked: says to rerun setup" grep -q 'setup' "$T/out4"
  # D2. rm block-app, re-run
  check "unblocked: re-run completes" test $rc -eq 0
  check "unblocked: loader in Zen.app" test -f "$ZEN_APP/Contents/Resources/config.js"
  # E. Gatekeeper never clicked: rm -rf "$ZEN_DATA"; touch no-profile-on-open
  check "no profile: exits non-zero" test $rc -ne 0
  check "no profile: says open Zen once" grep -q "didn't create a profile" "$T/out6"
  # F. no Homebrew: rm -rf "$ZEN_APP"; mv stubs/brew aside; PATH="$T/stubs:/usr/bin:/bin"
  check "no brew: exits non-zero" test $rc -ne 0
  check "no brew: names Homebrew" grep -q 'Homebrew' "$T/out7"
  ```
  The file ends with the same pass/fail summary and exit code as `installer.test.sh`. Add the `run.sh` step.

- [ ] **Step 2: Run to verify it fails**

  Run: `bash tests/setup.test.sh`
  Expected: FAIL, `setup` isn't a command yet (usage is printed).

- [ ] **Step 3: Implement the `cranez.sh` functions listed in Interfaces.** Add the `setup` line to the header comment and widen `usage`'s `sed -n` range to match.

- [ ] **Step 4: Run to verify it passes**

  Run: `bash tests/run.sh`
  Expected: `ALL PASSED`, shellcheck included.

- [ ] **Step 5: Commit**
  ```bash
  git add cranez.sh tests/fake-mac.sh tests/setup.test.sh tests/run.sh
  git commit -m "Add cranez.sh setup: install Zen, create profile, install, watcher"
  ```

---

### Task 3: `bin/cranez` bootstrap

**Files:**
- Create: `bin/cranez` (executable)
- Create: `tests/cli.test.sh`
- Modify: `tests/run.sh` (shellcheck `bin/cranez`; add `step "cli"; bash tests/cli.test.sh || status=1`)

**Interfaces:**
- Consumes: `cranez.sh setup` and the `CRANEZ_CLI_NAME` / `$ME` contract (Task 2); `tests/fake-mac.sh` (Task 2).
- Produces in `bin/cranez`:
  - `CRANEZ_VERSION="0.1.0"`. A release must match its tag; the formula test asserts this.
  - `REPO_URL="${CRANEZ_REPO_URL:-https://github.com/ivanmorales/cranez.git}"`; `CHECKOUT="${CRANEZ_HOME:-$HOME/Library/Application Support/cranez/repo}"`.
  - `sync_checkout`:
    - Skipped when `CRANEZ_HOME` is set.
    - With no `$CHECKOUT/.git`, `git clone --quiet`; die on failure.
    - Otherwise `git fetch --quiet origin main && git reset --quiet --hard origin/main && git clean -fdq`. If that fails, warn `Couldn't reach GitHub; using the copy from <short sha>.` and continue.
  - Commands:
    - `--version|-v|version` prints `cranez $CRANEZ_VERSION`.
    - `setup` runs `sync_checkout`, then the engine.
    - `capture` without `CRANEZ_HOME` prints that prefs sync through the Mozilla account, and that defaults are changed by running `./cranez.sh capture` in a dev clone and committing. Exits 0.
    - `help|-h|--help|""` prints a short list of commands.
    - Anything else needs `$CHECKOUT/cranez.sh`, or dies `No cranez checkout yet. Run: cranez setup`. Then it runs the engine.
  - Engine: `CRANEZ_CLI_NAME=cranez exec /bin/bash "$CHECKOUT/cranez.sh" "$@"`.

- [ ] **Step 1: Write the failing `tests/cli.test.sh`.**
  - Setup: source `fake-mac.sh`; `make_zen_app`; `make_profile`; `touch "$P/signedInUser.json"`.
  - Make `$T/src`, a copy of `$ROOT`'s working tree without `.git`, then `git init -q`, add and commit (with `-c user.name=t -c user.email=t@t`), and clone it bare to `$T/remote.git`.
  - `export CRANEZ_REPO_URL="$T/remote.git"`; `CO="$HOME/Library/Application Support/cranez/repo"`; `C="$ROOT/bin/cranez"`.
  ```bash
  check "--version" bash -c '"$0" --version | grep -qE "^cranez [0-9]+\.[0-9]+\.[0-9]+$"' "$C"
  "$C" status >"$T/o0" 2>&1; rc=$?
  check "before setup: status fails" test $rc -ne 0
  check "before setup: says run cranez setup" grep -q 'cranez setup' "$T/o0"
  "$C" setup >"$T/o1" 2>&1; rc=$?
  check "setup exits 0" test $rc -eq 0
  check "setup cloned the checkout" test -f "$CO/cranez.sh"
  check "watcher points at managed checkout" grep -qF "$CO/cranez.sh" "$HOME/Library/LaunchAgents/com.cranez.update-watch.plist"
  rm -f "$ZEN_APP/Contents/Resources/config.js"; "$C" status >"$T/o2" 2>&1
  check "messages say cranez, not a path" grep -q 'cranez loader' "$T/o2"
  check "messages don't show cranez.sh" test "$(count 'cranez.sh' "$T/o2")" -eq 0
  # new commit on the remote: edit a comment line in src/scripts/dev-bar.uc.js, commit, push to remote.git
  "$C" setup >/dev/null 2>&1
  check "re-run picks up the new commit" test "$(git -C "$CO" rev-parse HEAD)" = "$(git --git-dir="$T/remote.git" rev-parse main)"
  check "updated script installed" cmp -s "$CO/scripts/dev-bar.uc.js" "$P/chrome/JS/dev-bar.uc.js"
  echo junk >>"$CO/cranez.sh"; touch "$CO/stray"; "$C" setup >/dev/null 2>&1
  check "stray edits in managed checkout reset" test -z "$(git -C "$CO" status --porcelain)"
  mv "$T/remote.git" "$T/remote.off"; "$C" setup >"$T/o3" 2>&1; rc=$?
  check "offline: setup still exits 0" test $rc -eq 0
  check "offline: says couldn't reach GitHub" grep -q "Couldn't reach GitHub" "$T/o3"
  mv "$T/remote.off" "$T/remote.git"
  "$C" capture >"$T/o4" 2>&1
  check "capture points at Mozilla account" grep -q 'Mozilla account' "$T/o4"
  check "capture leaves checkout clean" test -z "$(git -C "$CO" status --porcelain)"
  # dev clone: $T/dev = git clone of $T/remote.git plus an untracked file $T/dev/wip
  CRANEZ_HOME="$T/dev" "$C" setup >"$T/o5" 2>&1; rc=$?
  check "dev clone: setup exits 0" test $rc -eq 0
  check "dev clone: used as-is" test -f "$T/dev/wip"
  check "dev clone: watcher points at it" grep -qF "$T/dev/cranez.sh" "$HOME/Library/LaunchAgents/com.cranez.update-watch.plist"
  check "dev clone: watcher move noted" grep -q 'Watcher moved' "$T/o5"
  ```
  Use the same summary and exit code as the other suites. Wire it into `run.sh`, and add `bin/cranez` to the shellcheck line.

- [ ] **Step 2: Run to verify it fails**

  Run: `bash tests/cli.test.sh`
  Expected: FAIL, `bin/cranez` doesn't exist.

- [ ] **Step 3: Implement `bin/cranez` as specified in Interfaces** (`chmod +x`, `set -euo pipefail`, its own small `ok`/`warn`/`die` matching `cranez.sh`'s style).

- [ ] **Step 4: Run to verify it passes**

  Run: `bash tests/run.sh`
  Expected: `ALL PASSED`

- [ ] **Step 5: Commit**
  ```bash
  git add bin/cranez tests/cli.test.sh tests/run.sh
  git commit -m "Add bin/cranez: managed checkout and command forwarding"
  ```

---

### Task 4: Docs, release v0.1.0, tap, and live check

Outward-facing: **confirm with the owner before every push, tag and repo creation in this task.**

**Files:**
- Modify: `README.md`
  - Install: `brew install ivanmorales/tap/cranez`, `cranez setup`, and the three clicks.
  - Commands are now `cranez <cmd>`.
  - Prefs sync through the Mozilla account; `zen-prefs.js` holds defaults.
  - Migration: the spec's four steps, verbatim in intent.
  - Development: `CRANEZ_HOME`, `./cranez.sh`, `bash tests/run.sh`.
  - Release steps:
    1. Bump `CRANEZ_VERSION`.
    2. Tag `vX.Y.Z`.
    3. Update the formula's `url` and `sha256`.
- Modify: `CLAUDE.md`
  - "How it runs": `bin/cranez`, the managed checkout and `CRANEZ_HOME`.
  - Internals list: Firefox Sync `services.sync.prefs.sync.*` and `services.sync.prefs.dangerously_allow_arbitrary`, `signedInUser.json`.
  - Tests list: the setup and cli suites.
- Create (in a new repo `ivanmorales/homebrew-tap`, cloned to `~/dev/tools/homebrew-tap`): `Formula/cranez.rb`

**Interfaces:**
- Consumes: `bin/cranez` with `CRANEZ_VERSION="0.1.0"` (Task 3).
- Produces `Formula/cranez.rb`:
  - `class Cranez < Formula`, `desc "Arc browser features for Zen on macOS"`, `homepage "https://github.com/ivanmorales/cranez"`.
  - `url "https://github.com/ivanmorales/cranez/archive/refs/tags/v0.1.0.tar.gz"`, `sha256 "<from step 3>"`.
  - `depends_on :macos`; `def install; bin.install "bin/cranez"; end`.
  - `test do assert_match "cranez #{version}", shell_output("#{bin}/cranez --version") end`.

- [ ] **Step 1: Update README.md and CLAUDE.md;** `bash tests/run.sh` → `ALL PASSED`; commit `Docs: Homebrew install, cranez setup, prefs via Sync`.
- [ ] **Step 2 (owner confirms):** `git push`, then `git tag v0.1.0 && git push origin v0.1.0`. Expected: CI green on GitHub.
- [ ] **Step 3:** `curl -sL https://github.com/ivanmorales/cranez/archive/refs/tags/v0.1.0.tar.gz | shasum -a 256`. Record the hash.
- [ ] **Step 4 (owner confirms):** `gh repo create ivanmorales/homebrew-tap --public --clone` in `~/dev/tools`. Write `Formula/cranez.rb`, then commit and push.
- [ ] **Step 5:** `brew install ivanmorales/tap/cranez && brew test cranez && brew audit --strict ivanmorales/tap/cranez && cranez --version`. Expected: `cranez 0.1.0`, test passes, audit raises no errors.
- [ ] **Step 6: Live check on this Mac (owner, manual).**
  - `cranez setup`. Zen gets asked to quit; the checkout is cloned; the watcher moves from the old clone (the summary says so).
  - Restart Zen. The Browser Console shows a `loaded` line for each script.
  - Settings → Sync shows the owner signed in.
  - On a second Mac, the Task 1 Step 1 check passes with a cranez pref, now without setting anything by hand.
- [ ] **Step 7: Fresh-profile check (owner, manual, optional).**
  - Run with `ZEN_DATA` pointing at an empty folder, or on a Mac without Zen.
  - Gatekeeper "Open" appears once, the profile gets created, and Zen quits by itself.
  - If App Management blocks, the Settings pane opens.
