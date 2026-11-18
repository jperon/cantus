# TODO — Cantus

Reste à faire uniquement. Pour l'architecture et les décisions déjà prises, voir
`ROADMAP.md` et `BUILD.md`.

## Chantiers

### Import de tous les formats gérés par scoretk

- **Fait** : `.ly`, `.lilypond` et `.abc` sont acceptés, comme `.mscz`/`.mscx`,
  par la conversion scoretk du worker (`convertScoretk`, `from` déduit de
  l'extension) ; fixtures `.ly`/`.abc` et assertions dans `s1-import.js`.
  Manifeste PWA : types `text/x-lilypond`, `text/vnd.abc` et `text/plain`.
- **Reste** : `.mid`/`.midi`. Un `.mid` ne porte pas de notation ; la conversion
  produit une transcription. Le dire dans l'interface.
- **Attention** : le manifeste APK (`apk/twa-manifest.json`, non versionné) doit
  être régénéré pour reprendre les nouveaux types MIME.
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

### Résidus à examiner

- `/tmp/cantus-old` conserve des scripts `tests/probe-*.js` non suivis à
  examiner.
- `../cantus-wt-O-voix.js` : fichier égaré à côté du dépôt.

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
