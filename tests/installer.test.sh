#!/bin/bash
# End-to-end test of cranez.sh against a fake Mac layout (fake HOME, fake Zen.app, a
# profile whose name has spaces and parentheses, a startup cache, existing prefs).
# macOS-only parts (App Management prompt, launchd watcher, notifications) aren't exercised.
# Run: bash tests/installer.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

export HOME="$T/home"
export ZEN_APP="$T/Applications/Zen.app"
NAME="abc123.Default (release)"
P="$HOME/Library/Application Support/zen/Profiles/$NAME"
CACHE="$HOME/Library/Caches/zen/Profiles/$NAME/startupCache"
RES="$ZEN_APP/Contents/Resources"

mkdir -p "$RES" "$ZEN_APP/Contents/MacOS" "$P/chrome/JS" "$CACHE"
touch "$CACHE/startupCache.8.little"
cat >"$HOME/Library/Application Support/zen/profiles.ini" <<'EOF'
[Profile1]
Name=Old
IsRelative=1
Path=Profiles/zzz.Old

[Install6ED35B3CA1B5D3AE]
Default=Profiles/abc123.Default (release)
Locked=1

[Profile0]
Name=Default (release)
IsRelative=1
Path=Profiles/abc123.Default (release)
Default=1
EOF
cat >"$P/prefs.js" <<'EOF'
// Mozilla User Preferences
user_pref("browser.startup.homepage", "about:home");
user_pref("media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled", false);
user_pref("pipswipe.settle_ms", 180);
user_pref("pipswipe.debug", true);
user_pref("devbar.visible", true);
user_pref("devbar.color", "#3a46c9");
user_pref("tabexpiry.run_now", false);
user_pref("tabexpiry.minutes", 720);
EOF
# Leftovers from earlier iterations: a versioned copy, and a pre-rename manifest that
# lists a script the kit no longer ships.
touch "$P/chrome/JS/pip-swipe-v2.uc.js" "$P/chrome/JS/retired.uc.js"
printf 'retired.uc.js\n' >"$P/chrome/JS/.zen-kit-manifest"

KIT="$T/kit"
cp -R "$ROOT" "$KIT"
rm -rf "$KIT/.git"
cd "$KIT" || exit 1
# One default the profile lacks, one it already has (prefs.js says 180).
printf '%s\n' 'user_pref("arcpip.delay_ms", 300);' 'user_pref("pipswipe.settle_ms", 250);' >>zen-prefs.js

fails=0
check() {
  local msg="$1"
  shift
  if "$@"; then echo "  ok    $msg"; else echo "  FAIL  $msg"; fails=$((fails + 1)); fi
}
count() { grep -c "$1" "$2" || true; }
# shellcheck disable=SC2329  # called through check
syncs_one_per_script() {
  grep -q 'sync.arcpip.require_audio"' "$P/prefs.js" &&
    grep -q 'sync.arclittle.escape_closes"' "$P/prefs.js" &&
    grep -q 'sync.devbar.color"' "$P/prefs.js" &&
    grep -q 'sync.tabexpiry.bookmark_ignore_query"' "$P/prefs.js"
}
PIP='("media.videocontrols.picture-in-picture.enable-when-switching-tabs'

