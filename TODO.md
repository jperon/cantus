# TODO — Cantus

Reste à faire uniquement. Pour l'architecture et les décisions déjà prises, voir
`ROADMAP.md` et `BUILD.md`.

## Chantiers

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
