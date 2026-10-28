#!/bin/bash
# cranez: Arc features for Zen. Installs the loader, scripts and prefs on any Mac.
#
#   ./cranez.sh setup       everything: Zen, its profile, loader, scripts, prefs, watcher
#   ./cranez.sh install     loader + scripts + prefs (quit Zen first)
#   ./cranez.sh loader      re-enable scripts after a Zen update
#   ./cranez.sh status      show what's installed
#   ./cranez.sh capture     save the prefs you tuned in about:config into the kit
#   ./cranez.sh watch-on    notify (and try to auto-fix) after Zen updates
#   ./cranez.sh watch-off
#   ./cranez.sh uninstall   remove everything this kit added
#
# Overrides: ZEN_APP=/path/to/Zen.app   ZEN_PROFILE=/path/to/profile
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ME="${CRANEZ_CLI_NAME:-$0}"  # what to tell the owner to run (bin/cranez sets "cranez")
APP="${ZEN_APP:-/Applications/Zen.app}"
RES="$APP/Contents/Resources"
ZEN_DATA="${ZEN_DATA:-$HOME/Library/Application Support/zen}"
LOADER="$KIT/vendor/fx-autoconfig"
PREFS_FILE="$KIT/zen-prefs.js"
STATE_DIR="$HOME/Library/Application Support/cranez"
AGENT_LABEL="com.cranez.update-watch"
OLD_AGENT_LABEL="com.zen-kit.update-watch"  # pre-rename name, cleaned up on watch-on/off
AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
PROFILE=""

if [[ -t 1 ]]; then
  G=$'\033[32m' R=$'\033[31m' Y=$'\033[33m' N=$'\033[0m'
else
  G="" R="" Y="" N=""
