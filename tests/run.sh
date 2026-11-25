#!/usr/bin/env bash
# Construit dist/ puis lance les scénarios de la campagne de tests.
# Usage : tests/run.sh [s1-import.js ...] (défaut : tous)
# Variable JOBS : nombre de scénarios lancés en parallèle (défaut 1 = série).
# Variable LOAD_MAX : avant chaque scénario, attendre que la charge sur 1 min
# par cœur repasse sous ce seuil (défaut 2.5 ; 0 = pas d'attente).
set -u
cd "$(dirname "$0")/.."

NODE=${NODE:-$(command -v node || true)}
if [ -z "${NODE:-}" ]; then
  echo "node introuvable : lancer depuis \`nix develop\` ou définir NODE" >&2
  exit 1
fi

CHROMIUM=${CHROMIUM:-/run/current-system/sw/bin/chromium}
export CHROMIUM

JOBS=${JOBS:-1}
LOAD_MAX=${LOAD_MAX:-2.5}
if ! [[ $JOBS =~ ^[1-9][0-9]*$ ]]; then
  echo "JOBS doit être un entier >= 1 (reçu : « $JOBS »)" >&2
  exit 2
fi

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
    s7-share.js s8-boucle.js s9-synchro.js s10-horizontal.js s11-launch.js \
    s12-export.js s13-ly-includes.js s14-gabc.js
fi

# Deux lots :
#  - en parallèle, JOBS scénarios à la fois : les scénarios indépendants, qui
#    ouvrent chacun leur serveur sur un port libre (tests/lib.js, listen(0)) ;
#  - en série, après le lot parallèle, un seul à la fois :
#      * s5-nopkg.js, qui reconstruit dist/ et ne peut donc pas cohabiter avec
#        un scénario en train de le servir ;
#      * les s6*.js, lecture audio, sensibles à la charge de la machine.
parallel_scripts=() serial_scripts=()
for script in "$@"; do
  case $script in
    s5-nopkg.js | s6*) serial_scripts+=("$script") ;;
    *) parallel_scripts+=("$script") ;;
  esac
done

# Un journal, un code de sortie, une durée et un marqueur de fin par scénario :
# les sorties des scénarios parallèles ne se mélangent jamais et seul le shell
# parent les affiche.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Attend que la machine soit assez peu chargée (plusieurs campagnes tournent
# souvent en même temps : agents, worktrees, autres projets).
wait_load() {
  local cores load last=-60
  cores=$(nproc)
  while :; do
    load=$(awk -v c="$cores" -v m="$LOAD_MAX" '{ l = $1 / c; if (m > 0 && l > m) printf "%.1f", l }' /proc/loadavg)
    [ -z "$load" ] && return
    if [ $(( SECONDS - last )) -ge 60 ]; then
      echo "   ... attente : charge $load/cœur > $LOAD_MAX"
      last=$SECONDS
    fi
    sleep 15
  done
}

# Lance un scénario (en tâche de fond quand il est appelé avec `&`). Le
# sous-shell ne peut pas modifier les variables du parent : code et durée
# passent par des fichiers, et le marqueur `.done` est écrit en dernier pour
# que sa présence garantisse que tout le reste est prêt.
run_bg() {
  local script=$1 base=$WORK/${script%.js} t0
  t0=$(now_cs)
  env -u LD_LIBRARY_PATH CHROMIUM="$CHROMIUM" "$NODE" "tests/$script" >"$base.log" 2>&1
  echo $? >"$base.code"
  echo $(($(now_cs) - t0)) >"$base.dur"
  : >"$base.done"
}

# Affiche la sortie d'un scénario d'un bloc, puis applique les vérifications de
# la campagne (identiques à la version série) et met à jour les compteurs.
#
# Un scénario doit sortir en code non nul si une assertion échoue (voir
# tests/lib.js). run.sh agrège ces codes et, ceinture et bretelles, considère
# aussi comme un échec toute ligne [ÉCHEC] ou ERREUR GÉNÉRALE dans la sortie :
# un scénario futur qui oublierait la convention reste ainsi détecté.
# Le motif est ancré en début de ligne : les résumés JSON (qui contiennent
# "outcome": "ÉCHEC") et les tests négatifs attendus ([OK]) ne matchent pas.
report() {
  local script=$1 base=$WORK/${script%.js}
  local log=$base.log code dur ok ko skip lines bilan reason
  code=$(cat "$base.code")
  dur=$(cat "$base.dur")
  echo
  echo "== $script =="
  cat "$log"
  ok=$(grep -cE '^\[OK\]' "$log" || true)
  ko=$(grep -cE '^\[ÉCHEC\]' "$log" || true)
  skip=$(grep -cE '^\[SAUTÉ\]' "$log" || true)
  lines=$((ok + ko + skip))
  # Bilan écrit par lib.js à la sortie du scénario (écriture synchrone).
  bilan=$(sed -n 's/^=== BILAN .* : \([0-9][0-9]*\) assertion(s).*/\1/p' "$log" | tail -n 1)
  echo "   -> $script : $lines assertion(s) ($ok OK, $ko ÉCHEC, $skip SAUTÉ) ($(fmt_s "$dur") s)"
  total_ok=$((total_ok + ok)) total_ko=$((total_ko + ko)) total_skip=$((total_skip + skip))
  reason=""
  if [ "$code" -ne 0 ]; then
    reason="code $code"
  fi
  if grep -qE '^\[ÉCHEC\]|^ERREUR GÉNÉRALE' "$log"; then
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
}

# Compteurs de la campagne : le total doit être la somme des lignes
# [OK]/[ÉCHEC]/[SAUTÉ] et concorder avec les bilans des scénarios.
failed=()
total_ok=0 total_ko=0 total_skip=0 total_assertions=0
scenarios_t0=$(now_cs)

# Lot parallèle : on démarre des scénarios tant qu'il reste de la place, on
# attend la fin d'un seul des scénarios en cours (`wait -n`), puis on affiche
# les rapports terminés pas encore affichés, dans l'ordre de lancement.
pending=("${parallel_scripts[@]}")
launched=()
while [ "${#pending[@]}" -gt 0 ] || [ "${#launched[@]}" -gt 0 ]; do
  while [ "${#launched[@]}" -lt "$JOBS" ] && [ "${#pending[@]}" -gt 0 ]; do
    script=${pending[0]}
    pending=("${pending[@]:1}")
    launched+=("$script")
    wait_load
    echo
    echo "   ... $script lancé (JOBS=$JOBS)"
    run_bg "$script" &
  done
  # Attendre un scénario : les autres continuent de tourner pendant ce temps.
  wait -n || true
  remaining=()
  for script in "${launched[@]}"; do
    if [ -f "$WORK/${script%.js}.done" ]; then
      report "$script"
    else
      remaining+=("$script")
    fi
  done
  launched=("${remaining[@]}")
done

# Lot série : jamais deux à la fois, et seulement après le lot parallèle.
if [ "${#serial_scripts[@]}" -gt 0 ]; then
  echo
  echo "Scénarios en série : ${serial_scripts[*]}"
fi
for script in "${serial_scripts[@]}"; do
  echo
  wait_load
  echo "   ... $script lancé (série)"
  run_bg "$script"
  report "$script"
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
