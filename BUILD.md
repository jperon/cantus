# Construire Cantus

Le développement, les tests et l'APK passent par le flake Nix (`flake.nix`).
Il fournit Node, Chromium, JDK 17, Gradle et le SDK Android.

## Entrer dans l'environnement

```sh
nix develop            # shell de développement (ou `direnv allow` avec .envrc)
nix run .#build        # node build.js       → dist/
nix run .#build-spa    # node build.js --spa → dist/spa.html
nix run .#test         # tests unitaires + Playwright (Chromium du flake)
nix run .#serve        # npm run serve (http-server, HTTPS)
nix run .#apk          # scripts/build-apk.sh (voir ci-dessous)
```

Les applications se lancent depuis la racine du dépôt : elles ré-entrent dans
le devShell pour retrouver les variables d'environnement.

## Dépendances externes du build

`build.js` lit deux chemins hors du dépôt :

- `../partitura/verovio-toolkit-wasm.js` (symlink vers le paquet Verovio) ;
- `../musescore/result-wasm/classic`, surchargeable par `MSCZ2XML_PKG`.

Le flake positionne `MSCZ2XML_PKG` par défaut à
`$PWD/../musescore/result-wasm`. Le build reste utilisable si le paquet
mscz2xml est absent (avertissement, import MuseScore désactivé) ; en revanche
le toolkit Verovio est obligatoire.

Ces chemins ne sont pas des entrées Nix : `packages.default` est donc un
script de construction (`cantus-site-build`) qui opère dans le dépôt courant,
et **non** une dérivation hermétique du site. C'est volontaire : un build
sandboxé exigerait de figer Verovio et mscz2xml comme dépendances.

## Tests Playwright

`tests/lib.js` lance Chromium via `executablePath: process.env.CHROMIUM`. Le
`shellHook` exporte `CHROMIUM` (et `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`) vers
le Chromium de nixpkgs : aucun téléchargement de navigateur Playwright n'est
nécessaire, les tests fonctionnent hors ligne.

```sh
nix develop -c bash -lc 'tests/run.sh s1-import.js'
```

## APK Android (TWA Bubblewrap)

`apk/` est ignoré par git et contient le keystore de signature : il n'est
jamais exposé ni copié dans le store Nix. Un build sandboxé est donc
impossible ; `scripts/build-apk.sh` s'exécute dans le répertoire `apk/`
existant, depuis le devShell.

Prérequis réseau (build **non hermétique**) :

- `./gradlew` télécharge Gradle 8.11.1 (wrapper du projet) ;
- Gradle récupère AGP 8.9.1 et les dépendances Android (google/jcenter) ;
- si Bubblewrap est présent, il peut joindre le Web Manifest publié.

Versions : AGP 8.9.1 et `compileSdk 36` / `targetSdk 35` (lus dans
`apk/app/build.gradle`) ⇒ JDK 17 (fourni par le flake), Gradle 8.11.1 via le
wrapper (le flake fournit aussi Gradle 8.14.4).

Signature : le script utilise `bubblewrap build` s'il est installé, sinon il
reproduit ses étapes (`./gradlew assembleRelease`, `zipalign`, `apksigner`).
Le mot de passe du keystore se transmet par l'environnement, jamais en
argument :

```sh
export BUBBLEWRAP_KEYSTORE_PASSWORD='…'
# BUBBLEWRAP_KEY_PASSWORD si la clé a un mot de passe distinct
nix run .#apk
```

`startUrl` doit correspondre à l'URL publiée du Web Manifest. Bubblewrap
n'étant pas empaqueté dans nixpkgs, l'alternative est `npx @bubblewrap/cli
build` (téléchargement réseau).