fi
ok()     { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
warn()   { printf '%s!%s %s\n' "$Y" "$N" "$*"; }
bad()    { printf '%s✗%s %s\n' "$R" "$N" "$*"; }
die()    { bad "$*"; exit 1; }
notify() { /usr/bin/osascript -e "display notification \"$1\" with title \"cranez\"" >/dev/null 2>&1 || true; }

zen_version() {
  /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist" 2>/dev/null || echo "?"
}

zen_running() { /usr/bin/pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1; }

require_quit() {
  if zen_running; then
    die "Zen is running. Quit it (Cmd+Q) and run this again."
  fi
}

# --------------------------------------------------------------------------
# Profile: the one Zen actually opens (profiles.ini [Install...] Default=),
# else the profile marked Default=1, else the first one listed.
# --------------------------------------------------------------------------
find_profile() {
  if [[ -n "${ZEN_PROFILE:-}" ]]; then
    PROFILE="$ZEN_PROFILE"
  else
    local ini="$ZEN_DATA/profiles.ini" rel
    [[ -f "$ini" ]] || die "No Zen profile yet ($ini missing). Open Zen once, quit it, then run this again."
    rel=$(awk '
      /^\[/ { insec = ($0 ~ /^\[Install/); next }
      insec && /^Default=/ { print substr($0, 9); exit }' "$ini")
    if [[ -z "$rel" ]]; then
      rel=$(awk '
        function flush() { if (inprof && def && path != "") { print path; done = 1; exit } }
        /^\[/ { flush(); inprof = ($0 ~ /^\[Profile/); path = ""; def = 0; next }
        inprof && /^Path=/ { path = substr($0, 6) }
        inprof && /^Default=1/ { def = 1 }
        END { if (!done) flush() }' "$ini")
    fi
    if [[ -z "$rel" ]]; then
      rel=$(awk '/^Path=/ { print substr($0, 6); exit }' "$ini")
    fi
    [[ -n "$rel" ]] || die "Couldn't find a profile in $ini. Set ZEN_PROFILE=/path/to/profile."
    if [[ "$rel" == /* ]]; then PROFILE="$rel"; else PROFILE="$ZEN_DATA/$rel"; fi
  fi
  [[ -d "$PROFILE" ]] || die "Profile folder not found: $PROFILE"
}

# --------------------------------------------------------------------------
# App side: the two loader files inside Zen.app (wiped by every Zen update)
# --------------------------------------------------------------------------
loader_current() {
  cmp -s "$LOADER/program/config.js" "$RES/config.js" &&
    cmp -s "$LOADER/program/defaults/pref/config-prefs.js" "$RES/defaults/pref/config-prefs.js"
}

# 0 = copied, 2 = blocked by macOS App Management, 1 = other failure
copy_loader() {
  local s="${1:-}" err
  err=$(mktemp)
  if { $s cp "$LOADER/program/config.js" "$RES/config.js" &&
       $s mkdir -p "$RES/defaults/pref" &&
       $s cp "$LOADER/program/defaults/pref/config-prefs.js" "$RES/defaults/pref/config-prefs.js"; } 2>"$err"; then
    rm -f "$err"
    return 0
  fi
  if grep -q "Operation not permitted" "$err"; then
    rm -f "$err"
    return 2
  fi
  cat "$err" >&2
  rm -f "$err"
  return 1
}

install_loader() {
  [[ -d "$RES" ]] || die "Zen not found at $APP (set ZEN_APP=/path/to/Zen.app)."
  if loader_current; then
    ok "Loader already in Zen.app"
    return 0
  fi
  local rc=0
  copy_loader || rc=$?
  if [[ $rc -eq 1 && -t 0 ]]; then
    warn "Plain copy failed; retrying with sudo"
    rc=0
    copy_loader sudo || rc=$?
  fi
  case $rc in
    0) ok "Loader installed into Zen.app" ;;
    2)
      bad "macOS blocked writing into Zen.app."
      echo "   System Settings → Privacy & Security → App Management → turn on your terminal app,"
      if [[ -n "${SETUP:-}" ]]; then
        open "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles" >/dev/null 2>&1 || true
        echo "   quit and reopen the terminal, then run: $ME setup"
      else
        echo "   quit and reopen the terminal, then run: $ME loader"
      fi
      exit 1
      ;;
    *) die "Couldn't install the loader into $RES" ;;
  esac
}

# --------------------------------------------------------------------------
# Profile side: loader utils + scripts (survive Zen updates)
# --------------------------------------------------------------------------
install_profile() {
  local chrome="$PROFILE/chrome" js="$PROFILE/chrome/JS"
  local manifest="$js/.cranez-manifest" f name

  mkdir -p "$js" "$chrome/resources"
  rm -rf "$chrome/utils"
  cp -R "$LOADER/profile/chrome/utils" "$chrome/utils"
  ok "Loader files in profile"

  # Pre-rename manifest: adopt it once.
  if [[ -f "$js/.zen-kit-manifest" ]]; then
    cat "$js/.zen-kit-manifest" >>"$manifest"
    rm -f "$js/.zen-kit-manifest"
  fi
  # Scripts this kit installed before but no longer ships.
  if [[ -f "$manifest" ]]; then
    while IFS= read -r name; do
      if [[ -n "$name" && ! -f "$KIT/scripts/$name" && -f "$js/$name" ]]; then
        rm -f "$js/$name"
        warn "Removed retired script $name"
      fi
    done <"$manifest"
  fi
  # Old versioned copies from before the file names were made stable.
  for f in "$js"/little-arc-v*.uc.js "$js"/pip-swipe-v*.uc.js; do
    if [[ -e "$f" ]]; then
      rm -f "$f"
      warn "Removed old copy $(basename "$f")"
    fi
  done

  : >"$manifest"
  for f in "$KIT"/scripts/*.uc.js; do
    cp "$f" "$js/"
    basename "$f" >>"$manifest"
  done
  ok "Scripts installed: $(tr '\n' ' ' <"$manifest")"
}

# Every documented script pref (header lines like " *   pipswipe.margin  int ..."), minus
# per-Mac state and debug switches, plus the PiP prefs zen-prefs.js manages.
syncable_prefs() {
  {
    awk '/^ \*   (arcpip|arclittle|pipswipe|tabexpiry|devbar)\.[a-z_]+ / { print $2 }' "$KIT"/scripts/*.uc.js |
      grep -vE '\.debug$|^devbar\.visible$|^tabexpiry\.run_now$'
    echo "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled"
    echo "media.videocontrols.picture-in-picture.enable-when-occluded.enabled"
  } | sort -u
}

# Zen must be quit. zen-prefs.js only fills in prefs this profile doesn't have yet (tuned
# values travel through Firefox Sync, so never overwrite them); then Sync is turned on for
# every cranez pref. The services.sync.* control prefs are ours and are rewritten each time.
apply_prefs() {
  local pj="$PROFILE/prefs.js" tmp line name names added=0
  touch "$pj"
  # A last line without a newline would swallow the first pref appended after it.
  if [[ -n "$(tail -c 1 "$pj")" ]]; then echo >>"$pj"; fi
  if [[ -f "$PREFS_FILE" ]]; then
    while IFS= read -r line; do
      name=$(printf '%s\n' "$line" | awk -F'"' '{ print $2 }')
      if ! grep -qF "user_pref(\"$name\"," "$pj"; then
        printf '%s\n' "$line" >>"$pj"
        added=$((added + 1))
      fi
    done < <(grep -E '^user_pref\("' "$PREFS_FILE" || true)
  fi
  ok "Applied $added new default pref(s) from zen-prefs.js"

  names=$(syncable_prefs)
  tmp=$(mktemp)
  awk -F'"' 'NR == FNR { drop["services.sync.prefs.sync." $0] = 1; next }
    !(/^user_pref\("/ && ($2 in drop || $2 == "services.sync.prefs.dangerously_allow_arbitrary"))' \
    <(printf '%s\n' "$names") "$pj" >"$tmp"
  echo 'user_pref("services.sync.prefs.dangerously_allow_arbitrary", true);' >>"$tmp"
  printf '%s\n' "$names" | awk '{ printf "user_pref(\"services.sync.prefs.sync.%s\", true);\n", $0 }' >>"$tmp"
  mv "$tmp" "$pj"
  ok "Sync on for $(printf '%s\n' "$names" | wc -l | tr -d ' ') cranez pref(s)"
}

clear_startup_cache() {
  local name found=0 d
  name="$(basename "$PROFILE")"
  while IFS= read -r d; do
    rm -rf "$d"
    found=1
  done < <(find "$HOME/Library/Caches" -maxdepth 5 -type d -name startupCache -path "*/$name/*" 2>/dev/null)
  if [[ $found -eq 1 ]]; then ok "Startup cache cleared"; else ok "No startup cache to clear"; fi
}

# --------------------------------------------------------------------------
# Setup: get a Mac from "only Homebrew" to a Zen that's ready for install
# --------------------------------------------------------------------------
has_profile() { (find_profile) >/dev/null 2>&1; }

ensure_zen() {
  if [[ -d "$APP" ]]; then return 0; fi
  if ! command -v brew >/dev/null 2>&1; then
    die "Zen isn't installed and Homebrew isn't on PATH. Install Homebrew (https://brew.sh) or Zen, then run $ME setup again."
  fi
  echo "Installing Zen with Homebrew…"
  brew install --cask zen
  [[ -d "$APP" ]] || die "Homebrew installed Zen, but it isn't at $APP (set ZEN_APP=/path/to/Zen.app)."
  ok "Zen installed"
}

# Zen creates its own profile on first launch. Open it normally so macOS can show its one-time
# "downloaded from the internet" confirmation, wait for the profile, then ask Zen to quit.
ensure_profile() {
  if has_profile; then return 0; fi
  local t="${CRANEZ_PROFILE_TIMEOUT:-300}" i=0
  open "$APP"
  echo "Opening Zen once to create its profile. If macOS asks, click Open."
  until has_profile; do
    if [[ $i -ge $t ]]; then
      die "Zen didn't create a profile in ${t}s. Open Zen once, quit it, then run $ME setup again."
    fi
    sleep 1
    i=$((i + 1))
  done
  osascript -e 'tell application id "app.zen-browser.zen" to quit' >/dev/null 2>&1 || true
  ok "Zen profile created"
}

wait_for_quit() {
  zen_running || return 0
  echo "Quit Zen (⌘Q) to continue…"
  while zen_running; do sleep 1; done
}

# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------
cmd_setup() {
  ensure_zen
  ensure_profile
  wait_for_quit
  SETUP=1 cmd_install
  echo
  cmd_watch_on
  echo
  cmd_status
  echo "cranez checkout: $(git -C "$KIT" rev-parse --short HEAD 2>/dev/null || echo '?')"
  if [[ ! -f "$PROFILE/signedInUser.json" ]]; then
    warn "Sign in to your Mozilla account in Zen so cranez prefs sync between your Macs."
  fi
}

cmd_install() {
  find_profile
  require_quit
  echo "Zen $(zen_version) · profile: $(basename "$PROFILE")"
  install_profile
  apply_prefs
  clear_startup_cache
  install_loader
  echo
  ok "Done. Open Zen; the Browser Console (Cmd+Shift+J) shows a 'loaded' line for each script."
}

cmd_loader() {
  install_loader
  if zen_running; then
    echo "Quit and reopen Zen to load the scripts."
  fi
}

cmd_status() {
  find_profile
  echo "Zen:     $APP ($(zen_version))"
  echo "Profile: $PROFILE"
  if loader_current; then ok "Loader in Zen.app"; else bad "Loader missing from Zen.app → $ME loader"; fi
  if [[ -f "$PROFILE/chrome/utils/boot.sys.mjs" ]]; then ok "Loader in profile"; else bad "Loader missing from profile → $ME install"; fi
  local f n
  for f in "$KIT"/scripts/*.uc.js; do
    n=$(basename "$f")
    if cmp -s "$f" "$PROFILE/chrome/JS/$n"; then
      ok "$n"
    elif [[ -f "$PROFILE/chrome/JS/$n" ]]; then
      warn "$n differs from the kit → $ME install"
    else
      bad "$n not installed → $ME install"
    fi
  done
  if launchctl print "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1; then
    ok "Update watcher on"
  else
    warn "Update watcher off (optional: $ME watch-on)"
  fi
}

cmd_capture() {
  find_profile
  local pj="$PROFILE/prefs.js" tmp n
  [[ -f "$pj" ]] || die "No prefs.js in $PROFILE"
  if zen_running; then
    warn "Zen is running; quit it first if you changed prefs in the last few seconds."
  fi
  tmp=$(mktemp)
  {
    grep -E '^user_pref\("' "$PREFS_FILE" 2>/dev/null || true
    grep -E '^user_pref\("(arcpip|arclittle|pipswipe|tabexpiry|devbar)\.' "$pj" |
      grep -vE '"(devbar\.visible|tabexpiry\.run_now)"|\.debug"' || true
    grep -E '^user_pref\("media\.videocontrols\.picture-in-picture\.enable-when-(switching-tabs|occluded)\.enabled"' "$pj" || true
  } | awk -F'"' '{ last[$2] = $0; if (!($2 in seen)) { seen[$2] = 1; order[++n] = $2 } }
                 END { for (i = 1; i <= n; i++) print last[order[i]] }' >"$tmp"
  # shellcheck disable=SC2016  # backticks are literal text in the header
  {
    echo '// Defaults for a brand-new Mac. `install` only sets the ones a profile doesn'"'"'t have yet;'
    echo '// tuned values travel between Macs through your Mozilla account (Firefox Sync).'
    echo '// To change these defaults: in a dev clone, quit Zen, run `./cranez.sh capture`, commit.'
    cat "$tmp"
  } >"$PREFS_FILE"
  n=$(wc -l <"$tmp" | tr -d ' ')
  rm -f "$tmp"
  ok "Saved $n pref(s) to zen-prefs.js"
}

cmd_after_update() {
  # Run by the LaunchAgent when Zen.app changes. Never prompts.
  [[ -d "$RES" ]] || exit 0
  loader_current && exit 0
  local ver stamp
  ver=$(zen_version)
  mkdir -p "$STATE_DIR"
  if copy_loader; then
    notify "Zen $ver installed. Scripts re-enabled: quit and reopen Zen once to load them."
  else
    stamp="$STATE_DIR/notified-$ver"
    [[ -f "$stamp" ]] && exit 0
    touch "$stamp"
    notify "Zen $ver turned your scripts off. Run: cranez loader"
  fi
}

cmd_watch_on() {
  local old
  old=$(grep -o '<string>[^<]*/cranez\.sh</string>' "$AGENT_PLIST" 2>/dev/null | sed 's/<[^>]*>//g' || true)
  if [[ -n "$old" && "$old" != "$KIT/cranez.sh" ]]; then
    warn "Watcher moved from $(dirname "$old") to $KIT; the old folder isn't used by the watcher any more."
  fi
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat >"$AGENT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$AGENT_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$KIT/cranez.sh</string>
    <string>after-update</string>
  </array>
  <key>WatchPaths</key>
  <array><string>$APP/Contents/Info.plist</string></array>
  <key>StartInterval</key><integer>21600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/cranez.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/cranez.log</string>
</dict>
</plist>
EOF
  remove_old_agent
  launchctl bootout "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST"
  ok "Update watcher on. After a Zen update it re-adds the loader if macOS allows it, otherwise it notifies you."
  echo "   It points at this folder ($KIT); run watch-on again if you move the kit."
}

remove_old_agent() {
  launchctl bootout "gui/$(id -u)/$OLD_AGENT_LABEL" >/dev/null 2>&1 || true
  rm -f "$HOME/Library/LaunchAgents/$OLD_AGENT_LABEL.plist"
}

cmd_watch_off() {
  remove_old_agent
  launchctl bootout "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1 || true
  rm -f "$AGENT_PLIST"
  ok "Update watcher off"
}

cmd_uninstall() {
  find_profile
  require_quit
  local js="$PROFILE/chrome/JS" name manifest
  for manifest in "$js/.cranez-manifest" "$js/.zen-kit-manifest"; do
    if [[ -f "$manifest" ]]; then
      while IFS= read -r name; do
        [[ -n "$name" ]] && rm -f "$js/$name"
      done <"$manifest"
      rm -f "$manifest"
    fi
  done
  rm -rf "$PROFILE/chrome/utils"
  ok "Scripts and loader removed from profile"
  if [[ -f "$RES/config.js" || -f "$RES/defaults/pref/config-prefs.js" ]]; then
    if rm -f "$RES/config.js" "$RES/defaults/pref/config-prefs.js" 2>/dev/null; then
      ok "Loader removed from Zen.app"
    else
      warn "Couldn't remove the loader from Zen.app (App Management). It's inert without the profile files; the next Zen update removes it anyway."
    fi
  fi
  cmd_watch_off
  echo "Prefs were left as they are (harmless without the scripts)."
}

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-help}" in
  setup) cmd_setup ;;
  install) cmd_install ;;
  loader) cmd_loader ;;
  status) cmd_status ;;
  capture) cmd_capture ;;
  watch-on) cmd_watch_on ;;
  watch-off) cmd_watch_off ;;
  after-update) cmd_after_update ;;
  uninstall) cmd_uninstall ;;
  *) usage ;;
esac
