#!/usr/bin/env bash
# Construit dist/ puis lance les scénarios de la campagne de tests.
# Usage : tests/run.sh [s1-import.js ...] (défaut : tous)
set -u
cd "$(dirname "$0")/.."

NODE=${NODE:-$(command -v node || true)}
if [ -z "${NODE:-}" ]; then
  echo "node introuvable : lancer depuis \`nix develop\` ou définir NODE" >&2
  exit 1
fi

CHROMIUM=${CHROMIUM:-/run/current-system/sw/bin/chromium}
export CHROMIUM

# Horloge murale en centièmes de seconde. EPOCHREALTIME est un builtin bash
# (secondes.microsecondes, séparateur dépendant de la locale), donc aucune
# commande externe n'est lancée pour mesurer les durées.
now_cs() {
  local t=${EPOCHREALTIME/[.,]/}
  echo $((10#$t / 10000))
}

# Centièmes de seconde -> secondes entières arrondies, pour l'affichage.
fmt_s() {
  echo $((($1 + 50) / 100))
}

campaign_t0=$(now_cs)

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

echo "== Build normal =="
"$NODE" build.js || exit 1
echo "== Build SPA =="
"$NODE" build.js --spa || exit 1

if [ "$#" -eq 0 ]; then
  set -- s1-import.js s2-folder.js s3-settings.js s4-offline.js s5-nopkg.js \
    s6a-transport.js s6b-suivi.js s6c-magnificat.js s6d-reprises.js s6e-robustesse.js \
    s7-share.js s8-boucle.js s9-synchro.js
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
# Compteurs de la campagne : le total doit être la somme des lignes
# [OK]/[ÉCHEC]/[SAUTÉ] et concorder avec les bilans des scénarios.
total_ok=0 total_ko=0 total_skip=0 total_assertions=0
scenarios_t0=$(now_cs)
for script in "$@"; do
  echo
  echo "== $script =="
  : > "$SCENARIO_LOG"
  script_t0=$(now_cs)
  env -u LD_LIBRARY_PATH CHROMIUM="$CHROMIUM" "$NODE" "tests/$script" 2>&1 | tee "$SCENARIO_LOG"
  code=${PIPESTATUS[0]}
  script_cs=$(($(now_cs) - script_t0))
  ok=$(grep -cE '^\[OK\]' "$SCENARIO_LOG" || true)
  ko=$(grep -cE '^\[ÉCHEC\]' "$SCENARIO_LOG" || true)
  skip=$(grep -cE '^\[SAUTÉ\]' "$SCENARIO_LOG" || true)
  lines=$((ok + ko + skip))
  # Bilan écrit par lib.js à la sortie du scénario (écriture synchrone).
  bilan=$(sed -n 's/^=== BILAN .* : \([0-9][0-9]*\) assertion(s).*/\1/p' "$SCENARIO_LOG" | tail -n 1)
  echo "   -> $script : $lines assertion(s) ($ok OK, $ko ÉCHEC, $skip SAUTÉ) ($(fmt_s "$script_cs") s)"
  total_ok=$((total_ok + ok)) total_ko=$((total_ko + ko)) total_skip=$((total_skip + skip))
  reason=""
  if [ "$code" -ne 0 ]; then
    reason="code $code"
  fi
  if grep -qE '^\[ÉCHEC\]|^ERREUR GÉNÉRALE' "$SCENARIO_LOG"; then
    reason="${reason:+$reason, }ÉCHEC dans la sortie"
  fi
  # Le compte lu dans la sortie doit être celui qu'a compté record() : sinon
  # des lignes ont été perdues (troncature, sortie brutale) et la campagne
  # serait verte avec un décompte faux.
  if [ -z "$bilan" ]; then
    reason="${reason:+$reason, }bilan d'assertions absent"
  else
    total_assertions=$((total_assertions + bilan))
    if [ "$bilan" -ne "$lines" ]; then
      reason="${reason:+$reason, }comptage incohérent ($lines ligne(s) pour $bilan assertion(s))"
    fi
  fi
  if [ -n "$reason" ]; then
    status=1
    failed+=("$script ($reason)")
  fi
done

echo
echo "Campagne : $total_assertions assertion(s) — $total_ok OK, $total_ko ÉCHEC, $total_skip SAUTÉ"
echo "Durée des scénarios : $(fmt_s $(( $(now_cs) - scenarios_t0 ))) s"
echo "Durée totale : $(fmt_s $(( $(now_cs) - campaign_t0 ))) s (tests unitaires, builds, scénarios)"
if [ "${#failed[@]}" -gt 0 ]; then
  echo
  echo "Scénarios en échec : ${failed[*]}" >&2
fi
exit "$status"