#!/usr/bin/env bash
# Construit et signe l'APK de la TWA Cantus (projet Bubblewrap dans apk/).
#
# PRÉREQUIS RÉSEAU : cette construction n'est PAS hermétique.
#   - `./gradlew` télécharge la distribution Gradle 8.11.1 (gradle-wrapper.properties) ;
#   - Gradle récupère AGP 8.9.1 et les dépendances Android depuis google()/jcenter() ;
#   - Bubblewrap, s'il est utilisé, peut aussi joindre le Web Manifest publié.
# Le keystore (apk/android.keystore) n'est jamais affiché ni copié : il ne sert
# qu'à signer. `apk/` est ignoré par git, donc aucun build Nix sandboxé n'est tenté.
#
# Variables optionnelles (sinon apksigner demande le mot de passe sur le terminal) :
#   BUBBLEWRAP_KEYSTORE_PASSWORD, BUBBLEWRAP_KEY_PASSWORD
#
# Usage : bash scripts/build-apk.sh   (depuis un `nix develop`)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APK_DIR="$ROOT/apk"
MANIFEST="$APK_DIR/twa-manifest.json"
KEYSTORE="$APK_DIR/android.keystore"

die() { echo "build-apk : $*" >&2; exit 1; }

[ -f "$MANIFEST" ] || die "apk/twa-manifest.json absent (apk/ est ignoré par git ; le reconstruire avec Bubblewrap)"
[ -f "$KEYSTORE" ] || die "keystore absent : apk/android.keystore (secret de signature, non versionné)"
[ -x "$KEYSTORE" ] || [ -r "$KEYSTORE" ] || die "keystore illisible : apk/android.keystore"

for tool in java gradle adb node; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool introuvable : lancer via 'nix develop'"
done
[ -n "${ANDROID_HOME:-}" ] || die "ANDROID_HOME non défini : lancer via 'nix develop'"

BUILD_TOOLS=$(find -L "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -n1 || true)
[ -n "$BUILD_TOOLS" ] && [ -x "$BUILD_TOOLS/apksigner" ] && [ -x "$BUILD_TOOLS/zipalign" ] \
  || die "build-tools Android incomplets sous $ANDROID_HOME/build-tools"

# Lecture du manifeste sans exposer le keystore. Le script node est entre
# quotes simples : les ${...} sont du JavaScript, pas du shell.
# shellcheck disable=SC2016
read -r ALIAS START_URL < <(node -e '
  const m = require(process.argv[1]);
  process.stdout.write(`${m.signingKey?.alias || "android"} ${m.startUrl || "/"}\n`);
' "$MANIFEST")
[ -n "${ALIAS:-}" ] || die "alias de signature illisible dans twa-manifest.json"

echo "== TWA Cantus =="
echo "  startUrl  : $START_URL"
echo "  keystore  : présent (non affiché)"
echo "  Rappel : startUrl doit correspondre à l'URL publiée du Web Manifest."
echo "  JDK : $(java -version 2>&1 | head -n1)"

cd "$APK_DIR"

# Bubblewrap officiel s'il est disponible (il gère version, alignement et
# signature) ; sinon on reproduit ses étapes avec les outils du SDK Android.
if command -v bubblewrap >/dev/null 2>&1; then
  echo "== bubblewrap build =="
  bubblewrap build
  exit 0
fi

echo "== bubblewrap introuvable : gradle + zipalign + apksigner =="
echo "   (alternative : npx @bubblewrap/cli build, qui télécharge Bubblewrap)"

# GRADLE_USER_HOME est inscriptible grâce au shellHook du flake.
./gradlew --no-daemon assembleRelease

UNSIGNED="$APK_DIR/app/build/outputs/apk/release/app-release-unsigned.apk"
ALIGNED="$APK_DIR/app-release-unsigned-aligned.apk"
SIGNED="$APK_DIR/app-release-signed.apk"

[ -f "$UNSIGNED" ] || die "APK non signé introuvable : $UNSIGNED"

"$BUILD_TOOLS/zipalign" -p -f 4 "$UNSIGNED" "$ALIGNED"

# Sans terminal interactif, apksigner ne peut pas demander le mot de passe :
# échouer tôt avec une consigne claire plutôt qu'une pile Java.
if [ ! -t 0 ] && [ -z "${BUBBLEWRAP_KEYSTORE_PASSWORD:-}" ]; then
  die "keystore protégé : exporter BUBBLEWRAP_KEYSTORE_PASSWORD (et BUBBLEWRAP_KEY_PASSWORD si distinct) pour signer sans terminal"
fi

SIGN_ARGS=(sign --ks "$KEYSTORE" --ks-key-alias "$ALIAS" --out "$SIGNED")
# Les mots de passe ne transitent que par l'environnement, jamais en argument.
[ -n "${BUBBLEWRAP_KEYSTORE_PASSWORD:-}" ] && SIGN_ARGS+=(--ks-pass env:BUBBLEWRAP_KEYSTORE_PASSWORD)
[ -n "${BUBBLEWRAP_KEY_PASSWORD:-}" ] && SIGN_ARGS+=(--key-pass env:BUBBLEWRAP_KEY_PASSWORD)

"$BUILD_TOOLS/apksigner" "${SIGN_ARGS[@]}" "$ALIGNED"
"$BUILD_TOOLS/apksigner" verify "$SIGNED"

echo "== APK signé : $SIGNED =="
