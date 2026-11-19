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
| `langue.coffee` | Langue de l'interface : préférence, textes `data-i18n` et régénération des textes dynamiques. |
| `pages-lecture.coffee` | Pages SVG et données de lecture (midi, marqueurs, pauses). |
| `transport-suivi.coffee` | Transport audio et suivi du défilement pendant la lecture. |
| `reglages-voix.coffee` | Réglages persistants, voix masquées (rendu) ou coupées (lecture), tailles, variantes de cache. |
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

## Internationalisation (`src/i18n.coffee` et `src/i18n/`)

L'interface est en anglais par défaut et traduite à l'exécution. `src/i18n.coffee`
suit le patron de `src/formats.coffee` : api exposée sur `window.__musicaI18n`
(page) et `module.exports` (build.js et tests Node). Le build concatène le
module puis un dictionnaire par langue (`I18N_SOURCES`) et l'injecte en
`i18n.js` avant l'application dans les deux pages.

- `t(key, params)` renvoie le texte traduit, `{nom}` remplacé par `params.nom`.
  Un paramètre absent laisse `{nom}` tel quel.
- Pluriel : avec `params.count`, la clé `x` est cherchée en `x_one` / `x_other`
  selon `Intl.PluralRules` de la langue courante. Les dictionnaires ne
  contiennent que les formes utiles (par exemple `library.fileCount_one` et
  `library.fileCount_other`).
- `language()`, `setLanguage(code)` (met à jour `<html lang>`), `languages()`
  (liste dérivée des dictionnaires présents) et `registerLanguage(code, nom,
  messages)`.
- **L'anglais (`src/i18n/en.coffee`) est la référence** : il contient toutes les
  clés. Une clé absente d'une autre langue est lue en anglais ; une clé absente
  de l'anglais produit une erreur en console et la clé est affichée.
  `tests/unit/i18n.test.js` impose les mêmes clés et les mêmes `{paramètres}`
  dans toutes les langues.

### Ajouter ou modifier un texte

1. ajouter la clé dans `src/i18n/en.coffee` (référence) ;
2. ajouter la même clé, avec les mêmes `{paramètres}`, dans chaque autre
   dictionnaire (`src/i18n/fr.coffee` aujourd'hui) ;
3. dans le HTML, poser `data-i18n="clé"` (texte), `data-i18n-title`,
   `data-i18n-aria-label`, `data-i18n-placeholder` ou `data-i18n-content`
   (attribut `content` d'une balise `meta`). Le texte source reste l'anglais ;
4. dans le code, appeler `t "clé", {paramètres}` — jamais de texte visible en
   dur. `src/app/langue.coffee` applique les attributs `data-i18n*` au
   chargement et à chaque changement de langue, puis régénère les textes
   produits par le code (date de build, transport, réglages ouverts,
   bibliothèque ouverte).

Les messages de console de développement et les erreurs internes ne sont pas
traduits. Le manifeste et la page d'erreur du service worker (hors
application, sans accès aux dictionnaires) restent en anglais.

### Ajouter une langue

Créer `src/i18n/<code>.coffee` sur le modèle de `fr.coffee` :

```coffee
registerLanguage 'es', 'Español',
  'app.title': '…'
  # … toutes les clés de en.coffee
```

puis ajouter le fichier à `I18N_SOURCES` dans `build.js`, après `en.coffee`.
Le sélecteur « Langue / Language » des réglages est alimenté par
`languages()` : aucune autre modification n'est nécessaire. Une langue sans
dictionnaire n'apparaît pas dans la liste.

### Choix de la langue

`src/app/langue.coffee` applique, dans cet ordre : la préférence enregistrée
dans `localStorage` (`musica-language`), la première langue de
`navigator.languages` qui a un dictionnaire, puis l'anglais. Le changement est
appliqué à chaud, sans rechargement.

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
marqueurs de synchronisation, tempo initial du fichier) utilisées telles
quelles par le worker et par
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
`tempo[i].tick`, `timeUs`, `microsPerQuarter` ; `measures[i].measure`/`ordinal`,
`segment`, `tick`, `endTick`, `timeUs`, `endTimeUs`, `xmlId` (optionnel) ;
`pauses[i].tick`, `endTick`, `timeUs`, `endTimeUs`, `seconds`.

