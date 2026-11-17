#!/usr/bin/env bash
# Construit dist/ puis lance les scénarios de la campagne de tests.
# Usage : tests/run.sh [s1-import.js ...] (défaut : tous)
set -u
cd "$(dirname "$0")/.."

SCRATCH=/tmp/claude-1000/-home-jacques-programmes-musique-cantus/73505585-ba9d-4437-9275-b28fef3b2ac0/scratchpad
if [ -n "${NODE:-}" ]; then
  :
elif [ -f "$SCRATCH/node-path" ]; then
  NODE=$(cat "$SCRATCH/node-path")
else
  NODE=$(command -v node || true)
fi
if [ -z "${NODE:-}" ]; then
  echo "node introuvable : lancer via nix-shell -p nodejs" >&2
  exit 1
fi

CHROMIUM=${CHROMIUM:-/run/current-system/sw/bin/chromium}
export CHROMIUM

echo "== Build normal =="
nix-shell -p nodejs --run "node build.js" || exit 1
echo "== Build SPA =="
nix-shell -p nodejs --run "node build.js --spa" || exit 1

if [ "$#" -eq 0 ]; then
  set -- s1-import.js s2-folder.js s3-settings.js s4-offline.js s5-nopkg.js s6-audio.js
fi

status=0
for script in "$@"; do
  echo
  echo "== $script =="
  env -u LD_LIBRARY_PATH CHROMIUM="$CHROMIUM" "$NODE" "tests/$script" || status=1
done
exit "$status"
