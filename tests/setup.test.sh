#!/bin/bash
# End-to-end test of `cranez.sh setup` on a fake Mac (tests/fake-mac.sh): a fresh Mac, a
# re-run, Zen still running, an App Management block, Gatekeeper never clicked, no Homebrew.
# Run: bash tests/setup.test.sh
set -uo pipefail
# shellcheck source=tests/fake-mac.sh
source "$(dirname "${BASH_SOURCE[0]}")/fake-mac.sh"

make_kit
cd "$KIT" || exit 1
rc=0
run() { ./cranez.sh setup >"$T/$1" 2>&1; rc=$?; }

# A fresh Mac: no Zen.app, no profile.
run out1
check "fresh: setup exits 0" test $rc -eq 0
check "fresh: brew installed the zen cask" grep -q 'install --cask zen' "$T/brew.log"
check "fresh: Zen opened to create its profile" grep -qF "$ZEN_APP" "$T/open.log"
check "fresh: Zen asked to quit afterwards" grep -q 'app.zen-browser.zen' "$T/osascript.log"
check "fresh: scripts installed" cmp -s scripts/pip-swipe.uc.js "$P/chrome/JS/pip-swipe.uc.js"
check "fresh: loader in Zen.app" test -f "$ZEN_APP/Contents/Resources/config.js"
check "fresh: watcher bootstrapped" grep -q bootstrap "$T/launchctl.log"
check "fresh: watcher says how to re-point it" grep -qF "if you move it, run ./cranez.sh watch-on again" "$T/out1"
check "fresh: sign-in reminder" grep -q 'Mozilla account' "$T/out1"
check "fresh: no ⌘Q prompt once Zen quits by itself" test "$(count 'Quit Zen' "$T/out1")" -eq 0

# Re-run, now signed in to the Mozilla account.
touch "$P/signedInUser.json"
run out2
check "re-run: exits 0" test $rc -eq 0
check "re-run: brew not called again" test "$(count 'install --cask' "$T/brew.log")" -eq 1
check "re-run: Zen not opened again" test "$(count "$ZEN_APP" "$T/open.log")" -eq 1
check "re-run: no sign-in reminder when signed in" test "$(count 'Mozilla account' "$T/out2")" -eq 0

# Zen running: setup waits for it to quit instead of failing.
printf '#!/bin/bash\nsleep 3\n' >"$ZEN_APP/Contents/MacOS/zen"
chmod +x "$ZEN_APP/Contents/MacOS/zen"
"$ZEN_APP/Contents/MacOS/zen" &
sleep 0.3
run out3
check "running: setup waited for quit" grep -q 'Quit Zen' "$T/out3"
check "running: then completed" test $rc -eq 0

# App Management blocks writing into Zen.app.
touch "$T/block-app"
rm -f "$ZEN_APP/Contents/Resources/config.js"
run out4
check "blocked: exits non-zero" test $rc -ne 0
check "blocked: explains App Management" grep -q 'App Management' "$T/out4"
check "blocked: opened Settings pane" grep -q 'Privacy_AppBundles' "$T/open.log"
check "blocked: says to rerun setup" grep -q 'run: ./cranez.sh setup' "$T/out4"
rm -f "$T/block-app"
run out5
check "unblocked: re-run completes" test $rc -eq 0
check "unblocked: loader in Zen.app" test -f "$ZEN_APP/Contents/Resources/config.js"

# Zen.app deleted by hand, profile kept: brew must reinstall (its cask record says installed)
# and Zen must get its first, Gatekeeper-checked launch before the loader touches the bundle.
rm -rf "$ZEN_APP"
opens=$(count "$ZEN_APP" "$T/open.log")
run out5b
check "deleted app: setup exits 0" test $rc -eq 0
check "deleted app: brew reinstalled zen" grep -q 'reinstall --cask zen' "$T/brew.log"
check "deleted app: Zen launched once before install" test "$(count "$ZEN_APP" "$T/open.log")" -eq $((opens + 1))
check "deleted app: loader in Zen.app" test -f "$ZEN_APP/Contents/Resources/config.js"

# Gatekeeper never clicked: Zen never creates a profile.
rm -rf "$ZEN_DATA"
touch "$T/no-profile-on-open"
run out6
check "no profile: exits non-zero" test $rc -ne 0
check "no profile: says open Zen once" grep -q "didn't create a profile" "$T/out6"
rm -f "$T/no-profile-on-open"

# No Zen and no Homebrew.
rm -rf "$ZEN_APP"
mv "$T/stubs/brew" "$T/brew.off"
PATH="$T/stubs:/usr/bin:/bin" run out7
check "no brew: exits non-zero" test $rc -ne 0
check "no brew: names Homebrew" grep -q 'Homebrew' "$T/out7"

finish setup
