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

# Tests unitaires Node : ils ne dépendent pas du navigateur et doivent passer
# avant la campagne Playwright. Un échec interrompt la campagne.
status=0
for test in tests/unit/*.test.js; do
  echo
  echo "== $test =="
  "$NODE" "$test" || status=1
done
if [ "$status" -ne 0 ]; then
  echo "Tests unitaires en échec : campagne navigateur interrompue." >&2
  exit "$status"
fi

if [ "$#" -eq 0 ]; then
  set -- s1-import.js s2-folder.js s3-settings.js s4-offline.js s5-nopkg.js s6-audio.js s7-share.js
fi

# Un scénario doit sortir en code non nul si une assertion échoue (voir
# tests/lib.js). run.sh agrège ces codes et, ceinture et bretelles, considère
# aussi comme un échec toute ligne [ÉCHEC] ou ERREUR GÉNÉRALE dans la sortie :
# un scénario futur qui oublierait la convention reste ainsi détecté.
# Le motif est ancré en début de ligne : les résumés JSON (qui contiennent
# "outcome": "ÉCHEC") et les tests négatifs attendus ([OK]) ne matchent pas.
SCENARIO_LOG=$(mktemp)
trap 'rm -f "$SCENARIO_LOG"' EXIT
failed=()
for script in "$@"; do
  echo
  echo "== $script =="
  : > "$SCENARIO_LOG"
  env -u LD_LIBRARY_PATH CHROMIUM="$CHROMIUM" "$NODE" "tests/$script" 2>&1 | tee "$SCENARIO_LOG"
  code=${PIPESTATUS[0]}
  reason=""
  if [ "$code" -ne 0 ]; then
    reason="code $code"
  fi
  if grep -qE '^\[ÉCHEC\]|^ERREUR GÉNÉRALE' "$SCENARIO_LOG"; then
    reason="${reason:+$reason, }ÉCHEC dans la sortie"
  fi
  if [ -n "$reason" ]; then
    status=1
    failed+=("$script ($reason)")
  fi
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo
  echo "Scénarios en échec : ${failed[*]}" >&2
fi
exit "$status"
