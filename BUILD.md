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
- `../musescore/result/classic`, surchargeable par `SCORETK_PKG`.

Le flake positionne `SCORETK_PKG` par défaut à `$PWD/../musescore/result`.
Le build reste utilisable si le paquet scoretk est absent (avertissement,
imports MuseScore, LilyPond, ABC et MIDI désactivés) ; en revanche le toolkit
Verovio est obligatoire.
Le paquet est copié dans `dist/scoretk/` (wrapper, glue et `.wasm`) ; le SPA
inline le glue et le `.wasm` en base64 dans `spa.html`.

Ces chemins ne sont pas des entrées Nix : `packages.default` est donc un
script de construction (`cantus-site-build`) qui opère dans le dépôt courant,
et **non** une dérivation hermétique du site. C'est volontaire : un build
sandboxé exigerait de figer Verovio et scoretk comme dépendances.

## Découpage de l'application principale (`src/app/`)

L'application de la page est répartie dans `src/app/*.coffee`. `build.js`
concatène ces fichiers dans l'ordre de la liste `APP_SOURCES` (déclarée en dur
dans `build.js`) puis compile le résultat en un seul programme CoffeeScript
(`bare: true`), comme avant le découpage (un seul fichier). Il n'y a ni
module, ni export, ni frontière de fichier : la portée globale unique et les
instructions exécutées au chargement sont conservées.

| Fichier | Contenu |
| --- | --- |
| `demarrage.coffee` | Date de build, installation PWA, service worker. |
| `etat.coffee` | État global partagé et répartiteur des messages du worker. |
| `pages-lecture.coffee` | Pages SVG et données de lecture (midi, marqueurs, pauses). |
| `transport-suivi.coffee` | Transport audio et suivi du défilement pendant la lecture. |
| `reglages-voix.coffee` | Réglages persistants, voix masquées, tailles, variantes de cache. |
| `affichage-navigation.coffee` | Affichage des pages, préchargement, défilement, navigation. |
| `decoupage-xml.coffee` | Découpage MusicXML en mouvements, masquage et tailles des voix. |
| `sources.coffee` | Conversion scoretk et chargement séquentiel des sources/mouvements. |
| `bibliotheque-import.coffee` | Bibliothèque, navigation tactile, import de fichiers/dossiers. |
| `reglages-ui.coffee` | Panneau de réglages (liste des voix, contrôles). |
| `integration.coffee` | Stockage et quota, protocole, URL, partage, messages d'erreur. |
| `init.coffee` | Câblage des modules au `DOMContentLoaded`. |

