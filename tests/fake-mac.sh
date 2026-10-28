#!/bin/bash
# Shared fake Mac for the setup and cli suites. Source it; it defines things and runs nothing.
# The macOS tools setup calls (brew, open, osascript, launchctl) are stubs on PATH that log
# their arguments to $T/<name>.log. cp passes through to /bin/cp, except that it fails like
# macOS App Management ("Operation not permitted") on Zen.app while $T/block-app exists.
# shellcheck disable=SC2034  # P, KIT, fails are used by the suites that source this

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$T"' EXIT

export HOME="$T/home"
export ZEN_APP="$T/Applications/Zen.app"
export ZEN_DATA="$HOME/Library/Application Support/zen"
export CRANEZ_PROFILE_TIMEOUT=3
export CRANEZ_QUIT_GRACE=5
export FAKE_T="$T"
export PROFILE_NAME="abc123.Default (release)"
P="$ZEN_DATA/Profiles/$PROFILE_NAME"
mkdir -p "$HOME" "$T/stubs"
PATH="$T/stubs:$PATH"

# What Zen does on first launch: create its profile and point profiles.ini at it.
cat >"$T/make-profile" <<'EOF'
#!/bin/bash
mkdir -p "$ZEN_DATA/Profiles/$PROFILE_NAME"
touch "$ZEN_DATA/Profiles/$PROFILE_NAME/prefs.js"
cat >"$ZEN_DATA/profiles.ini" <<INI
[Install6ED35B3CA1B5D3AE]
Default=Profiles/$PROFILE_NAME
Locked=1

[Profile0]
Name=Default (release)
IsRelative=1
Path=Profiles/$PROFILE_NAME
Default=1
INI
EOF
# Like the real cask: `install` is a no-op once the cask is recorded as installed, even if
# Zen.app was deleted by hand; `reinstall` always puts the app back. The app's "binary" runs
# for 2s, as if Zen took a moment to quit.
cat >"$T/stubs/brew" <<'EOF'
#!/bin/bash
echo "$*" >>"$FAKE_T/brew.log"
case "$*" in
  "list --cask zen") [[ -e "$FAKE_T/cask-installed" ]]; exit ;;
  "install --cask zen") [[ -e "$FAKE_T/cask-installed" ]] && exit 0 ;;
  "reinstall --cask zen") ;;
  *) exit 0 ;;
esac
touch "$FAKE_T/cask-installed"
mkdir -p "$ZEN_APP/Contents/Resources" "$ZEN_APP/Contents/MacOS"
printf '#!/bin/bash\nsleep 2\n' >"$ZEN_APP/Contents/MacOS/zen"
chmod +x "$ZEN_APP/Contents/MacOS/zen"
EOF
# Opening Zen (after the Gatekeeper click) starts it, and a first launch creates the profile.
cat >"$T/stubs/open" <<'EOF'
#!/bin/bash
echo "$*" >>"$FAKE_T/open.log"
if [[ "${1:-}" == "$ZEN_APP" && ! -e "$FAKE_T/no-profile-on-open" ]]; then
  [[ -d "$ZEN_DATA" ]] || "$FAKE_T/make-profile"
  if [[ -x "$ZEN_APP/Contents/MacOS/zen" ]]; then "$ZEN_APP/Contents/MacOS/zen" >/dev/null 2>&1 & fi
fi
EOF
for s in osascript launchctl; do
  # shellcheck disable=SC2016  # $* and $FAKE_T expand when the stub runs
  printf '#!/bin/bash\necho "$*" >>"$FAKE_T/%s.log"\n' "$s" >"$T/stubs/$s"
done
cat >"$T/stubs/cp" <<'EOF'
#!/bin/bash
if [[ -e "$FAKE_T/block-app" ]]; then
  for a in "$@"; do
    case "$a" in
      */Contents/Resources*) echo "cp: $a: Operation not permitted" >&2; exit 1 ;;
    esac
  done
fi
exec /bin/cp "$@"
EOF
chmod +x "$T/make-profile" "$T"/stubs/*

fails=0
check() {
  local msg="$1"
  shift
  if "$@"; then echo "  ok    $msg"; else echo "  FAIL  $msg"; fails=$((fails + 1)); fi
}
count() { grep -c "$1" "$2" || true; }

make_zen_app() { mkdir -p "$ZEN_APP/Contents/Resources" "$ZEN_APP/Contents/MacOS"; }
make_profile() { "$T/make-profile"; }
# A copy of the working tree (uncommitted changes included) without git or scratch dirs.
make_kit() {
  KIT="$T/kit"
  cp -R "$ROOT" "$KIT"
  rm -rf "$KIT/.git" "$KIT/.superpowers" "$KIT/graft"
}
finish() {
  if [[ $fails -eq 0 ]]; then echo "$1: all checks passed"; else echo "$1: $fails check(s) failed"; fi
  exit $((fails > 0))
}
