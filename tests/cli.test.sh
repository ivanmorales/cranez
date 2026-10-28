#!/bin/bash
# End-to-end test of bin/cranez (the command Homebrew installs) on a fake Mac
# (tests/fake-mac.sh), with a local bare repo standing in for GitHub: first setup clones,
# re-runs pick up new commits and undo stray edits, offline re-runs carry on, a CRANEZ_HOME
# dev clone is used as-is.
# Run: bash tests/cli.test.sh
set -uo pipefail
# shellcheck source=tests/fake-mac.sh
source "$(dirname "${BASH_SOURCE[0]}")/fake-mac.sh"

make_zen_app
make_profile
touch "$P/signedInUser.json"

# "GitHub": a bare repo holding the current working tree as its main branch.
make_kit
SRC="$KIT"
g() { git -C "$SRC" -c user.name=t -c user.email=t@t "$@"; }
g init -q -b main
g add -A
g commit -qm init
git clone -q --bare "$SRC" "$T/remote.git"
push_change() {
  echo "// $1" >>"$SRC/scripts/dev-bar.uc.js"
  g commit -qam "$1"
  g push -q "$T/remote.git" main
}
export CRANEZ_REPO_URL="$T/remote.git"
CO="$HOME/Library/Application Support/cranez/repo"
PLIST="$HOME/Library/LaunchAgents/com.cranez.update-watch.plist"
C="$ROOT/bin/cranez"
rc=0

# shellcheck disable=SC2016  # $0 expands inside the bash -c
check "--version prints the version" bash -c '"$0" --version | grep -qE "^cranez [0-9]+\.[0-9]+\.[0-9]+$"' "$C"

"$C" status >"$T/o0" 2>&1
rc=$?
check "before setup: status fails" test $rc -ne 0
check "before setup: says run cranez setup" grep -q 'cranez setup' "$T/o0"

"$C" setup >"$T/o1" 2>&1
rc=$?
check "setup exits 0" test $rc -eq 0
check "setup cloned the checkout" test -f "$CO/cranez.sh"
check "watcher points at managed checkout" grep -qF "$CO/cranez.sh" "$PLIST"
check "watcher message fits the managed checkout" grep -qF "It uses cranez's copy in $CO" "$T/o1"
check "no 'move the kit' advice" test "$(count 'move' "$T/o1")" -eq 0

rm -f "$ZEN_APP/Contents/Resources/config.js"
"$C" status >"$T/o2" 2>&1
check "messages say cranez, not a path" grep -q 'cranez loader' "$T/o2"
check "messages don't show cranez.sh" test "$(count 'cranez.sh' "$T/o2")" -eq 0

push_change "second commit"
"$C" setup >/dev/null 2>&1
check "re-run picks up the new commit" test "$(git -C "$CO" rev-parse HEAD)" = "$(git --git-dir="$T/remote.git" rev-parse main)"
check "updated script installed" cmp -s "$CO/scripts/dev-bar.uc.js" "$P/chrome/JS/dev-bar.uc.js"

echo junk >>"$CO/cranez.sh"
touch "$CO/stray"
"$C" setup >/dev/null 2>&1
check "stray edits in managed checkout reset" test -z "$(git -C "$CO" status --porcelain)"

mv "$T/remote.git" "$T/remote.off"
"$C" setup >"$T/o3" 2>&1
rc=$?
mv "$T/remote.off" "$T/remote.git"
check "offline: setup still exits 0" test $rc -eq 0
check "offline: says couldn't reach GitHub" grep -q "Couldn't reach GitHub" "$T/o3"

"$C" capture >"$T/o4" 2>&1
check "capture points at Mozilla account" grep -q 'Mozilla account' "$T/o4"
check "capture leaves checkout clean" test -z "$(git -C "$CO" status --porcelain)"

git clone -q "$T/remote.git" "$T/dev"
touch "$T/dev/wip"
before=$(git -C "$T/dev" rev-parse HEAD)
push_change "third commit"
CRANEZ_HOME="$T/dev" "$C" setup >"$T/o5" 2>&1
rc=$?
check "dev clone: setup exits 0" test $rc -eq 0
check "dev clone: untracked work kept" test -f "$T/dev/wip"
check "dev clone: not fetched or reset" test "$(git -C "$T/dev" rev-parse HEAD)" = "$before"
check "dev clone: watcher points at it" grep -qF "$T/dev/cranez.sh" "$PLIST"
check "dev clone: watcher move noted" grep -q 'Watcher moved' "$T/o5"

finish cli
