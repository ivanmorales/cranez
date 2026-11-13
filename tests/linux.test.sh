#!/bin/bash
# cranez.sh on a fake Arch Linux box (CRANEZ_OS=Linux): Zen in a fake /opt/zen-browser-bin,
# profiles in ~/.zen or ~/.config/zen, the startup cache in ~/.cache. makepkg, pacman and sudo
# are stubs: the makepkg stub really runs packaging/arch/PKGBUILD's package() into a staging
# folder, and the pacman stub "installs" that folder's files under $T.
# Not exercised: a real makepkg/pacman, Zen's first launch, desktop notifications.
# Run: bash tests/linux.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$T"' EXIT

export CRANEZ_OS=Linux
export HOME="$T/home"
export FAKE_T="$T"
export CRANEZ_ZEN_DIRS="$T/opt/zen-browser-bin:$T/opt/zen-browser"
export CRANEZ_PROFILE_TIMEOUT=5
export CRANEZ_QUIT_GRACE=5
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset ZEN_APP ZEN_DATA ZEN_PROFILE XDG_CONFIG_HOME XDG_CACHE_HOME XDG_STATE_HOME
APP="$T/opt/zen-browser-bin"
NAME="abc123.Default (release)"
mkdir -p "$HOME" "$T/stubs" "$T/opt"
PATH="$T/stubs:$PATH"

fails=0
check() {
  local msg="$1"
  shift
  if "$@"; then echo "  ok    $msg"; else echo "  FAIL  $msg"; fails=$((fails + 1)); fi
}
count() { grep -c "$1" "$2" || true; }

make_zen() {
  mkdir -p "$APP"
  printf '[App]\nVendor=Zen\nName=Zen\nVersion=1.17.2b\n' >"$APP/application.ini"
}
# $1: the folder Zen keeps profiles in.
make_profile() {
  mkdir -p "$1/$NAME"
  touch "$1/$NAME/prefs.js"
  printf '[Install4F96D1932A9F858E]\nDefault=%s\nLocked=1\n\n[Profile0]\nName=Default\nIsRelative=1\nPath=%s\nDefault=1\n' \
    "$NAME" "$NAME" >"$1/profiles.ini"
}

# --- stubs -------------------------------------------------------------------
cat >"$T/stubs/sudo" <<'EOF'
#!/bin/bash
echo "$*" >>"$FAKE_T/sudo.log"
exec "$@"
EOF
# GNU install's -D (create leading dirs), which BSD install lacks.
cat >"$T/stubs/install" <<'EOF'
#!/bin/bash
args=() mkd=0
for a in "$@"; do
  if [[ "$a" == -D* ]]; then mkd=1; a="-${a#-D}"; [[ "$a" == - ]] && continue; fi
  args+=("$a")
done
if [[ $mkd -eq 1 ]]; then mkdir -p "$(dirname "${args[${#args[@]}-1]}")"; fi
exec /usr/bin/install "${args[@]}"
EOF
# Runs the real PKGBUILD's package() and writes a "package" that names the staging folder.
cat >"$T/stubs/makepkg" <<'EOF'
#!/bin/bash
echo "$* ZEN_APP=${ZEN_APP:-}" >>"$FAKE_T/makepkg.log"
set -e
startdir="$PWD"
pkgdir="$BUILDDIR/pkg"
rm -rf "$pkgdir"
mkdir -p "$pkgdir" "$PKGDEST"
# shellcheck disable=SC1091
source ./PKGBUILD
package
echo "$pkgdir" >"$PKGDEST/$pkgname-$pkgver-$pkgrel-any.pkg.tar.zst"
EOF
cat >"$T/stubs/pacman" <<'EOF'
#!/bin/bash
echo "$*" >>"$FAKE_T/pacman.log"
case "$1" in
  -Q)
    [[ -f "$FAKE_T/installed" ]] || exit 1
    echo "cranez-git $(cat "$FAKE_T/installed")"
    ;;
  -U)
    pkg="${*: -1}"
    root="$(cat "$pkg")"
    rm -rf "$FAKE_T/usr"
    cp -R "$root/usr" "$FAKE_T/usr"
    cp -R "$root$FAKE_T/opt/." "$FAKE_T/opt/"
    v="$(basename "$pkg")"
    v="${v#cranez-git-}"
    echo "${v%-any.pkg.tar.zst}" >"$FAKE_T/installed"
    ;;
  -R) rm -f "$FAKE_T/installed" ;;