Il n'existe **ni `pauseBefore`**, ni `ticksPerQuarter`, ni `durationTicks` ou
`durationUs` à la racine, ni de durée par mesure. La durée totale se dérive de
`measures[dernier].endTimeUs` (repli sur `ticks` converti par la carte de
tempo si `measures` est vide). Les pauses sont détectées par **coïncidence**
entre `pause.tick` et la fin (`endTick`) d'une mesure ; la position dans
`measures[]` et `segment` font foi, `passage` n'est pas un discriminant, et
`ordinal` ne se distingue jamais de `measure` (identique sur toutes les
fixtures versionnées, dans `tests/fixtures/scoretk/` ; provenance et
normalisation dans son `README.md`).

### Tempo de lecture

Le réglage **Tempo** est propre au fichier, comme les voix : il est stocké
dans `localStorage` sous `musica-tempo-<fileId>` (clé absente = tempo du
fichier), dans l'**unité de battue** affichée. La valeur est un entier 20–300
dans cette unité ; le symbole (♩, 𝅗𝅥, ♩., ♪…) est affiché à côté du champ. Il
est appliqué par `src/app/transport-suivi.coffee`. Aucune compatibilité n'est
assurée avec d'anciennes valeurs stockées en noires/minute : une valeur
existante est interprétée dans l'unité courante.

L'unité est donnée par la fonction pure
`timeline.tempoUnitFromXml(xml) -> {unit, quarterRatio}`, où `quarterRatio`
est la valeur de l'unité en noires (blanche 2, noire pointée 1,5, croche
0,5…), dans cet ordre :

1. l'indication métronomique de la **première mesure** du MusicXML converti
   (`<metronome><beat-unit>` et `<beat-unit-dot/>`), comme
   `xmlInitialTempoMark` ;
2. sinon la métrique de la première mesure
   (`<time><beats>/<beat-type>`), par la règle simple : beat-type 2 (2/2, 3/2,
   4/2…) → blanche ; métrique composée (`beats % 3 == 0`, `beats > 3`,
   beat-type 8 ou 16) → valeur pointée de 3 beat-type (6/8, 9/8, 12/8 →
   noire pointée ; /16 → croche pointée) ; sinon noire ;
3. sans XML exploitable, noire.

D'où vient le défaut :

- scoretk insère **toujours** un tempo à `tick 0` dans `timeline.tempo`. Sans
  indication dans la partition, c'est 500 000 µs/noire, soit **120 BPM**.
- `timeline.fileTempoInfo(timeline, xml)` donne ce tempo initial **converti
  dans l'unité** (`bpm = noires/minute / quarterRatio`, arrondi à l'entier),
  l'unité et son caractère explicite. Une valeur différente de 120 noires/minute
  est forcément une indication réelle. Un `120` explicite est indistinguable
  par la seule valeur : le MusicXML converti est alors consulté, car une
  indication réelle produit `<sound tempo="…">` ou un `<metronome>` dans la
  **première mesure** (scoretk réexporte le tempo en `<sound>`).
- `timeline.defaultPlaybackTempo(info)` renvoie le tempo du fichier s'il est
  explicite, sinon **80 dans l'unité** (80 à la noire pointée en 6/8). Le
  bouton « Tempo du fichier » (ou un champ vidé) supprime le réglage et revient
  à ce défaut.

Le facteur vaut `tempo choisi / tempo initial du fichier`, **dans la même
unité** : le rapport des unités s'annule, et changer d'unité ne change pas la
vitesse pour un même tempo musical. Il est appliqué **une seule fois**, par
`audio.scalePlaybackData` : un facteur 2 (deux fois plus vite)
**divise** les temps de lecture par 2. Durée, marqueurs de synchronisation et
pauses passent à l'échelle avant `engine.load()` et alimentent le même axe de
temps pour le transport et le suivi. Le MIDI n'est pas réécrit et les segments
restent en temps source (`from`/`to` sont des positions du flux, indépendantes
du tempo) : `scalePlaybackData` transmet le facteur, puis
`normalizePlaybackData` divise une seule fois les débuts et durées des notes
remappées. Les changements de tempo internes du morceau sont donc conservés
proportionnellement.

Les données brutes du worker restent dans `playbackCache` (clé mémoire) et dans
le cache persistant (`musica-playback-cache-v5`, tempo et unité compris) :
changer le tempo ne les invalide pas et ne touche jamais le cache SVG. Pendant
la lecture,
un changement relance le moteur à la même position musicale
(`position × ancien facteur / nouveau facteur`) ; le suivi reprend sans
re-rendu.

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
