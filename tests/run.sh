#!/bin/bash
# Runs every check that works without Zen or macOS. Exit code is non-zero on any failure.
# Run: bash tests/run.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

status=0
step() { echo; echo "== $1"; }

step "syntax: scripts/*.uc.js"
for f in scripts/*.uc.js; do
  if node --check "$f"; then echo "  ok    $f"; else status=1; fi
done

step "lint: shell"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -s bash cranez.sh bin/cranez tests/*.sh && echo "  ok    shellcheck" || status=1
else
  echo "  skip  shellcheck not installed (brew install shellcheck)"
fi

step "arc-pip";     node tests/arc-pip.test.js || status=1
step "pip-swipe";   node tests/pip-swipe.test.js || status=1
step "tab-expiry";  node tests/tab-expiry.test.js || status=1
step "little-arc";  node tests/little-arc.test.js || status=1
step "installer";   bash tests/installer.test.sh || status=1
step "setup";       bash tests/setup.test.sh || status=1
step "cli";         bash tests/cli.test.sh || status=1

echo
if [[ $status -eq 0 ]]; then echo "ALL PASSED"; else echo "FAILURES (see above)"; fi
exit $status
