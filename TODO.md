# TODO — Cantus

Reste à faire uniquement. Pour l'architecture et les décisions déjà prises, voir
`ROADMAP.md` et `BUILD.md`.

## Chantiers

### Import de tous les formats gérés par scoretk

- **Objectif** : accepter `.ly`, `.lilypond`, `.abc`, `.mid`/`.midi` en plus de
  `.musicxml`, `.mxl`, `.mscz`, `.mscx`. scoretk gère `ly`, `lilypond`, `abc`,
  `mid`, `midi`.
- **Piste** : ajouter les extensions à `IMPORT_EXTENSIONS` (`src/app.coffee`) et
  à `IMPORT_EXTENSIONS_SCORETK` (`build.js`), puis mettre à jour le
  `share_target` de `pwa/manifest.json` et `apk/twa-manifest.json`.
- **Attention** : un `.mid` ne porte pas de notation ; la conversion produit une
  transcription. Le dire dans l'interface.
- **Dette** : la liste des extensions reste en double dans `app.coffee` et
  `build.js`.

### Export vers tous les formats

- **Objectif** : exporter au format choisi via `formats()` de scoretk, sans coder
  la liste en dur.
- **Questions ouvertes** : emplacement de l'entrée d'export (réglages ou
  bibliothèque) ; fichier téléchargeable ou partage Android.

### Installation/distribution Android

- **`apk/twa-manifest.json`** doit être régénéré quand le manifeste web change
  (types MIME du partage).
- L'APK n'est pas versionné (`apk/` est ignoré) et la signature dépend de
  `~/.config/cantus/apk.env` et des variables `BUBBLEWRAP_*`/`CANTUS_*`.

## Dette technique

### Tests unitaires contre des contrats imaginaires

- Deux cas rencontrés : `pauseBefore`, puis `from`/`to`/`offset`.
- **Règle** : tester les modules contre les fixtures réelles du paquet
  (`tests/fixtures/scoretk/`), jamais contre des objets écrits à la main.

### Champs annoncés absents

- scoretk ne fournit ni `durationUs`, ni `pauseBefore`, ni `ordinal` distinct de
  `measure` ; `passage` n'est pas un discriminant d'occurrence.
- Ces conventions sont documentées dans `BUILD.md` (section « Aperçu audio et
  synchronisation ») : vérifier qu'elles y restent à chaque évolution de scoretk.

### Limites assumées de scoretk

- Fermatas et respirations non modélisées.
- Trémolo à deux accords : seule la première note pilote les deux attaques
  (parité MuseScore).

### `src/app.coffee` monolithique

- ~3200 lignes : extraire progressivement import/fichiers, lecture/suivi,
  bibliothèque, comme l'ont déjà fait `timeline` et `playbackCache`.

### `s6-audio`

- Attentes de 60 à 120 s qui s'additionnent ; le découper en scénarios plus
  courts.

### Branches à trancher

- Branche locale `mscz` : 5 commits sur l'ancien `mscz2xml`, a priori remplacés
  par scoretk.
- Branches distantes `origin/dossier`, `origin/fix-boucle-lecture2`,
  `origin/midi`, `origin/perf`, `origin/seek-page` : toutes fusionnées, à
  supprimer sur `origin`.
- `/tmp/cantus-old` conserve des scripts `tests/probe-*.js` non suivis à
  examiner.

## Industrialisation

### Flake Nix non hermétique

- Le build du site lit `../partitura` et `../musescore/result` hors dépôt
  (`BUILD.md`, « Dépendances externes du build »).
- **Piste** : dériver `verovio-toolkit-wasm.js` et le paquet scoretk comme
  entrées Nix.

### Données de test hors dépôt

- Les données de test vivent hors dépôt dans `$CANTUS_TEST_DATA` (défaut
  `~/.local/share/cantus/test-data`, voir `tests/README.md`).
- `La_foule.mxl` est ignoré par git et lu à la racine du dépôt.

## Vérifications de référence

Campagne : `nix develop -c bash -lc 'tests/run.sh'` (s1→s9 + unitaires) ; le harnais échoue si une assertion échoue.
- Si `TMPDIR` est un chemin long (scratchpad d'agent), Chromium échoue (« Socket path too long ») : lancer avec `TMPDIR=$(mktemp -d /tmp/ct.XXXX)`.