**Règle d'ordre** : l'ordre de `APP_SOURCES` est significatif. Il suit celui du
monolithe d'origine — état global et écouteurs posés au chargement d'abord,
puis les définitions, et `init.coffee` en dernier. Une nouvelle définition va
dans le fichier thématique correspondant ; un nouveau fichier s'insère dans
`APP_SOURCES` à sa place dans l'ordre du chargement. Ne jamais déplacer une
instruction exécutée au chargement (`addEventListener`, appels,
initialisations d'état) par rapport aux autres : seule la découpe en fichiers
change, pas l'ordre d'exécution.

## Formats importables (`src/formats.coffee`)

`src/formats.coffee` est la **source unique** des formats importables :
extensions, format d'entrée scoretk (`from`), types MIME et listes `accept`.
Il suit le patron de `src/timeline.coffee` : api exposée sur
`window.__musicaFormats` (page), `self.__musicaFormats` (worker) et
`module.exports` (build.js et tests Node). Le build l'injecte en `formats.js`
avant `timeline.js` et avant le worker, et avant l'application dans les deux
pages.

- `FORMATS` : une entrée par format (`extensions`, `scoretk`, `from`, `share`).
  **Ajouter un format importable se fait ici**, plus ses types MIME dans
  `MIME_TYPES` s'il en a : `SCORETK_EXTENSIONS`, `SCORETK_EXT_RE`,
  `IMPORT_EXTENSIONS` (application) et `scoretkFrom` (worker) en sont dérivés.
- `MIME_TYPES` : type MIME → extensions acceptées, extension de repli quand le
  nom d'un fichier partagé est perdu, et présence dans `file_handlers`. L'ordre
  de la table fixe celui de `file_handlers` ; `share_target` reprend tous ces
  types.

`build.js` en dérive l'attribut `accept` des champs de fichier,
`dist/manifest.json` et deux valeurs injectées dans `dist/sw.js` :

- **`dist/manifest.json` est régénéré** : les listes `accept` de
  `pwa/manifest.json` sont des emplacements vides (`{}` et `[]`) ; le dist
  reçoit exclusivement celles de `src/formats.coffee`, le reste du manifeste
  (nom, icônes, actions…) étant recopié tel quel. Ne pas éditer ces `accept`
  dans `pwa/manifest.json`.
- dans `dist/sw.js`, `MIME_EXTENSIONS` (repli MIME → extension) et
  `SHARE_EXT_RE` (extensions retirées pour nommer une entrée partagée) sont
  injectés par remplacement de marqueur, comme `PRESERVED_CACHES` : le build
  échoue si le marqueur a disparu.

Les tests unitaires (`tests/unit/scoretk-from.test.js`) vérifient `scoretkFrom`
et la cohérence des tables (chaque extension scoretk a un `from`, chaque type
MIME pointe vers une extension connue).

## Aperçu audio et synchronisation (scoretk)

Verovio ne fournit **plus** le MIDI ni les temps de lecture : il ne sert qu'au
rendu SVG et, via `renderToTimemap({includeMeasures: true})`, au pont « mesure
écrite -> page » (seul usage de cette fonction, dans `worker.coffee`). Le MIDI
et la timeline viennent de `scoretk.convertWithTimeline`, appelé dans le worker
sur le **MusicXML source complet** (pas le mouvement élagué) : le MIDI est
global au fichier, et un mouvement élagué ferait disparaître les voix masquées
du mapping (elles redeviendraient audibles sur le master).

`src/timeline.coffee` est injecté dans le worker avant `worker.coffee` (build
normal et SPA) et dans la page (`timelineJs`). Il fournit les manipulations
pures de la timeline (slices de mouvement, segments de lecture, pauses,
marqueurs de synchronisation) utilisées telles quelles par le worker et par
`src/app/*.coffee`. Le remappage des notes sur les segments reste dans
`audio.coffee` (`remapNotesToSegments`), désormais seul chemin.

`timeline.ticks` est le dernier tick, **pauses comprises** ; la durée vient de
`measures[dernier].endTimeUs`. `measures[]` ne contient que les mesures jouées,
dans l'ordre d'exécution : ne jamais indexer par `measure`. `passage` n'est pas
un discriminant d'occurrence ; la position dans `measures[]` (et `segment`) fait
foi. Le MusicXML renvoyé par scoretk est identique dans les deux modes : la
pagination Verovio ne change pas quand on coche ou décoche les reprises.

Champs **réellement produits par scoretk-wasm 0.1.0**, et seuls consommés :
`timeline.division`, `ticks`, `tempo`, `measures`, `pauses` ;
`measures[i].measure`/`ordinal`, `segment`, `tick`, `endTick`, `timeUs`,
`endTimeUs`, `xmlId` (optionnel) ; `pauses[i].tick`, `endTick`, `timeUs`,
`endTimeUs`, `seconds`.

Il n'existe **ni `pauseBefore`**, ni `ticksPerQuarter`, ni `durationTicks` ou
`durationUs` à la racine, ni de durée par mesure. La durée totale se dérive de
`measures[dernier].endTimeUs` (repli sur `ticks` converti par la carte de
tempo si `measures` est vide). Les pauses sont détectées par **coïncidence**
entre `pause.tick` et la fin (`endTick`) d'une mesure ; la position dans
`measures[]` et `segment` font foi, `passage` n'est pas un discriminant, et
`ordinal` ne se distingue jamais de `measure` (identique sur toutes les
fixtures versionnées, dans `tests/fixtures/scoretk/` ; provenance et
normalisation dans son `README.md`).

### Limites connues de scoretk

- Fermatas et respirations non modélisées : la timeline les ignore.
- Trémolo à deux accords : seule la première note pilote les deux attaques
  (parité MuseScore).

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
argument ; `BUBBLEWRAP_*` (convention Bubblewrap) et `CANTUS_*` sont
équivalents :

```sh
export BUBBLEWRAP_KEYSTORE_PASSWORD='…'   # ou CANTUS_KEYSTORE_PASSWORD
# BUBBLEWRAP_KEY_PASSWORD (ou CANTUS_KEY_PASSWORD) si la clé a un mot de passe
# distinct ; inutile pour un PKCS12 où les deux sont identiques
nix run .#apk
```

Un keystore non protégé (mot de passe vide) est accepté : le script le
détecte silencieusement. Sinon, sans terminal et sans mot de passe, il s'arrête
avec un message explicite plutôt qu'une pile Java. Après signature, il affiche
le DN et l'empreinte SHA-256 du certificat : à comparer avec l'APK déjà
installé pour vérifier que la mise à jour garde la même identité de signature.

`startUrl` doit correspondre à l'URL publiée du Web Manifest. Bubblewrap
n'étant pas empaqueté dans nixpkgs, l'alternative est `npx @bubblewrap/cli
build` (téléchargement réseau).