esac
EOF
for s in launchctl osascript; do
  # shellcheck disable=SC2016  # $* and $FAKE_T expand when the stub runs
  printf '#!/bin/bash\necho "$*" >>"$FAKE_T/%s.log"\n' "$s" >"$T/stubs/$s"
done
chmod +x "$T"/stubs/*

# --- plain install from a copy (no git, no package) ------------------------
KIT="$T/kit"
cp -R "$ROOT" "$KIT"
rm -rf "$KIT/.git" "$KIT/.superpowers" "$KIT/graft"
make_zen
make_profile "$HOME/.zen"
P="$HOME/.zen/$NAME"
CACHE="$HOME/.cache/zen/$NAME/startupCache"
mkdir -p "$CACHE"

bash "$KIT/cranez.sh" install >"$T/o1" 2>&1
check "install exits 0" test $? -eq 0
check "found the profile in ~/.zen" grep -qF "profile: $NAME" "$T/o1"
check "read Zen's version from application.ini" grep -q "Zen 1.17.2b" "$T/o1"
check "loader copied into Zen's folder" cmp -s "$KIT/vendor/fx-autoconfig/program/config.js" "$APP/config.js"
check "loader prefs copied" cmp -s "$KIT/vendor/fx-autoconfig/program/defaults/pref/config-prefs.js" "$APP/defaults/pref/config-prefs.js"
check "scripts in profile" cmp -s "$KIT/scripts/pip-swipe.uc.js" "$P/chrome/JS/pip-swipe.uc.js"
check "startup cache in ~/.cache cleared" test ! -d "$CACHE"
check "Linux shortcut in the done message" grep -q 'Ctrl+Shift+J' "$T/o1"

bash "$KIT/cranez.sh" status >"$T/o2" 2>&1
check "status: loader in Zen's folder" grep -qF "✓ Loader in Zen ($APP)" "$T/o2"
check "status: not packaged yet" grep -q 'Not packaged' "$T/o2"
check "status: no launchd" test ! -e "$T/launchctl.log"

check "app-dir finds zen-browser-bin" test "$(bash "$KIT/cranez.sh" app-dir)" = "$APP"
bash "$KIT/cranez.sh" watch-on >"$T/o3" 2>&1
check "watch-on: not needed on Linux" grep -q 'No update watcher needed' "$T/o3"
check "watch-on: no launchd, no osascript" test ! -e "$T/launchctl.log" -a ! -e "$T/osascript.log"
bash "$KIT/cranez.sh" update >"$T/o4" 2>&1
check "update without a clone explains" grep -q "Can't find the git clone" "$T/o4"

bash "$KIT/cranez.sh" uninstall >/dev/null 2>&1
check "uninstall: scripts gone" test -z "$(ls -A "$P/chrome/JS")"
check "uninstall: copied loader gone" test ! -f "$APP/config.js"

# XDG profile folder (newer Zen builds).
rm -rf "$HOME/.zen"
make_profile "$HOME/.config/zen"
bash "$KIT/cranez.sh" status >"$T/o5" 2>&1
check "finds the profile in ~/.config/zen" grep -qF "Profile: $HOME/.config/zen/$NAME" "$T/o5"
rm -rf "$HOME/.config/zen"

# No Zen anywhere.
mv "$APP" "$T/zen-away"
CRANEZ_ZEN_DIRS="$T/nope" bash "$KIT/cranez.sh" app-dir >"$T/o6" 2>&1
check "no Zen: app-dir fails" test $? -ne 0
PATH="$T/stubs:/usr/bin:/bin" CRANEZ_ZEN_DIRS="$T/nope" bash "$KIT/cranez.sh" setup >"$T/o7" 2>&1
check "no Zen and no yay: setup names the AUR package" grep -q 'zen-browser-bin' "$T/o7"
mv "$T/zen-away" "$APP"

# --- setup from a git clone: builds and installs the cranez-git package -----
git init -q --bare -b main "$T/remote.git"
git -C "$KIT" init -q -b main
git -C "$KIT" add -A
git -C "$KIT" commit -qm init
git -C "$KIT" push -q "$T/remote.git" main
git clone -q "$T/remote.git" "$T/clone"
rm -rf "$KIT"
CLONE="$T/clone"

# First launch makes the profile: Zen's binary creates it, then runs until asked to quit.
mkdir -p "$HOME"
cat >"$APP/zen" <<EOF
#!/bin/bash
mkdir -p "$HOME/.zen/$NAME" && touch "$HOME/.zen/$NAME/prefs.js"
printf '[Profile0]\nName=Default\nIsRelative=1\nPath=%s\nDefault=1\n' "$NAME" >"$HOME/.zen/profiles.ini"
sleep 30
EOF
chmod +x "$APP/zen"

DISPLAY=:0 bash "$CLONE/cranez.sh" setup >"$T/s1" 2>&1
rc=$?
check "setup exits 0" test $rc -eq 0
check "setup opened Zen to create the profile" test -f "$HOME/.zen/profiles.ini"
check "setup asked Zen to quit" test -z "$(pgrep -f "$APP/zen" || true)"
check "makepkg built from the clone for this Zen" grep -qF "ZEN_APP=$APP" "$T/makepkg.log"
check "pacman installed it, overwriting an unowned loader" grep -qE -- "-U --noconfirm --overwrite $APP/config.js" "$T/pacman.log"
check "via sudo" grep -q 'pacman -U' "$T/sudo.log"
check "package put the loader in Zen's folder" cmp -s "$CLONE/vendor/fx-autoconfig/program/config.js" "$APP/config.js"
check "package ships cranez.sh and scripts" test -f "$T/usr/share/cranez/cranez.sh" -a -f "$T/usr/share/cranez/scripts/dev-bar.uc.js"
check "package ships the cranez command" test -x "$T/usr/bin/cranez"
check "package records its clone" test "$(cat "$T/usr/share/cranez/.source")" = "$(cd "$CLONE" && pwd -P)"
check "package version from git" grep -qE '^r1\.[0-9a-f]+-1$' "$T/installed"
check "scripts installed in the new profile" cmp -s "$CLONE/scripts/little-arc.uc.js" "$HOME/.zen/$NAME/chrome/JS/little-arc.uc.js"
check "no watcher on Linux" grep -q 'No update watcher needed' "$T/s1"
check "status shows the package" grep -q 'Package cranez-git r1\.' "$T/s1"

DISPLAY=:0 bash "$CLONE/cranez.sh" setup >"$T/s2" 2>&1
check "re-run: exits 0" test $? -eq 0
check "re-run: same commit isn't rebuilt" test "$(count . "$T/makepkg.log")" -eq 1

# A new commit upstream; the packaged cranez pulls and rebuilds.
git clone -q "$T/remote.git" "$T/dev"
echo "// change" >>"$T/dev/scripts/dev-bar.uc.js"
git -C "$T/dev" commit -qam change
git -C "$T/dev" push -q origin main
DISPLAY=:0 CRANEZ_CLI_NAME=cranez bash "$T/usr/share/cranez/cranez.sh" update >"$T/s3" 2>&1
check "update: exits 0" test $? -eq 0
check "update: pulled the clone" test "$(git -C "$CLONE" rev-parse HEAD)" = "$(git -C "$T/dev" rev-parse HEAD)"
check "update: rebuilt the package" grep -qE '^r2\.' "$T/installed"
check "update: new script in the profile" cmp -s "$T/dev/scripts/dev-bar.uc.js" "$HOME/.zen/$NAME/chrome/JS/dev-bar.uc.js"

CRANEZ_CLI_NAME=cranez bash "$T/usr/share/cranez/cranez.sh" uninstall >"$T/s4" 2>&1
check "uninstall: removes the package" grep -q -- '-R --noconfirm cranez-git' "$T/pacman.log"
check "uninstall: profile scripts gone" test -z "$(ls -A "$HOME/.zen/$NAME/chrome/JS")"

if [[ $fails -eq 0 ]]; then echo "linux: all checks passed"; else echo "linux: $fails check(s) failed"; fi
exit $((fails > 0))