./cranez.sh install >"$T/out1" 2>&1
check "install exits 0" test $? -eq 0
check "picked the [Install] default profile" grep -q "profile: $NAME" "$T/out1"
check "loader copied into Zen.app" cmp -s vendor/fx-autoconfig/program/config.js "$RES/config.js"
check "loader prefs copied into Zen.app" cmp -s vendor/fx-autoconfig/program/defaults/pref/config-prefs.js "$RES/defaults/pref/config-prefs.js"
check "loader utils in profile" test -f "$P/chrome/utils/boot.sys.mjs"
for f in scripts/*.uc.js; do
  check "installed $(basename "$f")" cmp -s "$f" "$P/chrome/JS/$(basename "$f")"
done
check "old versioned copy removed" test ! -e "$P/chrome/JS/pip-swipe-v2.uc.js"
check "retired script from old manifest removed" test ! -e "$P/chrome/JS/retired.uc.js"
check "old manifest migrated" test ! -e "$P/chrome/JS/.zen-kit-manifest"
check "new manifest written" test -s "$P/chrome/JS/.cranez-manifest"
check "startup cache cleared" test ! -d "$CACHE"
check "existing tab-switch PiP pref kept" grep -q 'enable-when-switching-tabs.enabled", false' "$P/prefs.js"
check "tab-switch PiP pref present once" test "$(count "$PIP" "$P/prefs.js")" -eq 1
check "missing default added" grep -q 'arcpip.delay_ms", 300' "$P/prefs.js"
check "existing value not overwritten by default" test "$(count '("pipswipe.settle_ms"' "$P/prefs.js")" -eq 1
check "existing value kept" grep -q 'pipswipe.settle_ms", 180' "$P/prefs.js"
check "sync allowed for arbitrary prefs" grep -q 'services.sync.prefs.dangerously_allow_arbitrary", true' "$P/prefs.js"
check "sync on for pipswipe.settle_ms" grep -q 'services.sync.prefs.sync.pipswipe.settle_ms", true' "$P/prefs.js"
check "sync on for tab-switch PiP" grep -q 'services.sync.prefs.sync.media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled", true' "$P/prefs.js"
check "sync on for one pref per script" syncs_one_per_script
check "debug/visible/run_now not synced" test "$(grep -cE 'sync\.prefs\.sync\..*(\.debug|devbar\.visible|run_now)"' "$P/prefs.js")" -eq 0
# 28 = every documented script pref minus exclusions, plus 2 PiP prefs. Adding a pref to a
# script header changes this on purpose: decide whether it syncs.
check "28 prefs synced" test "$(count 'services.sync.prefs.sync\.' "$P/prefs.js")" -eq 28
check "unrelated prefs untouched" grep -q 'browser.startup.homepage' "$P/prefs.js"

./cranez.sh status >"$T/out2" 2>&1
check "status reports loader in Zen.app" grep -q "✓ Loader in Zen.app" "$T/out2"

./cranez.sh capture >/dev/null 2>&1
check "capture keeps tuned prefs" grep -q 'pipswipe.settle_ms", 180' zen-prefs.js
check "capture keeps devbar.color" grep -q 'devbar.color' zen-prefs.js
check "capture skips debug prefs" test "$(count 'pipswipe.debug' zen-prefs.js)" -eq 0
check "capture skips devbar.visible" test "$(count 'devbar.visible' zen-prefs.js)" -eq 0
check "capture skips tabexpiry.run_now" test "$(count 'run_now' zen-prefs.js)" -eq 0

./cranez.sh install >/dev/null 2>&1
check "re-install is idempotent (pref still once)" test "$(count "$PIP" "$P/prefs.js")" -eq 1
check "re-install: sync control pref once" test "$(count 'sync.pipswipe.settle_ms"' "$P/prefs.js")" -eq 1
check "re-install: allow_arbitrary once" test "$(count dangerously_allow_arbitrary "$P/prefs.js")" -eq 1
printf '%s' "$(cat "$P/prefs.js")" >"$T/nonl" && mv "$T/nonl" "$P/prefs.js" # drop final newline
./cranez.sh install >/dev/null 2>&1
check "prefs.js without final newline stays one pref per line" test "$(count ');user_pref' "$P/prefs.js")" -eq 0

rm -f "$RES/config.js"
./cranez.sh after-update >/dev/null 2>&1
check "after-update restores the loader" test -f "$RES/config.js"

./cranez.sh uninstall >/dev/null 2>&1
check "uninstall removes scripts" test -z "$(ls -A "$P/chrome/JS")"
check "uninstall removes profile loader" test ! -d "$P/chrome/utils"
check "uninstall removes app loader" test ! -f "$RES/config.js"

if [[ $fails -eq 0 ]]; then echo "installer: all checks passed"; else echo "installer: $fails check(s) failed"; fi
exit $((fails > 0))
